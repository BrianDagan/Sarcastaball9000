const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, createOrigin } = require("./helpers/app.cjs");

test("playback diagnostics export only bounded, allowlisted categorical data", async t => {
  const app = createApp();
  t.after(() => app.close());
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({
    clientId: "private-client-value",
    refreshToken: "private-refresh-value",
  }));
  app.window.localStorage.setItem("s9000.deviceId", "private-device-id");
  app.window.localStorage.setItem("s9000.deviceName", "Private iPad Name");
  app.run(`
    window.testDownload = null;
    triggerDownload = (bytes, filename, type) => {
      window.testDownload = { bytes, filename, type };
    };
    recordPlaybackDiagnostic("play-failed", {
      purpose: "silence",
      status: 404,
      reason: "NO_ACTIVE_DEVICE",
      token: "private-token-value",
      clientId: "private-client-value",
      deviceId: "private-device-id",
      deviceName: "Private iPad Name",
      trackId: "private-track-id",
      rawResponse: "private-provider-response",
      source: "private-person-name",
    });
    recordPlaybackDiagnostic("private-person-name", { status: 200 });
  `);
  await app.run("playbackDiagnosticPersistQueue");
  const report = await app.run("downloadPlaybackDiagnostics()");
  const download = app.window.testDownload;
  const serialized = download.bytes;

  assert.equal(download.type, "application/json");
  assert.match(download.filename, /^Sarcastaball-playback-diagnostics-\d{8}T\d{6}Z\.json$/);
  assert.deepEqual(JSON.parse(serialized), JSON.parse(JSON.stringify(report)));
  for (const privateValue of [
    "private-token-value",
    "private-client-value",
    "private-refresh-value",
    "private-device-id",
    "Private iPad Name",
    "private-track-id",
    "private-provider-response",
    "private-person-name",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.deepEqual(Object.keys(report.events.at(-1)).sort(), [
    "at", "event", "id", "purpose", "reason", "status",
  ]);
  assert.equal(report.events.at(-1).reason, "NO_ACTIVE_DEVICE");
  assert.equal(report.events.length, 1);
  assert.equal(app.run(`
    mergePlaybackDiagnostics(Array.from({ length: 405 }, (_, index) => ({
      id: String(index), at: new Date(1700000000000 + index).toISOString(), event: "bounded"
    }))).length
  `), 400);
});

test("playback diagnostics persist across reloads without exporting unrecognized stored fields", async t => {
  const origin = createOrigin();
  const first = createApp({ origin });
  first.run(`recordPlaybackDiagnostic("idle-confirmation", {
    source: "pause", outcome: "confirmed", deviceActive: true, deviceName: "Private iPad"
  })`);
  await first.run("playbackDiagnosticPersistQueue");
  first.close();

  const second = createApp({ origin });
  t.after(() => second.close());
  const events = second.run("storedPlaybackDiagnostics()");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "idle-confirmation");
  assert.equal(events[0].source, "pause");
  assert.equal(events[0].outcome, "confirmed");
  assert.equal(events[0].deviceActive, true);
  assert.equal("deviceName" in events[0], false);
});

test("Spotify wake diagnostics retain only allowlisted lifecycle categories", async t => {
  const app = createApp();
  t.after(() => app.close());
  app.run(`recordPlaybackDiagnostic("spotify-wake", {
    source: "scheduled",
    stage: "request",
    destination: "https://open.spotify.com/track/private-value",
    deviceName: "Private iPad"
  })`);
  await app.run("playbackDiagnosticPersistQueue");

  const exported = app.run("createPlaybackDiagnosticExport()");
  assert.deepEqual(Object.keys(exported.report.events[0]).sort(), [
    "at", "event", "id", "source", "stage",
  ]);
  assert.equal(exported.report.events[0].event, "spotify-wake");
  assert.equal(exported.report.events[0].source, "scheduled");
  assert.equal(exported.report.events[0].stage, "request");
  assert.equal(exported.text.includes("private-value"), false);
  assert.equal(exported.text.includes("Private iPad"), false);
});

test("stale diagnostic writers cannot recreate storage after cleanup invalidates them", async t => {
  const app = createApp();
  t.after(() => app.close());
  app.run(`
    recordPlaybackDiagnostic("idle-check-start", { source: "scheduled" });
    playbackDiagnosticGeneration++;
    playbackDiagnosticBuffer = [];
    localStorage.removeItem(LS_PLAYBACK_DIAGNOSTICS);
  `);
  await app.run("playbackDiagnosticPersistQueue");
  assert.equal(app.window.localStorage.getItem("s9000.playbackDiagnostics"), null);
});

test("diagnostic persistence failure keeps an in-memory export without blocking playback data", async t => {
  const origin = createOrigin();
  origin.failure = (operation, key) =>
    operation === "write" && key === "s9000.playbackDiagnostics";
  const app = createApp({ origin });
  t.after(() => app.close());
  app.run(`
    triggerDownload = () => {};
    recordPlaybackDiagnostic("idle-failed", {
      source: "scheduled", errorKind: "application", status: 0
    });
  `);
  await app.run("playbackDiagnosticPersistQueue");
  const report = app.run("downloadPlaybackDiagnostics()");
  assert.equal(report.runtime.persistenceComplete, false);
  assert.equal(report.events.some(event => event.event === "idle-failed"), true);
  assert.equal(app.run("playbackDiagnosticBuffer.length"), 1);
});
