const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, createOrigin, deferred } = require("./helpers/app.cjs");
const { startLogin, callback, tokenResponse, holdAuthLock, waitFor, settlePeers } = require("./helpers/auth.cjs");
const { getSql, fixture, ids } = require("./helpers/database.cjs");

test("failed logout export preserves storage and never offers saved-export confirmation", async t => {
  const app = createApp();
  t.after(app.close);
  app.window.testExport = async () => { throw new Error("Synthetic export failure"); };
  app.run("db = {}; exportWorkingDatabase = window.testExport; getWorkingDatabaseRevision = () => 1");
  app.window.localStorage.setItem("s9000.pending", "synthetic-edits");
  app.run("openLogout()");
  await app.run("prepareLogoutExport()");
  assert.equal(app.window.localStorage.getItem("s9000.pending"), "synthetic-edits");
  assert.ok(app.window.document.getElementById("btn-logout-saved").classList.contains("hidden"));
  assert.match(app.window.document.getElementById("logout-status").textContent, /not been erased/);
});

test("canceling during export prevents a late download or erase", async t => {
  const app = createApp();
  t.after(app.close);
  const task = deferred();
  let downloads = 0;
  app.window.testExport = () => task.promise;
  app.window.testDownload = () => { downloads++; };
  app.run("db = {}; exportWorkingDatabase = window.testExport; getWorkingDatabaseRevision = () => 1; triggerDownload = window.testDownload");
  app.run("openLogout()");
  const exported = app.run("prepareLogoutExport()");
  app.run("setDialogOpen('logout-modal', false)");
  task.resolve(new Uint8Array([1, 2, 3]));
  await exported;
  assert.equal(downloads, 0);
  assert.equal(app.run("erasingBrowser"), false);
});

test("download initiation alone does not erase and later edits invalidate acknowledgement", async t => {
  const app = createApp();
  t.after(app.close);
  let revision = 1;
  let erases = 0;
  app.window.testRevision = () => revision;
  app.window.testExport = async () => new Uint8Array([1, 2, 3]);
  app.window.testErase = async () => { erases++; };
  app.run("db = {}; exportWorkingDatabase = window.testExport; getWorkingDatabaseRevision = window.testRevision; triggerDownload = () => {}; eraseBrowserData = window.testErase");
  app.run("openLogout()");
  await app.run("prepareLogoutExport()");
  assert.equal(erases, 0);
  revision++;
  await app.run("confirmExportedLogout()");
  assert.equal(erases, 0);
  assert.match(app.window.document.getElementById("logout-status").textContent, /changed since export/);
});

async function storedApp(t, origin, restore = false) {
  const app = createApp({ origin });
  t.after(app.close);
  app.window.testSQL = await getSql();
  app.run("SQL = window.testSQL; triggerDownload = () => {}");
  if (restore) await app.run("restoreCachedDatabase()");
  else {
    app.window.testFixture = fixture(app.window.testSQL);
    await app.run("loadDbFromBytes(window.testFixture)");
    app.run(`setCellColor('${ids.firstPlayback}', 2)`);
    await app.run("databaseQueue");
  }
  return app;
}

test("only the explicit coordinator purges shared data; peers release blocking IDB before waiting on its lock", { timeout: 5000 }, async t => {
  const origin = createOrigin({ autoEvents: false });
  const app = await storedApp(t, origin);
  const peer = await storedApp(t, origin, true);
  await startLogin(app);
  await startLogin(peer, "synthetic-peer-client");
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
  app.window.localStorage.setItem("s9000.volume", "35");
  app.window.localStorage.setItem("unrelated-app-key", "keep");
  app.window.sessionStorage.setItem("s9000.other-tab-state", "synthetic-owned");
  app.window.sessionStorage.setItem("unrelated-session-key", "keep");
  peer.window.sessionStorage.setItem("s9000.other-tab-state", "synthetic-owned");
  peer.window.sessionStorage.setItem("unrelated-session-key", "keep");
  const connection = await peer.run("idbOpen()");
  connection.onversionchange = () => {};
  let closed = false;
  const close = connection.close.bind(connection);
  connection.close = () => { closed = true; close(); };
  let peerWaitedAfterClose = false;
  peer.window.navigator.locks = {
    request(name, options, callback) {
      peerWaitedAfterClose ||= closed;
      assert.equal(closed, true);
      return origin.locks.request(name, options, callback);
    },
  };
  let peerSharedDeletes = 0;
  const peerRemove = peer.window.localStorage.removeItem.bind(peer.window.localStorage);
  peer.window.localStorage.removeItem = key => { peerSharedDeletes++; return peerRemove(key); };
  const blocked = deferred();
  let deletes = 0;
  const removeDatabase = origin.indexedDB.deleteDatabase.bind(origin.indexedDB);
  origin.indexedDB.deleteDatabase = name => {
    deletes++;
    const request = removeDatabase(name);
    request.addEventListener("blocked", () => blocked.resolve());
    return request;
  };
  const erasing = app.run("eraseBrowserData()");
  await blocked.promise;
  assert.equal(origin.locks.isHeld(app.run("AUTH_LOCK_NAME")), true);
  assert.ok(app.window.localStorage.getItem("s9000.erase"));
  try {
    await assert.rejects(peer.run("beginSpotifyLogin('synthetic-after-cleanup-client')"), /cleanup|busy/);
  } finally {
    origin.flushEvents();
  }
  assert.equal(await erasing, true);
  await settlePeers(origin, app, peer);
  assert.equal(peerWaitedAfterClose, true);
  assert.equal(deletes, 1);
  assert.equal(peerSharedDeletes, 0);
  assert.equal(app.run("db"), null);
  assert.equal(peer.run("db"), null);
  assert.equal(peer.run("nowPlaying"), null);
  assert.equal(peer.run("pendingCount()"), 0);
  assert.deepEqual(Object.keys(app.window.localStorage).filter(key => key.startsWith("s9000.")), []);
  for (const current of [app, peer]) {
    assert.equal(current.window.sessionStorage.getItem("s9000.pkce"), null);
    assert.equal(current.window.sessionStorage.getItem("s9000.other-tab-state"), null);
    assert.equal(current.window.sessionStorage.getItem("unrelated-session-key"), "keep");
  }
  assert.equal(app.window.localStorage.getItem("unrelated-app-key"), "keep");
  assert.equal((await origin.indexedDB.databases()).some(item => item.name === "s9000"), false);
  assert.match(peer.window.document.getElementById("auth-status").textContent, /browser data was erased/);
});

test("delayed and duplicate erase notifications preserve a fresh post-logout sign-in, library and edits", async t => {
  const origin = createOrigin({ autoEvents: false });
  const oldTab = await storedApp(t, origin);
  const eraser = createApp({ origin });
  t.after(eraser.close);
  const oldAttempt = await startLogin(oldTab);
  let oldSignal = null;
  const eraseSet = eraser.window.localStorage.setItem.bind(eraser.window.localStorage);
  eraser.window.localStorage.setItem = (key, value) => {
    if (key === "s9000.erase") oldSignal = value;
    eraseSet(key, value);
  };
  assert.equal(await eraser.run("eraseBrowserData()"), true);
  const app = createApp({ origin });
  t.after(app.close);
  app.window.testSQL = await getSql();
  app.run("SQL = window.testSQL; triggerDownload = () => {}");
  const fresh = await startLogin(app, "synthetic-new-client");
  app.window.fetch = async () => tokenResponse();
  assert.equal(await callback(app, fresh), "ok");
  app.window.confirm = () => true;
  app.window.testFixture = fixture(app.window.testSQL, "Synthetic new library");
  await app.run("loadDbFromBytes(window.testFixture)");
  app.run(`setCellColor('${ids.firstPlayback}', 4)`);
  await app.run("databaseQueue");
  app.window.localStorage.setItem("s9000.volume", "45");
  const saved = app.window.localStorage.getItem("s9000.auth");
  const revision = app.run("getWorkingDatabaseRevision()");
  const record = await app.run("idbGet(IDB_KEY)");
  app.window.oldAttempt = oldAttempt;
  await app.run("withAuthLock(() => discardLoginAttempt(window.oldAttempt.pkce, window.oldAttempt.raw))");
  await settlePeers(origin, app, oldTab, eraser);
  await app.run(`reconcilePeerErase(${JSON.stringify(oldSignal)})`);
  await app.run(`reconcilePeerErase(${JSON.stringify(oldSignal)})`);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
  assert.equal(app.window.localStorage.getItem("s9000.volume"), "45");
  assert.equal(app.run("accessToken"), "synthetic-access");
  assert.equal(app.run("getWorkingDatabaseRevision()"), revision);
  assert.equal(app.run(`pending.colors['${ids.firstPlayback}']`), 4);
  assert.equal((await app.run("idbGet(IDB_KEY)")).version, record.version);
  assert.equal(app.run("queryAll('SELECT title FROM Sound LIMIT 1')[0].title"), "Synthetic new library");
});

test("old cleanup and delayed peer events cannot delete a newer pending registration", async t => {
  const origin = createOrigin({ autoEvents: false });
  const app = createApp({ origin });
  const eraser = createApp({ origin });
  t.after(app.close); t.after(eraser.close);
  const oldAttempt = await startLogin(app);
  assert.equal(await eraser.run("eraseBrowserData()"), true);
  const fresh = await startLogin(app);
  const registration = app.window.localStorage.getItem(fresh.key);
  app.window.oldAttempt = oldAttempt;
  await app.run("withAuthLock(() => discardLoginAttempt(window.oldAttempt.pkce, window.oldAttempt.raw))");
  await settlePeers(origin, app, eraser);
  assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), fresh.raw);
  assert.equal(app.window.localStorage.getItem(fresh.key), registration);
  app.window.fetch = async () => tokenResponse();
  assert.equal(await callback(app, fresh), "ok");
});

test("an old in-flight callback's finally cannot remove a replacement login", async t => {
  const origin = createOrigin({ autoEvents: false });
  const app = createApp({ origin });
  const eraser = createApp({ origin });
  t.after(app.close); t.after(eraser.close);
  const oldAttempt = await startLogin(app);
  const response = deferred();
  const entered = deferred();
  app.window.fetch = () => { entered.resolve(); return response.promise; };
  const oldCallback = callback(app, oldAttempt);
  await entered.promise;
  assert.equal(await eraser.run("eraseBrowserData()"), true);
  const fresh = await startLogin(app);
  response.resolve(tokenResponse());
  assert.equal(await oldCallback, "error");
  assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), fresh.raw);
  assert.ok(app.window.localStorage.getItem(fresh.key));
  app.window.fetch = async () => tokenResponse();
  assert.equal(await callback(app, fresh), "ok");
});

test("ordinary cross-tab auth changes never reset the loaded database, edits or settings", async t => {
  const origin = createOrigin();
  const app = await storedApp(t, origin);
  const peer = createApp({ origin });
  t.after(peer.close);
  const attempt = await startLogin(app);
  const revision = app.run("getWorkingDatabaseRevision()");
  app.window.localStorage.setItem("s9000.volume", "35");
  for (const saved of [
    { clientId: "synthetic-client", refreshToken: "synthetic-first" },
    { clientId: "synthetic-client", refreshToken: "synthetic-second" },
    null,
  ]) {
    if (saved) peer.window.localStorage.setItem("s9000.auth", JSON.stringify(saved));
    else peer.window.localStorage.removeItem("s9000.auth");
    await settlePeers(origin, app, peer);
    assert.equal(app.run("getWorkingDatabaseRevision()"), revision);
    assert.equal(app.run(`pending.colors['${ids.firstPlayback}']`), 2);
    assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
    assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), attempt.raw);
    assert.ok(app.window.localStorage.getItem(attempt.key));
  }
});

for (const unavailable of ["locks", "storage"]) {
  test(`unavailable ${unavailable} blocks explicit erase without discarding recoverable data`, async t => {
    const origin = createOrigin();
    const app = await storedApp(t, origin);
    app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
    app.window.localStorage.setItem("s9000.volume", "35");
    const saved = app.window.localStorage.getItem("s9000.auth");
    const revision = app.run("getWorkingDatabaseRevision()");
    const version = (await app.run("idbGet(IDB_KEY)")).version;
    if (unavailable === "locks") app.window.navigator.locks = undefined;
    else origin.failure = operation => operation === "write";
    assert.equal(await app.run("eraseBrowserData()"), false);
    origin.failure = null;
    assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
    assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
    assert.equal(app.run("getWorkingDatabaseRevision()"), revision);
    assert.equal(app.run(`pending.colors['${ids.firstPlayback}']`), 2);
    assert.equal((await app.run("idbGet(IDB_KEY)")).version, version);
    assert.equal(app.run("erasingBrowser"), false);
    assert.match(app.window.document.getElementById("logout-status").textContent, /Cleanup did not complete/);
    assert.equal(app.window.localStorage.getItem("s9000.erase"), null);
  });
}

test("an explicit eraser closes its own IDB connections before waiting for the shared gate", async t => {
  const origin = createOrigin();
  const app = await storedApp(t, origin);
  const connection = await app.run("idbOpen()");
  let closed = false;
  const close = connection.close.bind(connection);
  connection.close = () => { closed = true; close(); };
  const held = await holdAuthLock(app);
  const erasing = app.run("eraseBrowserData()");
  await waitFor(async () => (await origin.locks.query()).pending.length === 1);
  assert.equal(closed, true);
  held.release();
  await held.done;
  assert.equal(await erasing, true);
});
