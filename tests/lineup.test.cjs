const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, createOrigin, deferred } = require("./helpers/app.cjs");
const { ids, lineupFixture, databaseApp, scalar } = require("./helpers/database.cjs");

const FIRST = ids.firstPlayback;
const SECOND = "00000000-0000-4000-8000-000000001001";
const THIRD = "00000000-0000-4000-8000-000000001002";
const GROUP = ids.firstGroup;
const call = (app, name, ...args) => app.run(`${name}(${args.map(value => JSON.stringify(value)).join(",")})`);
const profile = app => JSON.parse(app.run("JSON.stringify(readLineupPreferences())"));
const order = app => Array.from(app.rows(`SELECT playbackUUIDRaw AS uuid FROM Playback WHERE playbackGroupUUIDRaw='${GROUP}' ORDER BY orderIndex`), row => row.uuid);
const cell = (app, uuid = FIRST) => Array.from(app.window.document.querySelectorAll("#grid .cell")).find(item => item.dataset.pbuuid === uuid);

async function lineupApp(t, { origin, restore = false } = {}) {
  const app = await databaseApp(t, { load: false, origin });
  if (restore) await app.run("restoreCachedDatabase()");
  else {
    app.window.lineupBytes = lineupFixture(app.SQL);
    await app.run("loadDbFromBytes(window.lineupBytes)");
  }
  return app;
}

function installPlaybackRecorder(app) {
  const requests = [];
  app.window.recordLineupApi = async (path, options = {}, current) => {
    if (current && !current()) throw new Error("Synthetic request was superseded");
    requests.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return null;
  };
  app.run(`window.originalLineupApi = api; api = (...args) => window.recordLineupApi(...args);
    ensureDevice = async () => "synthetic-device"; trackPlayedOn = false;
    activeDeviceId = "synthetic-device"; activeDeviceCapabilities = { supports_volume: false };
  `);
  return requests;
}

test("layout and attendance change only browser preferences, never SQLite or dirty state", async t => {
  const app = await lineupApp(t);
  const bytes = Buffer.from(app.run("db.export()"));
  const recovery = await app.run("idbGet(IDB_KEY)");
  assert.equal(app.run(`tabLayout('${GROUP}')`), "standard");
  assert.equal(await call(app, "setTabLayout", GROUP, "lineup"), true);
  assert.equal(await call(app, "setPlayerPresent", SECOND, false), true);
  assert.deepEqual(Buffer.from(app.run("db.export()")), bytes);
  assert.equal((await app.run("idbGet(IDB_KEY)")).version, recovery.version);
  assert.equal(app.run("pendingCount()"), 0);
  assert.equal(app.downloads.length, 0);
  assert.equal(profile(app).layouts[GROUP], "lineup");
  assert.equal(profile(app).absent[SECOND], true);
  assert.deepEqual(Array.from(app.window.document.querySelectorAll(".lineup-position"), node => node.textContent), ["1", "2", "3", "4", "5"]);
  assert.equal(cell(app, SECOND).getAttribute("aria-disabled"), "true");
  assert.equal(cell(app, SECOND).closest(".lineup-row").querySelector(".lineup-handle").disabled, false);
  assert.equal(app.run("getGridLayout().cols"), 1);
});

test("layout follows a group's UUID through rename and tab reordering, not its title or index", async t => {
  const app = await lineupApp(t);
  await call(app, "setTabLayout", GROUP, "lineup");
  app.window.prompt = () => "Synthetic renamed tab";
  app.run("tabRename(0); tabMove(0, 1)");
  assert.equal(app.run(`groups.findIndex(group => group.uuid === '${GROUP}')`), 1);
  assert.equal(app.run(`tabLayout('${GROUP}')`), "lineup");
  assert.equal(app.run(`tabLayout('${ids.secondGroup}')`), "standard");
  assert.equal(profile(app).layouts["Synthetic renamed tab"], undefined);
  assert.equal(app.window.document.getElementById("grid").getAttribute("aria-label"), "Synthetic renamed tab lineup");
});

test("moving an inactive tab displays the selected moved tab's own layout and songs", async t => {
  const app = await lineupApp(t);
  await call(app, "setTabLayout", GROUP, "lineup");
  app.run("tabMove(1, -1)");
  assert.equal(app.run("groups[activeTabIdx].uuid"), ids.secondGroup);
  const grid = app.window.document.getElementById("grid");
  assert.equal(grid.dataset.groupuuid, ids.secondGroup);
  assert.equal(grid.dataset.layout, "standard");
  assert.equal(grid.querySelector(".cell").dataset.pbuuid, ids.secondPlayback);
});

test("preferences survive cached recovery and Save, but a valid new import starts fresh", async t => {
  const origin = createOrigin();
  const first = await lineupApp(t, { origin });
  await call(first, "setTabLayout", GROUP, "lineup");
  await call(first, "setPlayerPresent", SECOND, false);
  const identity = first.run("databaseIdentity");
  const second = await lineupApp(t, { origin, restore: true });
  assert.equal(second.run("databaseIdentity"), identity);
  assert.equal(profile(second).absent[SECOND], true);
  second.window.confirm = () => true;
  assert.equal(await second.run("commitChanges()"), true);
  assert.equal(second.run("databaseIdentity"), identity);
  assert.equal(profile(second).layouts[GROUP], "lineup");
  const exported = await second.run("exportWorkingDatabase()");
  assert.equal(Buffer.from(exported).includes(Buffer.from("s9000.lineup")), false);
  second.window.newLibrary = lineupFixture(second.SQL);
  assert.equal(await second.run("loadDbFromBytes(window.newLibrary)"), true);
  assert.notEqual(second.run("databaseIdentity"), identity);
  assert.deepEqual(profile(second), { format: 1, layouts: {}, absent: {} });
});

test("invalid and canceled imports retain layout, attendance, recovery and edits", async t => {
  const app = await lineupApp(t);
  await call(app, "setTabLayout", GROUP, "lineup");
  await call(app, "setPlayerPresent", FIRST, false);
  call(app, "setCellColor", FIRST, 3);
  await app.run("databaseQueue");
  const saved = profile(app);
  const identity = app.run("databaseIdentity");
  const recovery = await app.run("idbGet(IDB_KEY)");
  await assert.rejects(app.run("loadDbFromBytes(new Uint8Array([1,2,3]))"), /corrupt|incompatible/);
  assert.equal(await app.run("loadDbFromBytes(window.lineupBytes)"), false);
  assert.equal(app.run("databaseIdentity"), identity);
  assert.deepEqual(profile(app), saved);
  assert.equal((await app.run("idbGet(IDB_KEY)")).version, recovery.version);
  assert.equal(app.run(`pending.colors['${FIRST}']`), 3);
});

test("concurrent windows merge attendance and layout changes instead of overwriting each other", async t => {
  const origin = createOrigin();
  const first = await lineupApp(t, { origin });
  const second = await lineupApp(t, { origin, restore: true });
  const results = await Promise.all([
    call(first, "setPlayerPresent", FIRST, false),
    call(second, "setPlayerPresent", SECOND, false),
    call(first, "setTabLayout", GROUP, "lineup"),
    call(second, "setTabLayout", ids.secondGroup, "lineup"),
  ]);
  assert.deepEqual(results, [true, true, true, true]);
  assert.deepEqual(profile(first).absent, { [FIRST]: true, [SECOND]: true });
  assert.deepEqual(profile(second).layouts, { [GROUP]: "lineup", [ids.secondGroup]: "lineup" });
  assert.equal(cell(first, SECOND).getAttribute("aria-disabled"), "true");
  assert.equal(cell(second, FIRST).getAttribute("aria-disabled"), "true");
});

test("Mark everyone present is atomic and scoped; order and played marks remain untouched", async t => {
  const app = await lineupApp(t);
  await call(app, "setTabLayout", GROUP, "lineup");
  for (const uuid of [FIRST, SECOND, ids.secondPlayback]) await call(app, "setPlayerPresent", uuid, false);
  call(app, "setCellPlayedFlag", FIRST, true);
  await app.run("databaseQueue");
  const bytes = Buffer.from(app.run("db.export()"));
  const beforeOrder = order(app);
  assert.equal(await call(app, "markEveryonePresent", GROUP), true);
  assert.deepEqual(profile(app).absent, { [ids.secondPlayback]: true });
  assert.deepEqual(Buffer.from(app.run("db.export()")), bytes);
  assert.deepEqual(order(app), beforeOrder);
  assert.equal(app.rows(`SELECT hasBeenPlayedRaw AS played FROM Playback WHERE playbackUUIDRaw='${FIRST}'`)[0].played, 1);
});

test("failed preference writes retain the old stored AND in-memory profile with a visible error", async t => {
  const origin = createOrigin();
  const app = await lineupApp(t, { origin });
  await call(app, "setTabLayout", GROUP, "lineup");
  const key = app.run("lineupStorageKey()");
  const before = app.window.localStorage.getItem(key);
  origin.failure = (operation, name) => operation === "write" && name === key;
  assert.equal(await call(app, "setPlayerPresent", SECOND, false), false);
  assert.equal(app.window.localStorage.getItem(key), before);
  assert.equal(profile(app).absent[SECOND], undefined);
  assert.equal(cell(app, SECOND).getAttribute("aria-disabled"), "false");
  assert.match(app.window.document.getElementById("lineup-status").textContent, /not saved/);
  assert.equal(app.run("pendingCount()"), 0);
  origin.failure = null;
});

for (const bad of ["not-json", JSON.stringify({ format: 2, layouts: {}, absent: {} }),
  JSON.stringify({ format: 1, layouts: {}, absent: { [FIRST]: "false" } })]) {
  test(`unreadable preferences fail closed without replacing the record: ${bad === "not-json" ? "JSON" : JSON.parse(bad).format === 2 ? "version" : "type"}`, async t => {
    const app = await lineupApp(t);
    const requests = installPlaybackRecorder(app);
    const key = app.run("lineupStorageKey()");
    const bytes = Buffer.from(app.run("db.export()"));
    app.window.localStorage.setItem(key, bad);
    app.run("refreshLineupView()");
    app.window.testCell = cell(app);
    assert.equal(await app.run("startPlayback(window.testCell)"), false);
    assert.equal(app.window.localStorage.getItem(key), bad);
    assert.deepEqual(Buffer.from(app.run("db.export()")), bytes);
    assert.deepEqual(requests, []);
    assert.equal(app.window.document.getElementById("lineup-status").classList.contains("hidden"), false);
  });
}

test("missing Web Locks cannot cause unlocked preference writes or any data wipe", async t => {
  const app = await lineupApp(t);
  app.window.localStorage.setItem("unrelated-app-key", "keep");
  app.window.navigator.locks = undefined;
  const record = await app.run("idbGet(IDB_KEY)");
  assert.equal(await call(app, "setTabLayout", GROUP, "lineup"), false);
  assert.equal(app.window.localStorage.getItem(app.run("lineupStorageKey()")), null);
  assert.equal(app.window.localStorage.getItem("unrelated-app-key"), "keep");
  assert.equal((await app.run("idbGet(IDB_KEY)")).version, record.version);
  assert.match(app.window.document.getElementById("lineup-status").textContent, /Web Locks/);
});

test("Retry loading retains keyboard focus on an error or returns it to a tab, never an armed song", async t => {
  const app = await lineupApp(t);
  const key = app.run("lineupStorageKey()");
  app.window.localStorage.setItem(key, "invalid");
  app.run("refreshLineupView()");
  const status = app.window.document.getElementById("lineup-status");
  status.querySelector("button").focus();
  status.querySelector("button").click();
  assert.equal(app.window.document.activeElement, status.querySelector("button"));
  app.window.localStorage.removeItem(key);
  status.querySelector("button").click();
  assert.equal(status.classList.contains("hidden"), true);
  assert.equal(app.window.document.activeElement.matches("#tabs .tab.active"), true);
});

test("prototype-like IDs are data in the validated profile, not inherited settings", async t => {
  const app = await lineupApp(t);
  const value = '{"format":1,"layouts":{"__proto__":"lineup"},"absent":{"__proto__":true,"toString":true}}';
  const normalized = app.run(`normalizeLineupPreferences(JSON.parse(${JSON.stringify(value)}))`);
  assert.equal(normalized.layouts.__proto__, "lineup");
  assert.equal(normalized.absent.toString, true);
  assert.equal(Object.getPrototypeOf(normalized.absent), null);
});

test("a malformed preference change is rejected before persistence, without damaging a good profile", async t => {
  const app = await lineupApp(t);
  await call(app, "setTabLayout", GROUP, "lineup");
  const key = app.run("lineupStorageKey()");
  const raw = app.window.localStorage.getItem(key);
  assert.equal(await app.run("changeLineupPreferences(value => { value.absent.bad = 'not a boolean'; })"), false);
  assert.equal(app.window.localStorage.getItem(key), raw);
  assert.equal(profile(app).absent.bad, undefined);
  assert.equal(profile(app).layouts[GROUP], "lineup");
});

test("queued preference changes cannot affect a replacement library", async t => {
  const origin = createOrigin();
  const first = await lineupApp(t, { origin });
  const peer = await lineupApp(t, { origin, restore: true });
  const entered = deferred(), release = deferred();
  const lock = origin.locks.request(first.run("LINEUP_LOCK_NAME"), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const saving = call(first, "setPlayerPresent", FIRST, false);
  peer.window.replacement = lineupFixture(peer.SQL);
  assert.equal(await peer.run("loadDbFromBytes(window.replacement)"), true);
  release.resolve();
  await lock;
  assert.equal(await saving, false);
  assert.deepEqual(profile(peer), { format: 1, layouts: {}, absent: {} });
  assert.match(first.window.document.getElementById("lineup-status").textContent, /saved library changed/);
});

test("a queued stale writer cannot recreate preferences or recovery after completed peer logout", async t => {
  const origin = createOrigin({ autoEvents: false });
  const app = await lineupApp(t, { origin });
  const eraser = createApp({ origin });
  t.after(eraser.close);
  await call(app, "setTabLayout", GROUP, "lineup");
  app.window.localStorage.setItem("unrelated-app-key", "keep");
  const entered = deferred(), release = deferred();
  const lock = origin.locks.request(app.run("LINEUP_LOCK_NAME"), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const saving = call(app, "setPlayerPresent", FIRST, false);
  assert.equal(await eraser.run("eraseBrowserData()"), true);
  release.resolve();
  await lock;
  assert.equal(await saving, false);
  assert.deepEqual(Object.keys(app.window.localStorage).filter(key => key.startsWith("s9000.")), []);
  assert.equal(app.window.localStorage.getItem("unrelated-app-key"), "keep");
  assert.equal((await origin.indexedDB.databases()).some(item => item.name === "s9000"), false);
});

test("reordering uses native orderIndex, captures the original backup and preserves unfamiliar schema", async t => {
  const app = await lineupApp(t);
  app.run("db.run(\"ALTER TABLE Playback ADD COLUMN syntheticExtra TEXT DEFAULT 'retain'\"); renderGrid()");
  const schema = JSON.stringify(app.rows("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name"));
  const original = order(app);
  const rows = JSON.parse(JSON.stringify(app.rows("SELECT * FROM Playback ORDER BY playbackUUIDRaw")));
  const next = [original[2], original[0], original[1], ...original.slice(3)];
  assert.equal(call(app, "writePlaybackOrder", GROUP, next), true);
  assert.deepEqual(order(app), next);
  assert.equal(JSON.stringify(app.rows("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name")), schema);
  const updated = app.rows("SELECT * FROM Playback ORDER BY playbackUUIDRaw");
  updated.forEach((row, index) => {
    for (const key of Object.keys(row).filter(key => !["orderIndex", "updatedTimestamp1970"].includes(key))) {
      assert.equal(row[key], rows[index][key], key);
    }
  });
  assert.equal(app.downloads.length, 1);
  assert.equal(scalar(app.SQL, app.downloads[0], `SELECT playbackUUIDRaw FROM Playback WHERE playbackGroupUUIDRaw='${GROUP}' ORDER BY orderIndex LIMIT 1`), FIRST);
  await app.run("databaseQueue");
  const exported = await app.run("exportWorkingDatabase()");
  assert.equal(scalar(app.SQL, exported, `SELECT playbackUUIDRaw FROM Playback WHERE playbackGroupUUIDRaw='${GROUP}' ORDER BY orderIndex LIMIT 1`), THIRD);
  assert.ok(app.run("pendingCount()") > 0);
});

test("unchanged, incomplete, duplicate and stale orders cannot mutate or create a backup", async t => {
  const app = await lineupApp(t);
  const before = order(app);
  assert.equal(call(app, "writePlaybackOrder", GROUP, before), false);
  assert.equal(call(app, "writePlaybackOrder", GROUP, before.slice(1)), false);
  assert.equal(call(app, "writePlaybackOrder", GROUP, before.map(() => FIRST)), false);
  assert.equal(call(app, "writePlaybackOrder", GROUP, [...before].reverse(), "stale"), false);
  assert.deepEqual(order(app), before);
  assert.equal(app.downloads.length, 0);
  assert.equal(app.run("pendingCount()"), 0);
});

for (const failure of ["ABORT, 'Synthetic failure'", "IGNORE"]) {
  test(`an order transaction rolls back when a native trigger uses ${failure.startsWith("ABORT") ? "ABORT" : "IGNORE"}`, async t => {
    const app = await lineupApp(t);
    app.run(`db.run("CREATE TRIGGER synthetic_reject_order BEFORE UPDATE OF orderIndex ON Playback WHEN NEW.playbackUUIDRaw='${SECOND}' BEGIN SELECT RAISE(${failure}); END")`);
    const before = order(app);
    assert.equal(call(app, "writePlaybackOrder", GROUP, [SECOND, FIRST, ...before.slice(2)]), false);
    assert.deepEqual(order(app), before);
    assert.match(app.window.document.getElementById("db-status").textContent, /rolled back/);
  });
}

test("reordering during an asynchronous Save preserves the newer working order and pending cues", async t => {
  const app = await lineupApp(t);
  app.window.confirm = () => true;
  call(app, "setPendingStop", FIRST, 45234, true);
  await app.run("databaseQueue");
  const before = order(app);
  const entered = deferred(), release = deferred();
  app.run("window.originalPut = idbPut");
  app.window.delayPut = (...args) => { entered.resolve(); return release.promise.then(() => app.window.originalPut(...args)); };
  app.run("idbPut = window.delayPut");
  const save = app.run("commitChanges()");
  await entered.promise;
  assert.equal(call(app, "writePlaybackOrder", GROUP, [...before].reverse()), true);
  release.resolve();
  assert.equal(await save, true);
  assert.deepEqual(order(app), [...before].reverse());
  assert.equal(app.run(`pending.stops['${FIRST}']`), 45234);
  const exported = await app.run("exportWorkingDatabase()");
  assert.equal(scalar(app.SQL, exported, `SELECT playbackUUIDRaw FROM Playback WHERE playbackGroupUUIDRaw='${GROUP}' ORDER BY orderIndex LIMIT 1`), before.at(-1));
  assert.equal(scalar(app.SQL, app.downloads.at(-1), `SELECT playbackUUIDRaw FROM Playback WHERE playbackGroupUUIDRaw='${GROUP}' ORDER BY orderIndex LIMIT 1`), before[0]);
});

test("copies start present; moved rows retain attendance but obey the destination layout", async t => {
  const app = await lineupApp(t);
  await call(app, "setTabLayout", GROUP, "lineup");
  await call(app, "setPlayerPresent", FIRST, false);
  app.window.prompt = () => "Synthetic copy";
  call(app, "copyCell", FIRST);
  const copy = app.rows("SELECT playbackUUIDRaw AS uuid FROM Playback WHERE displayTitle='Synthetic copy'")[0].uuid;
  assert.equal(profile(app).absent[copy], undefined);
  call(app, "setCellMove", FIRST, ids.secondGroup);
  app.window.confirm = () => true;
  await app.run("commitChanges()");
  assert.equal(profile(app).absent[FIRST], true);
  assert.equal(call(app, "lineupPlaybackReason", FIRST), "");
  await call(app, "setTabLayout", ids.secondGroup, "lineup");
  assert.match(call(app, "lineupPlaybackReason", FIRST), /absent/);
});

test("absent activation is rejected before it can cancel fades, idle checks or current intent", async t => {
  const app = await lineupApp(t);
  const requests = installPlaybackRecorder(app);
  await call(app, "setTabLayout", GROUP, "lineup");
  await call(app, "setPlayerPresent", FIRST, false);
  app.window.testCell = cell(app);
  app.run("window.retrySnapshot = window.testCell.cloneNode(true)");
  const generation = app.run("transportGeneration");
  const fade = app.run("fadeGen");
  const idle = app.run("idleGeneration");
  assert.equal(await app.run("startPlayback(window.retrySnapshot)"), false);
  assert.equal(await app.run("smartSingleTap(window.testCell)"), false);
  assert.equal(app.run("transportGeneration"), generation);
  assert.equal(app.run("fadeGen"), fade);
  assert.equal(app.run("idleGeneration"), idle);
  assert.deepEqual(requests, []);
  await call(app, "setTabLayout", GROUP, "standard");
  assert.equal(profile(app).absent[FIRST], true);
  assert.equal(await app.run("startPlayback(document.querySelector('#grid .cell'))"), true);
});

test("marking the playing player absent preserves progress and end cues but blocks a later off-tab Resume", async t => {
  const app = await lineupApp(t);
  const requests = installPlaybackRecorder(app);
  await call(app, "setTabLayout", GROUP, "lineup");
  app.run("setNowPlaying(document.querySelector('#grid .cell'))");
  const progress = app.run("progress");
  const deadline = app.run("stopDeadlineTimer");
  const fade = app.run("fadeGen");
  await call(app, "setPlayerPresent", FIRST, false);
  assert.equal(app.run("progress"), progress);
  assert.equal(app.run("stopDeadlineTimer"), deadline);
  assert.equal(app.run("fadeGen"), fade);
  assert.equal(app.run("nowPlaying.paused"), false);
  assert.deepEqual(requests, []);
  assert.equal(await app.run("pausePlayback()"), true);
  const pausedPosition = app.run("currentPositionMs()");
  app.run("activeTabIdx = 1; renderTabs(); renderGrid()");
  assert.equal(await app.run("resumePlayback()"), false);
  assert.equal(app.run("currentPositionMs()"), pausedPosition);
  assert.equal(app.window.document.getElementById("np-pause").disabled, true);
  assert.deepEqual(requests.map(request => request.path), ["/me/player/pause"]);
  await call(app, "setTabLayout", GROUP, "standard");
  assert.equal(await app.run("resumePlayback()"), true);
  assert.equal(app.run("nowPlaying.paused"), false);
});

test("an absent player's Pause keeps eligible iPad silence alive while blocking Resume", async t => {
  const app = await lineupApp(t);
  await call(app, "setTabLayout", GROUP, "lineup");
  const silence = app.run("IDLE_SILENCE_TRACK");
  const device = { id: "synthetic-ipad", name: "Synthetic iPad", is_active: true, is_restricted: false, supports_volume: false };
  const state = {
    device, repeat_state: "off", is_playing: true, progress_ms: 12000,
    item: { id: "synthetic-track-0", duration_ms: 123456 },
  };
  const requests = [];
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
  app.window.idleDevice = device;
  app.window.idleApi = async (url, options = {}, current) => {
    if (current && !current()) throw new Error("Synthetic request superseded");
    const path = url.split("?")[0];
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, body });
    if (path === "/me/player/devices") return { devices: [device] };
    if (path === "/me/player" && !options.method) return structuredClone(state);
    if (path === `/tracks/${silence}`) return { id: silence, duration_ms: 600000, is_playable: true };
    if (path === "/me/player/pause") { state.is_playing = false; return null; }
    if (path === "/me/player/play") {
      state.item = { id: body.uris[0].split(":").at(-1), duration_ms: 600000 };
      state.progress_ms = body.position_ms;
      state.is_playing = true;
      return null;
    }
    throw new Error("Unexpected synthetic idle request");
  };
  app.run(`api = (...args) => window.idleApi(...args); ensureDevice = async () => window.idleDevice.id;
    activeDeviceId = window.idleDevice.id; activeDeviceCapabilities = window.idleDevice;
    trackPlayedOn = false; idleReady = true; setNowPlaying(document.querySelector('#grid .cell'));
    progress.startOffsetMs = 12000; progress.baseTime = performance.now();
  `);
  await call(app, "setPlayerPresent", FIRST, false);
  assert.equal(await app.run("pausePlayback()"), true);
  assert.equal(app.run("nowPlaying.paused"), true);
  assert.equal(app.run("idleResume.uuid"), FIRST);
  assert.equal(state.item.id, silence);
  const count = requests.length;
  const position = app.run("currentPositionMs()");
  const deadline = app.run("idleNextCheckAt");
  assert.equal(await app.run("resumePlayback()"), false);
  assert.equal(requests.length, count);
  assert.equal(app.run("idleNextCheckAt"), deadline);
  assert.equal(app.run("currentPositionMs()"), position);
  await call(app, "setTabLayout", GROUP, "standard");
  assert.equal(requests.length, count);
  assert.equal(await app.run("resumePlayback()"), true);
  assert.deepEqual(requests.at(-1).body, { uris: ["spotify:track:synthetic-track-0"], position_ms: Math.round(position) });
  assert.equal(requests.some(request => /repeat|queue|volume/.test(request.path)), false);
});

test("a paused absent player's seek or end-cue preview cannot seek the idle audio", async t => {
  const app = await lineupApp(t);
  const requests = installPlaybackRecorder(app);
  await call(app, "setTabLayout", GROUP, "lineup");
  app.run("setNowPlaying(document.querySelector('#grid .cell')); setPlaybackPaused(true)");
  await call(app, "setPlayerPresent", FIRST, false);
  const position = app.run("currentPositionMs()");
  const generation = app.run("transportGeneration");
  assert.equal(await app.run("seekTo(20000, true)"), false);
  await app.run("setStopFromBar(60000)");
  assert.equal(app.run(`pending.stops['${FIRST}']`), 60000);
  assert.equal(app.run("currentPositionMs()"), position);
  assert.equal(app.run("transportGeneration"), generation);
  assert.deepEqual(requests, []);
});

for (const mode of ["start", "stop"]) {
  test(`${mode} cue edits remain saved when attendance blocks preview, and can be previewed after marking present`, async t => {
    const app = await lineupApp(t);
    const requests = installPlaybackRecorder(app);
    await call(app, "setTabLayout", GROUP, "lineup");
    app.run("setNowPlaying(document.querySelector('#grid .cell')); setPlaybackPaused(true)");
    await call(app, "setPlayerPresent", FIRST, false);
    call(app, "showCueFine", 10000, mode);
    await app.run("applyCueFine(1000)");
    assert.equal(app.run(`pending.${mode === "start" ? "starts" : "stops"}['${FIRST}']`), 11000);
    assert.equal(app.run("cueFineLastSeek"), null);
    assert.deepEqual(requests, []);
    await call(app, "setPlayerPresent", FIRST, true);
    await app.run("applyCueFine(1000)");
    assert.equal(requests.length, 2);
    assert.match(requests[0].path, /\/me\/player\/play/);
    assert.equal(requests[1].path, `/me/player/seek?position_ms=${mode === "start" ? 11000 : 7000}`);
    assert.equal(app.run("nowPlaying.paused"), false);
  });
}

for (const operation of ["start", "resume"]) {
  for (const volumeSupported of [false, true]) {
    test(`${operation} rechecks attendance after token delay before any ${volumeSupported ? "volume or play" : "play"} command`, async t => {
      const app = await lineupApp(t);
      await call(app, "setTabLayout", GROUP, "lineup");
      const requests = [];
      const entered = deferred(), release = deferred();
      app.window.testToken = () => { entered.resolve(); return release.promise; };
      app.window.fetch = async (url, options) => {
        requests.push({ url, method: options.method });
        return { ok: true, status: 204 };
      };
      app.run(`ensureDevice = async () => "synthetic-device"; getAccessToken = window.testToken;
        activeDeviceCapabilities = { supports_volume: ${volumeSupported} }; trackPlayedOn = false;
        window.testCell = document.querySelector('#grid .cell');
      `);
      if (operation === "resume") app.run("setNowPlaying(window.testCell); setPlaybackPaused(true); progress.stopFiring = true");
      const command = app.run(operation === "start" ? "startPlayback(window.testCell)" : "resumePlayback()");
      await entered.promise;
      await call(app, "setPlayerPresent", FIRST, false);
      release.resolve("synthetic-access");
      assert.equal(await command, false);
      assert.deepEqual(requests, []);
      assert.equal(app.run("idleBlocked"), false);
      if (operation === "resume") assert.equal(app.run("nowPlaying.paused"), true);
      else assert.equal(app.run("nowPlaying"), null);
    });
  }
}
