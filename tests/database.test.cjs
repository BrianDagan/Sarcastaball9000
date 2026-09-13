const test = require("node:test");
const assert = require("node:assert/strict");
const { deferred } = require("./helpers/app.cjs");
const { ids, fixture, databaseApp, scalar } = require("./helpers/database.cjs");

test("invalid imports preserve active database, edits and recovery bytes", async t => {
  const app = await databaseApp(t);
  app.run(`setCellColor('${ids.firstPlayback}', 2)`);
  await app.run("databaseQueue");
  const before = await app.run("idbGet(IDB_KEY)");
  const revision = app.run("getWorkingDatabaseRevision()");
  await assert.rejects(app.run("loadDbFromBytes(new Uint8Array([1,2,3]))"), /corrupt|incompatible/);
  const after = await app.run("idbGet(IDB_KEY)");
  assert.equal(after.version, before.version);
  assert.equal(app.run("getWorkingDatabaseRevision()"), revision);
  assert.equal(app.run(`pending.colors['${ids.firstPlayback}']`), 2);
});

test("a failed recovery write during import cannot replace the working database", async t => {
  const app = await databaseApp(t);
  app.window.replacement = fixture(app.SQL, "Replacement fixture");
  app.run("idbPut = async () => { throw new Error('Synthetic cache failure'); }");
  await assert.rejects(app.run("loadDbFromBytes(window.replacement)"), /cache failure/);
  assert.equal(app.rows("SELECT title FROM Sound LIMIT 1")[0].title, "Synthetic track");
});

test("canceling file selection or validated replacement preserves pending changes", async t => {
  const app = await databaseApp(t);
  app.run(`setCellColor('${ids.firstPlayback}', 2)`);
  assert.equal(await app.run("handleDatabaseFile(undefined)"), false);
  app.window.replacement = fixture(app.SQL, "Replacement fixture");
  assert.equal(await app.run("loadDbFromBytes(window.replacement)"), false);
  assert.equal(app.run(`pending.colors['${ids.firstPlayback}']`), 2);
  assert.equal(app.rows("SELECT title FROM Sound LIMIT 1")[0].title, "Synthetic track");
});

test("first-operation tab deletion captures the original pre-change backup", async t => {
  const app = await databaseApp(t);
  app.window.confirm = () => true;
  app.run("tabDelete(1)");
  await app.run("databaseQueue");
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM PlaybackGroup")[0].n, 1);
  assert.equal(scalar(app.SQL, app.downloads[0], "SELECT COUNT(*) FROM PlaybackGroup"), 2);
  const record = await app.run("idbGet(IDB_KEY)");
  assert.equal(scalar(app.SQL, record.baseline, "SELECT COUNT(*) FROM PlaybackGroup"), 2);
});

test("immediate mutations roll back as a unit on error", async t => {
  const app = await databaseApp(t);
  assert.equal(app.run("mutateDatabase(() => { db.run('DELETE FROM Playback'); throw new Error('Synthetic failure'); })"), false);
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM Playback")[0].n, 2);
});

test("deleting a destination tab removes its pending incoming moves", async t => {
  const app = await databaseApp(t);
  app.window.confirm = () => true;
  app.run(`setCellMove('${ids.firstPlayback}', '${ids.secondGroup}'); tabDelete(1)`);
  assert.equal(app.run("Object.keys(pending.moves).length"), 0);
  const exported = await app.run("exportWorkingDatabase()");
  assert.equal(scalar(app.SQL, exported, "SELECT COUNT(*) FROM Playback"), 1);
});

test("save retains edits arriving during its asynchronous recovery write", async t => {
  const app = await databaseApp(t);
  app.window.confirm = () => true;
  app.run(`setCellColor('${ids.firstPlayback}', 1)`);
  await app.run("databaseQueue");
  const entered = deferred();
  const gate = deferred();
  app.run("window.realPut = idbPut");
  app.window.delayedPut = (...args) => { entered.resolve(); return gate.promise.then(() => app.window.realPut(...args)); };
  app.run("idbPut = window.delayedPut");
  const save = app.run("commitChanges()");
  await entered.promise;
  assert.equal(await app.run("commitChanges()"), false);
  app.run(`setCellColor('${ids.firstPlayback}', 2)`);
  gate.resolve();
  assert.equal(await save, true);
  assert.equal(app.run(`pending.colors['${ids.firstPlayback}']`), 2);
  const exported = await app.run("exportWorkingDatabase()");
  assert.equal(scalar(app.SQL, exported, `SELECT songCellColorRaw FROM Playback WHERE playbackUUIDRaw='${ids.firstPlayback}'`), 2);
  assert.equal(scalar(app.SQL, app.downloads.at(-1), `SELECT songCellColorRaw FROM Playback WHERE playbackUUIDRaw='${ids.firstPlayback}'`), 1);
});

test("played-only changes are exportable and mark the working copy dirty", async t => {
  const app = await databaseApp(t);
  app.run(`setCellPlayedFlag('${ids.firstPlayback}', true)`);
  assert.ok(app.run("pendingCount()") > 0);
  const exported = await app.run("exportWorkingDatabase()");
  assert.equal(scalar(app.SQL, exported, `SELECT hasBeenPlayedRaw FROM Playback WHERE playbackUUIDRaw='${ids.firstPlayback}'`), 1);
});

test("save reports failure if recovery of newer edits cannot be persisted", async t => {
  const app = await databaseApp(t);
  app.window.confirm = () => true;
  app.run(`setCellColor('${ids.firstPlayback}', 1)`);
  await app.run("databaseQueue");
  const entered = deferred();
  const gate = deferred();
  let writes = 0;
  app.run("window.realPut = idbPut");
  app.window.delayedPut = async (...args) => {
    if (++writes > 1) throw new Error("Synthetic recovery failure; keep this tab open.");
    entered.resolve();
    await gate.promise;
    return app.window.realPut(...args);
  };
  app.run("idbPut = window.delayedPut");
  const save = app.run("commitChanges()");
  await entered.promise;
  app.run(`setCellColor('${ids.firstPlayback}', 2)`);
  gate.resolve();
  assert.equal(await save, false);
  assert.equal(app.run(`pending.colors['${ids.firstPlayback}']`), 2);
  assert.match(app.window.document.getElementById("db-status").textContent, /recovery failure/);
});

test("new tracks preserve their complete fractional duration", async t => {
  const app = await databaseApp(t);
  app.run("addTileForTrack({type:'track', id:'synthetic-new', name:'New synthetic track', artists:[], duration_ms:98765})");
  const row = app.rows("SELECT p.stopAtSeconds AS seconds, p.stopAtSubSec AS fraction, s.playbackDuration AS duration FROM Playback p JOIN Sound s ON s.soundUUIDRaw=p.sourceUUIDRaw WHERE s.trackID='synthetic-new'")[0];
  assert.equal(Math.round((row.seconds + row.fraction) * 1000), 98765);
  assert.equal(row.duration, 98.765);
});

test("legacy edits migrate only with their existing recovery database", async t => {
  const app = await databaseApp(t, { load: false });
  app.window.legacyBytes = fixture(app.SQL);
  await app.run("idbPut(IDB_KEY, window.legacyBytes)");
  app.window.localStorage.setItem("s9000.pending", JSON.stringify({ colors: { [ids.firstPlayback]: 3 } }));
  app.run("loadPending()");
  await app.run("restoreCachedDatabase()");
  assert.equal(app.run(`pending.colors['${ids.firstPlayback}']`), 3);
  const record = await app.run("idbGet(IDB_KEY)");
  assert.equal(record.format, 1);
  assert.equal(record.pending.colors[ids.firstPlayback], 3);
  assert.equal(app.window.localStorage.getItem("s9000.pending"), null);
});

test("another tab's recovery update is not silently overwritten", async t => {
  const first = await databaseApp(t);
  const second = await databaseApp(t, { load: false, indexedDB: first.window.indexedDB });
  await second.run("restoreCachedDatabase()");
  first.run(`setCellColor('${ids.firstPlayback}', 1)`);
  await first.run("databaseQueue");
  second.run(`setCellColor('${ids.firstPlayback}', 2)`);
  await second.run("databaseQueue");
  assert.match(second.window.document.getElementById("db-status").textContent, /Another tab/);
  const record = await first.run("idbGet(IDB_KEY)");
  assert.equal(record.pending.colors[ids.firstPlayback], 1);
  assert.equal(second.run(`pending.colors['${ids.firstPlayback}']`), 2);
});

test("late file reads cannot recreate recovery after logout invalidation", async t => {
  const app = await databaseApp(t);
  const read = deferred();
  app.window.testFile = { arrayBuffer: () => read.promise };
  const loading = app.run("handleDatabaseFile(window.testFile)");
  await app.run("invalidateDatabaseWork()");
  read.resolve(fixture(app.SQL, "Late fixture"));
  assert.equal(await loading, false);
  assert.equal(app.rows("SELECT title FROM Sound LIMIT 1")[0].title, "Synthetic track");
});

test("working exports contain database data, not remembered browser credentials", async t => {
  const app = await databaseApp(t);
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-browser-credential-excluded" }));
  const exported = await app.run("exportWorkingDatabase()");
  assert.equal(Buffer.from(exported).includes(Buffer.from("synthetic-browser-credential-excluded")), false);
});

test("invalid recovery edit values are rejected without replacing cached bytes", async t => {
  const app = await databaseApp(t);
  app.run(`window.badRecord = recoveryRecord(); window.badRecord.pending.volumes['${ids.firstPlayback}'] = 'invalid'`);
  await app.run("idbPut(IDB_KEY, window.badRecord)");
  const before = await app.run("idbGet(IDB_KEY)");
  await assert.rejects(app.run("restoreCachedDatabase()"), /Saved edit values are invalid/);
  assert.equal((await app.run("idbGet(IDB_KEY)")).version, before.version);
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM Playback")[0].n, 2);
});

test("playing cues survive saving and deleting the playing track's tab", async t => {
  const app = await databaseApp(t);
  app.window.confirm = () => true;
  app.run("trackPlayedOn = false; setNowPlaying(document.querySelector('#grid .cell'))");
  app.run(`pending.stops['${ids.firstPlayback}'] = 45234; savePending()`);
  await app.run("commitChanges()");
  assert.equal(app.run("effectiveStopMs(nowPlaying.uuid)"), 45234);
  app.run("tabDelete(0)");
  assert.equal(app.run("effectiveStopMs(nowPlaying.uuid)"), 45234);
  assert.equal(app.run("playingSnapshot.stopms"), 45234);
});

test("a delayed wake lock is single-flight and released after database invalidation", async t => {
  const app = await databaseApp(t);
  const gate = deferred();
  let requested = 0;
  let released = 0;
  Object.defineProperty(app.window.document, "visibilityState", { value: "visible", configurable: true });
  app.window.navigator.wakeLock = { request: () => { requested++; return gate.promise; } };
  const first = app.run("requestWakeLock()");
  await app.run("requestWakeLock()");
  await app.run("invalidateDatabaseWork()");
  app.run("clearDatabaseState()");
  gate.resolve({ release: async () => { released++; }, addEventListener() {} });
  await first;
  assert.equal(requested, 1);
  assert.equal(released, 1);
  assert.equal(app.run("wakeLock"), null);
});
