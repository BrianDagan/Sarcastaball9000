const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, deferred } = require("./helpers/app.cjs");

function player(t, stop = 30000) {
  const app = createApp();
  t.after(app.close);
  const cell = app.window.document.createElement("button");
  cell.className = "cell";
  Object.assign(cell.dataset, {
    pbuuid: "synthetic-playback",
    trackid: "synthetic-track",
    startms: "0",
    stopms: String(stop),
    duration: "60000",
    fadein: "0",
    fadeout: "2",
    volume: "0.4",
  });
  cell.innerHTML = '<span class="title">Synthetic track</span><span class="meta">Synthetic artist</span>';
  app.window.document.getElementById("grid").appendChild(cell);
  app.window.testCell = cell;
  app.window.testApi = async () => null;
  app.run("api = (...args) => window.testApi(...args); ensureDevice = async () => 'synthetic-device'; trackPlayedOn = false; activeDeviceCapabilities = { supports_volume: true };");
  return app;
}

function playbackState(isPlaying) {
  return {
    is_playing: isPlaying,
    progress_ms: 1000,
    item: { id: "synthetic-track" },
    device: { id: "synthetic-device", supports_volume: true },
    actions: { disallows: { [isPlaying ? "resuming" : "pausing"]: true, seeking: true } },
  };
}

for (const initiallyPlaying of [true, false]) {
  test(`repeated toggles invalidate old restrictions starting ${initiallyPlaying ? "playing" : "paused"}`, async t => {
    const app = player(t);
    let isPlaying = initiallyPlaying;
    let commands = 0;
    app.window.testApi = async (path, options = {}) => {
      if (!options.method) return playbackState(isPlaying);
      commands++;
      isPlaying = path !== "/me/player/pause";
      return null;
    };
    app.run("setNowPlaying(window.testCell)");
    for (let toggle = 0; toggle < 8; toggle++) {
      if (toggle % 3 === 0) assert.equal(await app.run("reconcilePlayback()"), true);
      const shouldPause = isPlaying;
      assert.equal(await app.run(shouldPause ? "pausePlayback()" : "resumePlayback()"), true);
      assert.equal(app.run("nowPlaying.paused"), shouldPause);
      assert.equal(app.run("progress.paused"), shouldPause);
      assert.equal(app.run("!!nowPlaying.disallows.pausing || !!nowPlaying.disallows.resuming"), false);
      assert.equal(app.run("nowPlaying.disallows.seeking"), true);
      assert.equal(app.window.document.getElementById("transport-status").classList.contains("hidden"), true);
      assert.equal(commands, toggle + 1);
    }
  });
}

test("a delayed pre-pause poll cannot restore obsolete toggle restrictions", async t => {
  const app = player(t);
  app.window.testApi = async () => playbackState(true);
  app.run("setNowPlaying(window.testCell)");
  await app.run("reconcilePlayback()");
  const entered = deferred();
  const late = deferred();
  app.window.testApi = async (path, options = {}) => {
    if (!options.method) { entered.resolve(); return late.promise; }
    return null;
  };
  const poll = app.run("reconcilePlayback()");
  await entered.promise;
  assert.equal(await app.run("pausePlayback()"), true);
  late.resolve(playbackState(true));
  assert.equal(await poll, false);
  assert.equal(app.run("nowPlaying.paused"), true);
  assert.equal(await app.run("resumePlayback()"), true);
  assert.equal(app.run("nowPlaying.paused"), false);
});

test("a rejected pause preserves the current state and restriction snapshot", async t => {
  const app = player(t);
  app.window.testApi = async () => playbackState(true);
  app.run("setNowPlaying(window.testCell)");
  await app.run("reconcilePlayback()");
  app.run("api = async () => { throw new SpotifyError(403, 'RESTRICTION_VIOLATED', null); }");
  assert.equal(await app.run("pausePlayback()"), false);
  assert.equal(app.run("nowPlaying.paused"), false);
  assert.equal(app.run("progress.paused"), false);
  assert.equal(app.run("nowPlaying.disallows.resuming"), true);
  assert.equal(app.run("nowPlaying.disallows.seeking"), true);
  const status = app.window.document.getElementById("transport-status");
  assert.equal(status.classList.contains("hidden"), false);
  assert.match(status.textContent, /Pause was not confirmed.*Spotify 403/);
});

test("off-tab playback retains cue, volume and fade configuration", t => {
  const app = player(t);
  app.run("setNowPlaying(window.testCell)");
  app.window.testCell.remove();
  assert.equal(app.run("effectiveStopMs(nowPlaying.uuid)"), 30000);
  assert.equal(app.run("cellEffectiveVolumePct(nowPlaying.uuid)"), 40);
  assert.equal(app.run("effectiveFadeOutSec(null)"), 2);
});

test("Stop follows an already-sent Start and stale Start cannot restore UI", async t => {
  const app = player(t);
  const play = deferred();
  const entered = deferred();
  const paths = [];
  app.window.testApi = async path => {
    paths.push(path);
    if (path.startsWith("/me/player/play?")) { entered.resolve(); return play.promise; }
    return null;
  };
  const start = app.run("startPlayback(window.testCell)");
  await entered.promise;
  const stop = app.run("stopPlayback()");
  play.resolve(null);
  assert.equal(await start, false);
  assert.equal(await stop, true);
  assert.equal(paths.at(-1), "/me/player/pause");
  assert.equal(app.run("nowPlaying"), null);
});

test("Stop cancels Start while device selection is still pending", async t => {
  const app = player(t);
  const device = deferred();
  const entered = deferred();
  const paths = [];
  app.window.device = () => { entered.resolve(); return device.promise; };
  app.window.testApi = async path => { paths.push(path); return null; };
  app.run("ensureDevice = window.device");
  const start = app.run("startPlayback(window.testCell)");
  await entered.promise;
  const stop = app.run("stopPlayback()");
  device.resolve("synthetic-device");
  await Promise.all([start, stop]);
  assert.deepEqual(paths, ["/me/player/pause"]);
});

test("failed pause keeps playback live and displays persistent retry", async t => {
  const app = player(t);
  app.run("setNowPlaying(window.testCell)");
  app.window.testApi = async () => { throw new Error("Synthetic network failure"); };
  assert.equal(await app.run("pausePlayback()"), false);
  assert.equal(app.run("nowPlaying.paused"), false);
  assert.equal(app.run("progress.paused"), false);
  const status = app.window.document.getElementById("transport-status");
  assert.equal(status.classList.contains("hidden"), false);
  assert.match(status.textContent, /Pause was not confirmed/);
  assert.ok(status.querySelector("button"));
});

test("failed seek does not move the local clock", async t => {
  const app = player(t);
  app.run("setNowPlaying(window.testCell)");
  app.window.testApi = async () => { throw new Error("Synthetic restriction"); };
  assert.equal(await app.run("seekTo(10000, true)"), false);
  assert.equal(app.run("progress.startOffsetMs"), 0);
});

test("manual volume canceling an end fade cannot cancel its pause deadline", async t => {
  const app = player(t, 100);
  const stopped = deferred();
  app.window.testApi = async path => {
    if (path === "/me/player/pause") stopped.resolve();
    return null;
  };
  app.run("setNowPlaying(window.testCell); renderProgress(); applyRailVolumeLive(80)");
  assert.equal(app.run("progress.stopFiring"), true);
  await Promise.race([
    stopped.promise,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("End stop did not fire")), 2000); timer.unref(); }),
  ]);
  await app.run("transportQueue");
  assert.equal(app.run("nowPlaying"), null);
});

test("logout invalidates queued transport and clears its snapshot", async t => {
  const app = player(t);
  const request = deferred();
  const entered = deferred();
  app.window.testApi = async path => {
    if (path.startsWith("/me/player/play?")) { entered.resolve(); return request.promise; }
    return null;
  };
  const start = app.run("startPlayback(window.testCell)");
  await entered.promise;
  app.run("invalidateTransportWork()");
  request.resolve(null);
  assert.equal(await start, false);
  assert.equal(app.run("nowPlaying"), null);
  assert.equal(app.run("playingSnapshot"), null);
});

test("fade ramp uses elapsed time rather than accumulating request latency", async t => {
  const app = player(t);
  let clock = 0;
  let next = null;
  const volumes = [];
  app.window.performance.now = () => clock;
  app.window.setTimeout = (callback, delay) => { next = { callback, delay }; return 1; };
  app.window.clearTimeout = () => {};
  app.window.testApi = async path => { volumes.push(Number(new URL(path, "http://fixture").searchParams.get("volume_percent"))); return null; };
  app.run("doFade(0, 100, 1000)");
  clock = 900;
  await next.callback();
  assert.equal(volumes[0], 90);
  assert.equal(next.delay, 100);
  clock = 1200;
  await next.callback();
  assert.equal(volumes.at(-1), 100);
});
