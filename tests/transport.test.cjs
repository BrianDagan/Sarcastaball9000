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

for (const [device, userAgent, platform, maxTouchPoints] of [
  ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1", "iPhone", 5],
  ["iPad", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1", "iPad", 5],
  ["desktop-mode iPad", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15", "MacIntel", 5],
]) {
  test(`${device} suppresses every volume path without disabling playback`, async t => {
    const app = player(t);
    Object.defineProperties(app.window.navigator, {
      userAgent: { value: userAgent, configurable: true },
      platform: { value: platform, configurable: true },
      maxTouchPoints: { value: maxTouchPoints, configurable: true },
    });
    const paths = [];
    app.window.testApi = async path => { paths.push(path); return null; };
    app.run("window.testCell.dataset.fadein = '2'; localStorage.setItem(LS_VOLUME, '35')");
    assert.equal(await app.run("startPlayback(window.testCell)"), true);
    assert.equal(app.window.document.getElementById("vol-rail").classList.contains("hidden"), true);
    assert.equal(app.window.document.body.classList.contains("vol-open"), false);
    app.run("showCueFine(0); wireVolRail(); applyRailVolumeLive(80); applyVolumeFine(80)");
    assert.equal(app.window.document.getElementById("np-volume-row").classList.contains("hidden"), true);
    assert.equal(await app.run("sendVolume(80)"), false);
    assert.equal(await app.run("setVolume(80)"), false);
    await app.run("fadeOut()");
    await app.run("fadeIn()");
    app.run("doFade(0, 100, 1000)");
    assert.equal(app.run("fadeTimer"), null);
    assert.equal(await app.run("pausePlayback()"), true);
    app.run("progress.stopFiring = true");
    assert.equal(await app.run("resumePlayback()"), true);
    assert.equal(await app.run("seekTo(1000, true)"), true);
    app.run("startConfetti = () => {}");
    await app.run("playFakeBeer()");
    await app.run("transportQueue");
    assert.equal(paths.some(path => path.startsWith("/me/player/volume")), false);
    assert.ok(paths.some(path => path.startsWith("/me/player/play")));
    assert.ok(paths.includes("/me/player/pause"));
    assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
    assert.equal(app.run("Object.keys(pending.volumes).length"), 0);
    assert.doesNotMatch(app.window.document.getElementById("toast")?.textContent || "", /physical or Spotify volume/i);
    assert.equal(app.window.document.getElementById("transport-status").classList.contains("hidden"), true);
  });
}

for (const [device, platform, userAgent, maxTouchPoints] of [
  ["Windows touch device", "Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36", 10],
  ["Mac", "MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15", 0],
  ["Android", "Linux aarch64", "Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36", 5],
]) {
  test(`${device} retains supported volume control`, async t => {
    const app = player(t);
    Object.defineProperties(app.window.navigator, {
      userAgent: { value: userAgent, configurable: true },
      platform: { value: platform, configurable: true },
      maxTouchPoints: { value: maxTouchPoints, configurable: true },
    });
    const paths = [];
    app.window.testApi = async path => { paths.push(path); return null; };
    assert.equal(await app.run("startPlayback(window.testCell)"), true);
    assert.ok(paths.some(path => path.startsWith("/me/player/volume")));
    assert.equal(app.window.document.getElementById("vol-rail").classList.contains("hidden"), false);
  });
}

test("losing volume support hides controls, cancels ramps and preserves saved values", t => {
  const app = player(t);
  app.run("setNowPlaying(window.testCell); showCueFine(0); localStorage.setItem(LS_VOLUME, '35'); pending.volumes['synthetic-playback'] = 0.6; doFade(40, 0, 10000)");
  app.window.document.getElementById("vol-rail-slider").focus();
  app.run("activeDeviceCapabilities = { supports_volume: false }; updateVolumeControls()");
  assert.equal(app.run("fadeTimer"), null);
  assert.equal(app.window.document.getElementById("vol-rail").classList.contains("hidden"), true);
  assert.equal(app.window.document.getElementById("in-volume").disabled, true);
  assert.equal(app.window.document.activeElement.id, "np-pause");
  assert.equal(app.run("pending.volumes['synthetic-playback']"), 0.6);
  assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
  app.run("activeDeviceCapabilities = { supports_volume: true }; updateVolumeControls()");
  assert.equal(app.window.document.getElementById("vol-rail").classList.contains("hidden"), false);
  assert.equal(app.window.document.getElementById("in-volume").disabled, false);
});

test("unsupported volume never prevents the mandatory end-cue pause", async t => {
  const app = player(t, 100);
  const stopped = deferred();
  const paths = [];
  app.window.testApi = async path => {
    paths.push(path);
    if (path === "/me/player/pause") stopped.resolve();
    return null;
  };
  app.run("activeDeviceCapabilities = { supports_volume: false }; setNowPlaying(window.testCell); renderProgress()");
  await Promise.race([
    stopped.promise,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("End cue did not stop playback")), 2000); timer.unref(); }),
  ]);
  await app.run("transportQueue");
  assert.deepEqual(paths, ["/me/player/pause"]);
  assert.equal(app.run("nowPlaying"), null);
});

for (const restriction of ["supports_volume: false", "supports_volume: true, is_restricted: true"]) {
  test(`volume capability is rechecked after awaiting a token: ${restriction}`, async t => {
    const app = createApp();
    t.after(app.close);
    const entered = deferred();
    const token = deferred();
    app.window.testToken = () => { entered.resolve(); return token.promise; };
    app.run("activeDeviceCapabilities = { supports_volume: true }; getAccessToken = window.testToken");
    const volume = app.run("setVolume(50)");
    await entered.promise;
    app.run(`activeDeviceCapabilities = { ${restriction} }; updateVolumeControls()`);
    token.resolve("synthetic-access");
    assert.equal(await volume, false);
    assert.equal(app.window.document.getElementById("transport-status").classList.contains("hidden"), true);
  });
}

test("a real failure on a volume-capable device remains visible", async t => {
  const app = player(t);
  app.window.testApi = async () => { throw new Error("Synthetic volume request failure"); };
  assert.equal(await app.run("setVolume(50)"), false);
  const status = app.window.document.getElementById("transport-status");
  assert.equal(status.classList.contains("hidden"), false);
  assert.match(status.textContent, /Volume was not confirmed/);
});

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
