const test = require("node:test");
const assert = require("node:assert/strict");
const { createOrigin, deferred } = require("./helpers/app.cjs");
const { databaseApp, fixture, ids, scalar } = require("./helpers/database.cjs");

const track = (index, extra = {}) => ({
  type: "track", id: `synthetic-bulk-${index}`, name: `Synthetic song ${index}`,
  duration_ms: 123456, artists: [{ name: "Synthetic artist" }], album: { name: "Synthetic album" },
  ...extra,
});
const entry = (index, extra) => ({ item: track(index, extra) });
const totalButtons = app => app.rows("SELECT COUNT(*) AS n FROM Playback")[0].n;
const message = app => app.window.document.getElementById("add-playlist-status").textContent;
const selectPlaylist = app => app.run(`
  openAddSong(); addSongMode = "playlist";
  document.getElementById("add-search-pane").classList.add("hidden");
  document.getElementById("add-playlist-pane").classList.remove("hidden");
  document.getElementById("add-playlist-back").classList.remove("hidden");
  plTracksState = { id: "synthetic-playlist", name: "Synthetic playlist", offset: 100, total: null, loading: false };
  updatePlaylistBulkControls();
`);

async function bulkApp(t, entries = [entry(1), entry(2)], options = {}) {
  const app = await databaseApp(t, options);
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
  app.requests = [];
  app.confirmations = [];
  app.backend = { entries, version: "synthetic-version", before: null, pages: null, versions: 0 };
  app.window.bulkApi = async (path, request = {}, current) => {
    assert.equal(request.method, undefined, "Bulk import must never change Spotify or start playback");
    if (current && !current()) throw new Error("Synthetic request canceled");
    const url = new URL(path, "https://api.spotify.test");
    app.requests.push(url);
    if (app.backend.before) await app.backend.before(url);
    if (url.pathname === "/playlists/synthetic-playlist") {
      app.backend.versions++;
      return { snapshot_id: app.backend.version };
    }
    if (url.pathname === "/playlists/synthetic-playlist/items") {
      const offset = Number(url.searchParams.get("offset"));
      assert.equal(Number(url.searchParams.get("limit")), 100);
      const page = { offset, total: app.backend.entries.length, items: app.backend.entries.slice(offset, offset + 100) };
      return app.backend.pages ? app.backend.pages(page) : structuredClone(page);
    }
    throw new Error("Unexpected synthetic playlist request");
  };
  app.window.confirm = prompt => { app.confirmations.push(prompt); return true; };
  app.run("window.originalBulkApi = api; api = (...args) => window.bulkApi(...args)");
  selectPlaylist(app);
  return app;
}

test("bulk add reads every page then makes one backed-up transaction and one recovery write", async t => {
  const app = await bulkApp(t, Array.from({ length: 205 }, (_, index) => entry(index)));
  const originalRows = JSON.stringify(app.rows("SELECT * FROM Playback ORDER BY playbackUUIDRaw"));
  let writes = 0;
  app.run("window.originalPut = idbPut");
  app.window.countPut = (...args) => { writes++; return app.window.originalPut(...args); };
  app.run("idbPut = window.countPut");
  app.backend.before = async () => {
    assert.equal(totalButtons(app), 2, "No partial library changes while downloading");
    assert.equal(app.downloads.length, 0);
  };
  assert.equal(await app.run("addAllPlaylistTracks()"), true);
  assert.equal(totalButtons(app), 207);
  assert.equal(writes, 1);
  assert.equal(app.run("pending.tabOps"), 1);
  assert.equal(app.downloads.length, 1);
  assert.equal(scalar(app.SQL, app.downloads[0], "SELECT COUNT(*) FROM Playback"), 2);
  assert.equal(app.backend.versions, 2);
  assert.deepEqual(app.requests.filter(url => url.pathname.endsWith("/items")).map(url => Number(url.searchParams.get("offset"))), [0, 100, 200]);
  assert.equal(app.confirmations.length, 1);
  assert.match(app.confirmations[0], /Add 205 songs.*Synthetic tab 0/s);
  assert.match(message(app), /205 songs added.*Use Save/);
  assert.equal(JSON.stringify(app.rows(`SELECT * FROM Playback WHERE playbackUUIDRaw IN ('${ids.firstPlayback}','${ids.secondPlayback}') ORDER BY playbackUUIDRaw`)), originalRows);
  const added = app.rows(`SELECT * FROM Playback WHERE playbackGroupUUIDRaw='${ids.firstGroup}' ORDER BY orderIndex`).slice(1);
  for (let index = 0; index < added.length; index++) {
    assert.equal(added[index].orderIndex, index + 1);
    assert.equal(added[index].displayTitle, `Synthetic song ${index}`);
    assert.match(added[index].playbackUUIDRaw, /^[0-9A-F-]{36}$/);
    assert.equal(added[index].stopAtSeconds, 123);
    assert.equal(added[index].stopAtSubSec, 0.456);
    assert.equal(added[index].volume, -1);
    assert.equal(added[index].fadeInSeconds, -1);
    assert.equal(added[index].fadeOutSeconds, -1);
    assert.equal(added[index].hasBeenPlayedRaw, 0);
    assert.equal(added[index].hotKey, "");
    assert.ok(added[index].updatedTimestamp1970 > 1e9 && added[index].updatedTimestamp1970 < 1e10);
  }
  const saved = await app.run("idbGet(IDB_KEY)");
  assert.equal(scalar(app.SQL, saved.bytes, "SELECT COUNT(*) FROM Playback"), 207);
  assert.equal(scalar(app.SQL, saved.baseline, "SELECT COUNT(*) FROM Playback"), 2);
  assert.equal(app.run("nowPlaying"), null);
});

test("whole-playlist fetching is independent of the manual browser's 2000-item page limit", async t => {
  const app = await bulkApp(t, Array.from({ length: 2103 }, (_, index) => entry(index)));
  const result = await app.run("readWholePlaylist('synthetic-playlist', () => true)");
  assert.equal(result.tracks.length, 2103);
  assert.equal(result.skipped, 0);
  assert.equal(result.tracks.at(-1).id, "synthetic-bulk-2102");
  assert.equal(app.requests.filter(url => url.pathname.endsWith("/items")).length, 22);
  assert.equal(totalButtons(app), 2);
});

test("unusable-only pages are skipped without terminating pagination or losing duplicate occurrences", async t => {
  const duplicate = track(1, { id: "synthetic-track-0", name: "Synthetic track" });
  const entries = [
    ...Array.from({ length: 100 }, (_, index) => entry(index, { is_playable: false })),
    { item: duplicate }, { track: duplicate }, null, { item: null }, entry(3, { type: "episode" }),
    { is_local: true, item: track(4) }, entry(5, { is_local: true }), entry(6, { duration_ms: 0 }),
    { item: track(7, { name: "Synthetic track" }) },
  ];
  const app = await bulkApp(t, entries);
  await app.run(`setTabLayout('${ids.firstGroup}', 'lineup')`);
  await app.run(`setPlayerPresent('${ids.firstPlayback}', false)`);
  assert.equal(await app.run("addAllPlaylistTracks()"), true);
  const rows = app.rows(`SELECT * FROM Playback WHERE playbackGroupUUIDRaw='${ids.firstGroup}' ORDER BY orderIndex`);
  assert.deepEqual(Array.from(rows, row => row.displayTitle), ["Synthetic track", "Synthetic track (2)", "Synthetic track (3)", "Synthetic track (4)"]);
  assert.equal(rows[1].sourceUUIDRaw, rows[0].sourceUUIDRaw);
  assert.equal(rows[2].sourceUUIDRaw, rows[0].sourceUUIDRaw);
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM Sound")[0].n, 3);
  assert.equal(app.run("Object.keys(readLineupPreferences().absent).length"), 1);
  assert.match(message(app), /3 songs added.*106 entries skipped/);
  assert.match(app.confirmations[0], /106 unavailable.*Repeated songs.*separate buttons/s);
});

for (const count of [0, 7]) {
  test(`${count ? "entirely unusable" : "empty"} playlists do not ask to confirm or create backups`, async t => {
    const app = await bulkApp(t, Array.from({ length: count }, (_, index) => entry(index, { is_playable: false })));
    const before = Buffer.from(app.run("db.export()"));
    assert.equal(await app.run("addAllPlaylistTracks()"), false);
    assert.deepEqual(Buffer.from(app.run("db.export()")), before);
    assert.equal(app.downloads.length, 0);
    assert.equal(app.confirmations.length, 0);
    assert.equal(app.run("pendingCount()"), 0);
    assert.match(message(app), /Nothing was added/);
  });
}

for (const failure of ["network", "version", "total", "offset", "empty page", "missing items"]) {
  test(`a ${failure} failure after the first page leaves the library completely unchanged`, async t => {
    const app = await bulkApp(t, Array.from({ length: 102 }, (_, index) => entry(index)));
    const before = Buffer.from(app.run("db.export()"));
    const cached = await app.run("idbGet(IDB_KEY)");
    app.backend.before = async url => {
      if (url.searchParams.get("offset") === "100") {
        if (failure === "network") throw new Error("Synthetic download failed");
        if (failure === "version") app.backend.version = "different-synthetic-version";
      }
    };
    app.backend.pages = page => {
      if (page.offset !== 100) return page;
      if (failure === "total") page.total++;
      if (failure === "offset") page.offset = 0;
      if (failure === "empty page") page.items = [];
      if (failure === "missing items") delete page.items;
      return page;
    };
    assert.equal(await app.run("addAllPlaylistTracks()"), false);
    assert.deepEqual(Buffer.from(app.run("db.export()")), before);
    assert.equal((await app.run("idbGet(IDB_KEY)")).version, cached.version);
    assert.equal(app.downloads.length, 0);
    assert.equal(app.run("pendingCount()"), 0);
    assert.equal(app.confirmations.length, 0);
    assert.match(message(app), /No songs were added/);
    assert.equal(app.window.document.getElementById("btn-add-playlist-all").disabled, false);
  });
}

test("missing playlist version fails closed without a partial import", async t => {
  const app = await bulkApp(t);
  app.backend.version = "";
  assert.equal(await app.run("addAllPlaylistTracks()"), false);
  assert.equal(app.requests.length, 1);
  assert.equal(totalButtons(app), 2);
  assert.match(message(app), /playlist version/);
});

test("rejecting the count/destination confirmation leaves even the pre-edit backup untouched", async t => {
  const app = await bulkApp(t);
  app.window.confirm = () => false;
  assert.equal(await app.run("addAllPlaylistTracks()"), false);
  assert.equal(app.run("baselineActive"), false);
  assert.equal(app.run("pendingCount()"), 0);
  assert.equal(app.downloads.length, 0);
  assert.equal(totalButtons(app), 2);
  assert.match(message(app), /Canceled/);
});

for (const action of [
  "cancelPlaylistBulk(true)", "closeAddSong()", "setAddMode('search')", "showPlaylistList()",
  "setDialogOpen('modal', true)", "activeTabIdx = 1",
  "invalidateAuthWork()", "localStorage.setItem(LS_AUTH, JSON.stringify({clientId:'synthetic-client',refreshToken:'changed-synthetic-refresh'}))",
  "importSequence++",
]) {
  test(`late playlist responses cannot add songs after ${action.split("(")[0]}`, async t => {
    const app = await bulkApp(t);
    const entered = deferred(), release = deferred();
    app.backend.before = async url => {
      if (url.pathname.endsWith("/items")) { entered.resolve(); await release.promise; }
    };
    const task = app.run("addAllPlaylistTracks()");
    await entered.promise;
    app.run(action);
    release.resolve();
    assert.equal(await task, false);
    assert.equal(totalButtons(app), 2);
    assert.equal(app.downloads.length, 0);
    assert.equal(app.confirmations.length, 0);
    assert.equal(app.run("playlistBulkOperation"), null);
  });
}

test("a completed library replacement cannot receive an old playlist batch", async t => {
  const app = await bulkApp(t);
  const entered = deferred(), release = deferred();
  app.backend.before = async url => {
    if (url.pathname.endsWith("/items")) { entered.resolve(); await release.promise; }
  };
  const task = app.run("addAllPlaylistTracks()");
  await entered.promise;
  app.window.replacement = fixture(app.SQL, "Synthetic replacement");
  await app.run("loadDbFromBytes(window.replacement)");
  release.resolve();
  assert.equal(await task, false);
  assert.equal(totalButtons(app), 2);
  assert.equal(app.rows("SELECT displayTitle FROM Playback LIMIT 1")[0].displayTitle, "Synthetic replacement");
});

test("switching playlists rejects an older response and cannot replace the new view's status", async t => {
  const app = await bulkApp(t);
  const entered = deferred(), release = deferred();
  app.backend.before = async url => {
    if (url.pathname.endsWith("/items")) { entered.resolve(); await release.promise; }
  };
  const old = app.run("addAllPlaylistTracks()");
  await entered.promise;
  app.run("loadPlaylistTracks = async () => {}; openPlaylist('another-synthetic-playlist','Another synthetic playlist')");
  const afterSwitch = message(app);
  release.resolve();
  assert.equal(await old, false);
  assert.equal(app.run("plTracksState.id"), "another-synthetic-playlist");
  assert.equal(message(app), afterSwitch);
  assert.equal(totalButtons(app), 2);
});

test("a token returned after cancellation cannot send even the first playlist request", async t => {
  const app = await bulkApp(t);
  const entered = deferred(), release = deferred();
  const requests = [];
  app.window.waitToken = () => { entered.resolve(); return release.promise; };
  app.window.fetch = async url => { requests.push(url); throw new Error("Canceled request reached the network"); };
  app.run("api = window.originalBulkApi; getAccessToken = window.waitToken");
  const task = app.run("addAllPlaylistTracks()");
  await entered.promise;
  app.run("closeAddSong()");
  release.resolve("synthetic-access");
  assert.equal(await task, false);
  assert.deepEqual(requests, []);
  assert.equal(totalButtons(app), 2);
});

test("a save beginning during loading prevents insertion until the operator tries again", async t => {
  const app = await bulkApp(t);
  app.window.confirm = () => { app.run("saveInProgress = true"); return true; };
  assert.equal(await app.run("addAllPlaylistTracks()"), false);
  assert.match(message(app), /save is in progress/);
  assert.equal(totalButtons(app), 2);
  assert.equal(app.downloads.length, 0);
  app.run("saveInProgress = false");
});

test("repeat clicks and single adds cannot create overlapping batches; a canceled response cannot overwrite a newer result", async t => {
  const app = await bulkApp(t);
  const entered = deferred(), release = deferred();
  let held = false;
  app.backend.before = async url => {
    if (!held && url.pathname.endsWith("/items")) { held = true; entered.resolve(); await release.promise; }
  };
  const old = app.run("addAllPlaylistTracks()");
  await entered.promise;
  assert.equal(await app.run("addAllPlaylistTracks()"), false);
  app.window.trackToAdd = track(8);
  app.run("addTileForTrack(window.trackToAdd)");
  assert.equal(totalButtons(app), 2);
  app.run("cancelPlaylistBulk(true)");
  assert.equal(await app.run("addAllPlaylistTracks()"), true);
  const completeMessage = message(app);
  release.resolve();
  assert.equal(await old, false);
  assert.equal(message(app), completeMessage);
  assert.equal(totalButtons(app), 4);
  const requestCount = app.requests.length;
  assert.equal(await app.run("addAllPlaylistTracks()"), false);
  assert.equal(app.requests.length, requestCount);
});

test("a legitimate token refresh does not cancel the batch", async t => {
  const app = await bulkApp(t);
  app.backend.before = async () => {
    app.run("accessTokenAuth = setAuth({clientId:'synthetic-client',refreshToken:'rotated-synthetic-refresh'})");
  };
  assert.equal(await app.run("addAllPlaylistTracks()"), true);
  assert.equal(totalButtons(app), 4);
});

for (const failure of ["ABORT, 'Synthetic batch failure'", "IGNORE"]) {
  test(`a native ${failure.split(",")[0]} on a later insert rolls back all new sounds and buttons`, async t => {
    const app = await bulkApp(t);
    app.run(`db.run("CREATE TRIGGER synthetic_reject_batch BEFORE INSERT ON Playback WHEN NEW.displayTitle='Synthetic song 2' BEGIN SELECT RAISE(${failure}); END")`);
    assert.equal(await app.run("addAllPlaylistTracks()"), false);
    assert.equal(totalButtons(app), 2);
    assert.equal(app.rows("SELECT COUNT(*) AS n FROM Sound")[0].n, 2);
    assert.equal(app.run("pendingCount()"), 0);
    assert.equal(app.downloads.length, 1);
    assert.match(message(app), /No songs were added/);
  });
}

test("a recovery failure leaves the complete batch in memory and prevents a duplicate add", async t => {
  const app = await bulkApp(t);
  const before = await app.run("idbGet(IDB_KEY)");
  app.run("window.goodPut = idbPut; idbPut = async () => { throw new Error('Synthetic recovery failure'); }");
  assert.equal(await app.run("addAllPlaylistTracks()"), false);
  assert.equal(totalButtons(app), 4);
  assert.equal(app.run("pendingCount()"), 1);
  assert.equal((await app.run("idbGet(IDB_KEY)")).version, before.version);
  assert.match(message(app), /2 songs added.*recovery could not be saved.*do not add.*again/);
  assert.equal(app.window.document.getElementById("btn-add-playlist-all").disabled, true);
  assert.equal(await app.run("addAllPlaylistTracks()"), false);
  assert.equal(totalButtons(app), 4);
  app.run("idbPut = window.goodPut");
  assert.equal(await app.run("commitChanges()"), true);
  assert.equal(scalar(app.SQL, (await app.run("idbGet(IDB_KEY)")).bytes, "SELECT COUNT(*) FROM Playback"), 4);
});

test("an edit arriving while batch recovery waits is preserved with the complete batch", async t => {
  const app = await bulkApp(t);
  const entered = deferred(), release = deferred();
  app.run("window.goodPut = idbPut");
  app.window.delayedPut = async (...args) => { entered.resolve(); await release.promise; return app.window.goodPut(...args); };
  app.run("idbPut = window.delayedPut");
  const task = app.run("addAllPlaylistTracks()");
  await entered.promise;
  app.run(`setCellColor('${ids.firstPlayback}', 2)`);
  release.resolve();
  assert.equal(await task, true);
  await app.run("databaseQueue");
  const recovery = await app.run("idbGet(IDB_KEY)");
  assert.equal(recovery.pending.colors[ids.firstPlayback], 2);
  assert.equal(scalar(app.SQL, recovery.bytes, "SELECT COUNT(*) FROM Playback"), 4);
  assert.equal(app.run("pending.tabOps"), 1);
});

test("adding a batch preserves current audio, paused position, idle intent and cue settings", async t => {
  const app = await bulkApp(t);
  app.run(`setNowPlaying(document.querySelector('#grid .cell')); setPlaybackPaused(true);
    pending.stops['${ids.firstPlayback}'] = 45234; savePending();`);
  await app.run("databaseQueue");
  const progress = app.run("progress");
  const position = app.run("currentPositionMs()");
  const generation = app.run("transportGeneration");
  const idle = app.run("idleGeneration");
  assert.equal(await app.run("addAllPlaylistTracks()"), true);
  assert.equal(app.run("progress"), progress);
  assert.equal(app.run("currentPositionMs()"), position);
  assert.equal(app.run("transportGeneration"), generation);
  assert.equal(app.run("idleGeneration"), idle);
  assert.equal(app.run("effectiveStopMs(nowPlaying.uuid)"), 45234);
  assert.equal(app.run("nowPlaying.uuid"), ids.firstPlayback);
});

test("storage read failure is reported without a rejected event promise or mutation", async t => {
  const origin = createOrigin();
  const app = await bulkApp(t, [entry(1)], { origin });
  origin.failure = (operation, key) => operation === "read" && key === "s9000.auth";
  assert.equal(await app.run("addAllPlaylistTracks()"), false);
  assert.equal(totalButtons(app), 2);
  assert.match(message(app), /storage|settings|sign-in/i);
  origin.failure = null;
});
