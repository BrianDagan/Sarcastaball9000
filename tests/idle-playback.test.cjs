const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, deferred } = require("./helpers/app.cjs");

const SILENCE = "3mkOlbSv5RYadx0JsjTrKq";

function controller(t, name = "Synthetic iPad") {
  const app = createApp();
  t.after(async () => {
    app.run("idleReady = false; cancelIdleCheck()");
    await app.run("transportQueue");
    app.close();
  });
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({
    clientId: "synthetic-client", refreshToken: "synthetic-refresh",
  }));
  const backend = {
    device: { id: "synthetic-device", name, is_active: true, supports_volume: false },
    state: { item: { id: "synthetic-song", duration_ms: 180000 }, progress_ms: 12000, is_playing: false, repeat_state: "off" },
    requests: [],
    devices: null,
    duration: 600000,
    silence: {
      id: SILENCE,
      uri: `spotify:track:${SILENCE}`,
      album: { uri: "spotify:album:synthetic-silence" },
    },
    beforeRequest: null,
    leavePauseStateStale: false,
    pendingPauseState: false,
  };
  app.window.testApi = async (url, options = {}) => {
    const request = { path: url.split("?")[0], url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    backend.requests.push(request);
    if (backend.beforeRequest) await backend.beforeRequest(request);
    if (request.path === "/me/player/devices") return { devices: backend.devices || [backend.device] };
    if (request.path === "/me/player" && request.method === "GET") {
      const state = structuredClone({ ...backend.state, device: backend.device });
      if (backend.pendingPauseState) {
        backend.pendingPauseState = false;
        backend.state.is_playing = false;
      }
      return state;
    }
    if (request.path === `/tracks/${SILENCE}`) {
      return { ...backend.silence, duration_ms: backend.duration, is_playable: true };
    }
    if (request.path === "/me/player/play") {
      const uri = request.body?.uris?.[0] || request.body?.offset?.uri;
      if (uri) {
        const id = uri.split(":").at(-1);
        const silence = id === backend.silence.id || id === SILENCE;
        backend.state.item = {
          id,
          duration_ms: silence ? backend.duration : 180000,
          ...(silence && backend.silence.linked_from ? { linked_from: backend.silence.linked_from } : {}),
        };
        backend.state.progress_ms = request.body.position_ms || 0;
      }
      backend.state.is_playing = true;
      return null;
    }
    if (request.path === "/me/player/pause") {
      if (backend.leavePauseStateStale) backend.pendingPauseState = true;
      else backend.state.is_playing = false;
      return null;
    }
    if (request.path === "/me/player/seek") return null;
    throw new Error("Unexpected synthetic request");
  };
  app.window.testDevice = backend.device;
  app.run(`
    api = (...args) => window.testApi(...args);
    activeDeviceId = "synthetic-device";
    activeDeviceCapabilities = window.testDevice;
    trackPlayedOn = false;
    trackPlaybackContexts.set("synthetic-song", {
      requestedTrackId: "synthetic-song", resolvedTrackId: "synthetic-song",
      trackUri: "spotify:track:synthetic-song", albumUri: null, durationMs: 180000,
    });
  `);
  app.backend = backend;
  app.plays = () => backend.requests.filter(request => request.path === "/me/player/play");
  app.tile = () => app.run(`
    window.testTile = document.createElement("button");
    window.testTile.className = "cell";
    Object.assign(window.testTile.dataset, { pbuuid: "synthetic-playback", trackid: "synthetic-song", startms: "0", stopms: "180000", duration: "180000", volume: "-1", fadein: "0", fadeout: "0" });
    window.testTile.innerHTML = '<span class="title">Synthetic song</span><span class="meta">Synthetic artist</span>';
    document.getElementById("grid").appendChild(window.testTile);
    setNowPlaying(window.testTile);
    progress.startOffsetMs = 12000;
    progress.baseTime = performance.now();
  `);
  return app;
}

function installIdleClock(app) {
  let now = 0, sequence = 0;
  const timers = new Map();
  app.window.performance.now = () => now;
  app.window.setTimeout = (callback, delay = 0) => {
    const id = ++sequence;
    timers.set(id, { callback, at: now + Math.max(0, delay) });
    return id;
  };
  app.window.clearTimeout = id => timers.delete(id);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    get now() { return now; },
    wait(milliseconds) { return new Promise(resolve => app.window.setTimeout(resolve, milliseconds)); },
    async advance(milliseconds) {
      const end = now + milliseconds;
      await settle();
      for (let steps = 0; steps < 10000; steps++) {
        const next = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) {
          now = end;
          await settle();
          return;
        }
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      throw new Error("Synthetic idle timer loop did not settle");
    },
  };
}

for (const [getLatency, pausedTile] of [[0, false], [3000, false], [7000, false], [14000, false], [7000, true], [14000, true]]) {
  test(`automatic renewal keeps silence alive for three cycles with ${getLatency}ms read latency${pausedTile ? " and a paused tile" : ""}`, async t => {
    const app = controller(t);
    const clock = installIdleClock(app);
    if (pausedTile) {
      app.tile();
      app.run("setPlaybackPaused(true)");
    }
    let startedAt = null;
    let naturalEnds = 0;
    let checks = 0;
    const durationsBeforeRestart = [];
    app.window.testApi = async (url, options = {}, current) => {
      assert.ok(!current || current());
      const request = { path: url.split("?")[0], method: options.method || "GET" };
      app.backend.requests.push(request);
      const elapsed = startedAt === null ? 0 : clock.now - startedAt;
      if (startedAt !== null && elapsed >= app.backend.duration) {
        naturalEnds++;
        startedAt = null;
      }
      if (request.path === "/me/player/devices") {
        await clock.wait(getLatency);
        return { devices: naturalEnds ? [] : [app.backend.device] };
      }
      if (request.path === "/me/player" && request.method === "GET") {
        const state = naturalEnds ? null : {
          device: app.backend.device,
          item: { id: startedAt === null ? "synthetic-song" : SILENCE, duration_ms: startedAt === null ? 180000 : app.backend.duration },
          is_playing: startedAt !== null, repeat_state: "off", progress_ms: startedAt === null ? 12000 : elapsed,
        };
        checks++;
        await clock.wait(getLatency);
        return state;
      }
      if (request.path === `/tracks/${SILENCE}`) {
        await clock.wait(getLatency);
        return {
          id: SILENCE,
          uri: `spotify:track:${SILENCE}`,
          album: { uri: "spotify:album:synthetic-silence" },
          duration_ms: app.backend.duration,
          is_playable: true,
        };
      }
      assert.equal(request.path, "/me/player/play");
      assert.equal(request.method, "PUT");
      assert.deepEqual(JSON.parse(options.body), {
        context_uri: "spotify:album:synthetic-silence",
        offset: { uri: `spotify:track:${SILENCE}` },
        position_ms: 0,
      });
      await clock.wait(2000);
      if (startedAt !== null) durationsBeforeRestart.push(clock.now - startedAt);
      startedAt = clock.now;
      return null;
    };
    app.run("idleReady = true; void checkIdlePlayback()");
    await clock.advance(3 * 600000 + 60000);
    if (pausedTile) {
      assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
      assert.equal(app.run("nowPlaying.paused"), true);
      assert.equal(app.run("currentPositionMs()"), 12000);
    }
    app.run("idleReady = false; cancelIdleCheck(); setNowPlaying(null)");
    await clock.advance(30000);
    await app.run("transportQueue");
    assert.equal(naturalEnds, 0, "The silence track must be renewed before its natural end");
    assert.ok(durationsBeforeRestart.length >= 3, "The automatic timer, not a manual probe, must renew each cycle");
    for (const duration of durationsBeforeRestart) {
      assert.ok(duration >= 500000 && duration < 590000, `Restart after ${duration}ms must leave network headroom`);
    }
    assert.ok(checks < 60, "Renewal must not become a high-frequency polling loop");
    assert.equal(app.run("idleBlocked"), false);
    assert.equal(app.backend.requests.some(request => /repeat|queue|volume/.test(request.path)), false);
  });
}

test("default idle behavior starts only on a freshly available selected iPad device", async t => {
  const app = controller(t, "Synthetic IPAD");
  assert.equal(await app.run("checkIdlePlayback()"), true);
  assert.equal(app.plays().length, 1);
  assert.deepEqual(app.plays()[0].body, {
    context_uri: "spotify:album:synthetic-silence",
    offset: { uri: `spotify:track:${SILENCE}` },
    position_ms: 0,
  });
  assert.match(app.plays()[0].url, /device_id=synthetic-device/);
  assert.equal(app.run("nowPlaying"), null);
  assert.equal(app.window.document.getElementById("keepalive-ball").classList.contains("spinning"), true);
  assert.equal(app.window.document.getElementById("keepalive-ball").classList.contains("hidden"), false);
  assert.equal(app.run("pendingCount()"), 0);
  assert.equal(app.backend.requests.some(request => /volume|repeat/.test(request.path)), false);
});

test("Pause waits for Spotify's prior pause command before starting silence", async t => {
  const app = controller(t);
  app.tile();
  app.backend.state.is_playing = true;
  app.backend.leavePauseStateStale = true;

  assert.equal(await app.run("pausePlayback()"), true);
  const requests = app.backend.requests;
  const playIndex = requests.findIndex(request => request.path === "/me/player/play");
  const stateIndexes = requests
    .map((request, index) => request.path === "/me/player" && request.method === "GET" ? index : -1)
    .filter(index => index >= 0);
  assert.ok(stateIndexes.length >= 3);
  assert.ok(playIndex > stateIndexes[1], "silence must wait for a fresh paused state");
  assert.equal(app.run(`
    playbackDiagnosticBuffer.some(entry =>
      entry.event === "idle-state-read" && entry.stage === "pause-settle")
  `), true);
});

test("zero reported iPad volume blocks futile silence requests with a physical-volume instruction", async t => {
  const app = controller(t);
  app.backend.device.volume_percent = 0;

  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(app.plays().length, 0);
  assert.match(app.run("idleFailure"), /volume at 0/i);
  assert.match(app.run("idleFailure"), /one notch/i);
  assert.equal(app.run(`
    playbackDiagnosticBuffer.some(entry =>
      entry.event === "idle-state-read" && entry.volumePercent === 0)
  `), true);
});

test("idle silence plays Spotify's market-relinked URI instead of the unavailable original", async t => {
  const app = controller(t);
  const resolved = "synthetic-market-silence";
  app.backend.silence = {
    id: resolved,
    uri: `spotify:track:${resolved}`,
    album: { uri: "spotify:album:synthetic-silence" },
    linked_from: { id: SILENCE },
  };

  assert.equal(await app.run("checkIdlePlayback()"), true);
  const metadata = app.backend.requests.find(request => request.path === `/tracks/${SILENCE}`);
  assert.match(metadata.url, /market=from_token/);
  assert.deepEqual(app.plays()[0].body, {
    context_uri: "spotify:album:synthetic-silence",
    offset: { uri: `spotify:track:${resolved}` },
    position_ms: 0,
  });
  assert.equal(app.run("idleTrack.id"), resolved);
  assert.equal(app.run("idlePlayback.deviceId"), "synthetic-device");
  await app.run("playbackDiagnosticPersistQueue");
  assert.equal(app.run(`
    playbackDiagnosticBuffer.some(entry =>
      entry.event === "idle-track-metadata" && entry.relinked === true)
  `), true);
});

test("idle silence reactivates the selected iPad and retries once after NO_ACTIVE_DEVICE", async t => {
  const app = controller(t);
  const noActive = app.run("new SpotifyError(404, 'NO_ACTIVE_DEVICE', null)");
  let active = false;
  let playAttempts = 0;
  app.backend.requests.length = 0;
  app.window.testApi = async (url, options = {}, current) => {
    assert.ok(!current || current());
    const request = {
      path: url.split("?")[0], method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : null,
    };
    app.backend.requests.push(request);
    const device = { ...app.backend.device, is_active: active };
    if (request.path === "/me/player/devices") return { devices: [device] };
    if (request.path === "/me/player" && request.method === "GET") {
      return structuredClone({ ...app.backend.state, device });
    }
    if (request.path === `/tracks/${SILENCE}`) {
      return { id: SILENCE, duration_ms: app.backend.duration, is_playable: true };
    }
    if (request.path === "/me/player" && request.method === "PUT") {
      assert.deepEqual(request.body, { device_ids: ["synthetic-device"], play: false });
      active = true;
      return null;
    }
    if (request.path === "/me/player/play") {
      playAttempts++;
      if (playAttempts === 1) throw noActive;
      app.backend.state.item = { id: SILENCE, duration_ms: app.backend.duration };
      app.backend.state.progress_ms = 0;
      app.backend.state.is_playing = true;
      return null;
    }
    throw new Error(`Unexpected synthetic request: ${request.path}`);
  };

  assert.equal(await app.run("checkIdlePlayback()"), true);
  assert.equal(playAttempts, 2);
  assert.equal(app.run("idleFailure"), null);
  assert.equal(app.run("idlePlayback.deviceId"), "synthetic-device");
  assert.deepEqual(app.backend.requests.map(request => `${request.method} ${request.path}`), [
    "GET /me/player/devices",
    "GET /me/player",
    `GET /tracks/${SILENCE}`,
    "GET /me/player",
    "PUT /me/player/play",
    "GET /me/player/devices",
    "GET /me/player",
    "PUT /me/player",
    "PUT /me/player/play",
    "GET /me/player",
  ]);
  assert.equal(app.backend.requests.some(request => /repeat|queue|volume/.test(request.path)), false);
});

test("idle recovery does not retry silence when external music appears during activation", async t => {
  const app = controller(t);
  const noActive = app.run("new SpotifyError(404, 'NO_ACTIVE_DEVICE', null)");
  let active = false;
  let playFailed = false;
  let transfers = 0;
  let playAttempts = 0;
  app.window.testApi = async (url, options = {}, current) => {
    assert.ok(!current || current());
    const path = url.split("?")[0];
    const method = options.method || "GET";
    const selected = { ...app.backend.device, is_active: active };
    if (path === "/me/player/devices") return { devices: [selected] };
    if (path === "/me/player" && method === "GET") {
      if (playFailed) {
        return {
          device: { id: "external-device", name: "Synthetic Laptop" },
          item: { id: "external-song", duration_ms: 250000 },
          progress_ms: 1000, is_playing: true, repeat_state: "off",
        };
      }
      return structuredClone({ ...app.backend.state, device: selected });
    }
    if (path === `/tracks/${SILENCE}`) {
      return { id: SILENCE, duration_ms: app.backend.duration, is_playable: true };
    }
    if (path === "/me/player" && method === "PUT") {
      transfers++;
      active = true;
      return null;
    }
    if (path === "/me/player/play") {
      playAttempts++;
      playFailed = true;
      throw noActive;
    }
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(playAttempts, 1);
  assert.equal(transfers, 0);
  assert.equal(app.run("idlePlayback"), null);
  assert.equal(app.run("idleFailure"), null);
});

for (const name of ["Synthetic iPhone", "Synthetic Laptop", "Synthetic Mac"]) {
  test(`${name} is never eligible, even in an iPad browser`, async t => {
    const app = controller(t, name);
    Object.defineProperty(app.window.navigator, "userAgent", { value: "Mozilla/5.0 (iPad)", configurable: true });
    assert.equal(await app.run("checkIdlePlayback()"), false);
    assert.equal(app.plays().length, 0);
  });
}

test("an unselected active iPad cannot replace the selected laptop", async t => {
  const app = controller(t, "Synthetic Laptop");
  app.backend.devices = [app.backend.device, { id: "other-device", name: "Other iPad", is_active: true }];
  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(app.plays().length, 0);
});

test("already playing music is not interrupted automatically", async t => {
  const app = controller(t);
  app.backend.state.is_playing = true;
  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(app.plays().length, 0);
});

test("an unknown playing state is not treated as permission to start silence", async t => {
  const app = controller(t);
  delete app.backend.state.is_playing;
  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(app.plays().length, 0);
  assert.match(app.window.document.getElementById("ipad-keepalive-status").textContent, /state is unavailable/);
});

test("music started externally during the first metadata fetch is not overwritten", async t => {
  const app = controller(t);
  app.backend.beforeRequest = async request => {
    if (request.path === `/tracks/${SILENCE}`) {
      app.backend.state.item = { id: "external-song", duration_ms: 250000 };
      app.backend.state.is_playing = true;
    }
  };
  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(app.plays().length, 0);
});

for (const repeat of ["track", "context", undefined]) {
  test(`an unsafe or unknown repeat setting fails closed: ${repeat}`, async t => {
    const app = controller(t);
    app.backend.state.repeat_state = repeat;
    assert.equal(await app.run("checkIdlePlayback()"), false);
    assert.equal(app.plays().length, 0);
    assert.match(app.window.document.getElementById("ipad-keepalive-status").textContent, /Turn Repeat off/);
    assert.equal(app.run("idleBlocked"), true);
  });
}

test("Pause preserves the tile position while silence plays and Resume restores that song", async t => {
  const app = controller(t);
  app.tile();
  app.backend.state.is_playing = true;
  app.backend.leavePauseStateStale = true;
  app.run("idleReady = true");
  assert.equal(await app.run("pausePlayback()"), true);
  assert.equal(app.run("nowPlaying.paused"), true);
  assert.equal(app.run("reconcileTimer"), null);
  assert.notEqual(app.run("idleTimer"), null);
  const position = app.run("Math.round(currentPositionMs())");
  assert.equal(app.backend.state.item.id, SILENCE);
  assert.deepEqual(app.backend.requests.map(request => `${request.method} ${request.path}`), [
    "PUT /me/player/pause",
    "GET /me/player/devices",
    `GET /tracks/${SILENCE}`,
    "GET /me/player",
    "GET /me/player",
    "PUT /me/player/play",
    "GET /me/player",
  ]);
  assert.equal(await app.run("reconcilePlayback()"), true);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  assert.equal(app.run("Math.round(currentPositionMs())"), position);
  assert.equal(await app.run("resumePlayback()"), true);
  assert.deepEqual(app.plays().at(-1).body, { uris: ["spotify:track:synthetic-song"], position_ms: position });
  assert.equal(app.run("nowPlaying.paused"), false);
  assert.equal(app.run("idlePlayback"), null);
});

test("an acknowledged silence command cannot spin the ball until Spotify confirms playback", async t => {
  const app = controller(t);
  app.tile();
  app.backend.state.is_playing = true;
  app.backend.leavePauseStateStale = true;
  app.run("idleReady = true");
  const regularApi = app.window.testApi;
  app.window.testApi = async (url, options = {}, current) => {
    const path = url.split("?")[0];
    if (path === "/me/player/play" || (path === "/me/player" && options.method === "PUT")) {
      app.backend.requests.push({
        path,
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });
      return null;
    }
    return regularApi(url, options, current);
  };

  assert.equal(await app.run("pausePlayback()"), true);
  await app.run("playbackDiagnosticPersistQueue");
  assert.equal(app.plays().length, 2, "A success-shaped no-op gets only one bounded transfer and retry");
  assert.equal(app.backend.requests.filter(request =>
    request.path === "/me/player" && request.method === "GET").length, 4);
  assert.equal(app.backend.requests.length, 11);
  assert.equal(app.run("idlePlayback"), null);
  assert.match(app.run("idleFailure"), /acknowledged two silence requests/);
  assert.equal(app.window.document.getElementById("keepalive-ball").classList.contains("spinning"), false);
  assert.equal(app.window.document.getElementById("keepalive-ball").classList.contains("hidden"), true);
  assert.equal(app.run("playbackDiagnosticBuffer.filter(entry => entry.event === 'idle-confirmation' && entry.outcome === 'unconfirmed').length"), 2);
});

test("Pause handoff never replaces a different track that starts before silence", async t => {
  const app = controller(t);
  app.tile();
  app.backend.state.is_playing = true;
  app.backend.leavePauseStateStale = true;
  app.backend.beforeRequest = async request => {
    if (request.path === "/me/player" && request.method === "GET") {
      app.backend.state.item = { id: "external-song", duration_ms: 240000 };
    }
  };

  assert.equal(await app.run("pausePlayback()"), true);
  assert.equal(app.run("nowPlaying.paused"), true);
  assert.equal(app.plays().length, 0);
  assert.equal(app.run("idlePlayback"), null);
});

test("disabling owned silence restores paused-song reconciliation", async t => {
  const app = controller(t);
  app.tile();
  app.backend.state.is_playing = true;
  app.run("idleReady = true");
  assert.equal(await app.run("pausePlayback()"), true);
  assert.equal(app.run("reconcileTimer"), null);

  assert.equal(await app.run("setIdleEnabled(false)"), true);
  assert.equal(app.run("idlePlayback"), null);
  assert.notEqual(app.run("reconcileTimer"), null);
});

test("Stop clears the tile but starts silence; disabling then stops only that silence", async t => {
  const app = controller(t);
  app.tile();
  app.backend.state.is_playing = true;
  app.backend.leavePauseStateStale = true;
  assert.equal(await app.run("stopPlayback()"), true);
  assert.equal(app.run("nowPlaying"), null);
  assert.equal(app.backend.state.item.id, SILENCE);
  assert.deepEqual(app.backend.requests.slice(0, 6).map(request => `${request.method} ${request.path}`), [
    "PUT /me/player/pause",
    "GET /me/player/devices",
    `GET /tracks/${SILENCE}`,
    "GET /me/player",
    "GET /me/player",
    "PUT /me/player/play",
  ]);
  app.backend.leavePauseStateStale = false;
  assert.equal(await app.run("setIdleEnabled(false)"), true);
  assert.equal(app.backend.state.is_playing, false);
  assert.equal(app.window.localStorage.getItem("s9000.ipadKeepAlive"), "0");
  assert.equal(app.run("idlePlayback"), null);
});

test("opting out leaves ordinary Pause and Stop behavior unchanged", async t => {
  const app = controller(t);
  app.window.localStorage.setItem("s9000.ipadKeepAlive", "0");
  app.tile();
  assert.equal(await app.run("pausePlayback()"), true);
  assert.equal(await app.run("stopPlayback()"), true);
  assert.equal(app.plays().length, 0);
  assert.deepEqual(app.backend.requests.map(request => request.path), ["/me/player/pause", "/me/player/pause"]);
});

test("an end-cue stop keeps the song stopped while switching to idle silence", async t => {
  const app = controller(t);
  app.tile();
  app.run("window.testTile.dataset.stopms = '12100'; playingSnapshot.stopms = '12100'; armStopDeadline()");
  const silence = deferred();
  app.backend.beforeRequest = async request => {
    if (request.path === "/me/player/play") silence.resolve();
  };
  await Promise.race([
    silence.promise,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("End cue did not enter idle playback")), 2000); timer.unref(); }),
  ]);
  await app.run("transportQueue");
  assert.equal(app.run("nowPlaying"), null);
  assert.equal(app.backend.state.item.id, SILENCE);
});

test("status refresh keeps focus on the stable toolbar switch", async t => {
  const app = controller(t);
  await app.run("checkIdlePlayback()");
  app.window.document.getElementById("keepalive-enabled").focus();
  await app.run("checkIdlePlayback()");
  assert.equal(app.window.document.activeElement.id, "keepalive-enabled");
  assert.equal(app.window.document.getElementById("keepalive-toggle").dataset.state, "running");
  assert.equal(app.window.document.getElementById("ipad-keepalive-status").classList.contains("hidden"), true);
  await app.run("setIdleEnabled(false)");
  assert.equal(app.window.document.activeElement.id, "keepalive-enabled");
  assert.equal(app.window.document.getElementById("keepalive-toggle").dataset.state, "off");
});

test("disabling never pauses another track that replaced idle silence", async t => {
  const app = controller(t);
  await app.run("checkIdlePlayback()");
  app.backend.state.item = { id: "another-song", duration_ms: 240000 };
  const before = app.backend.requests.length;
  assert.equal(await app.run("setIdleEnabled(false)"), true);
  assert.equal(app.backend.state.is_playing, true);
  assert.equal(app.backend.requests.slice(before).some(request => request.method === "PUT"), false);
});

test("renewal follows Spotify progress and actual duration across more than one cycle", async t => {
  const app = controller(t);
  app.backend.duration = 660123;
  assert.equal(await app.run("checkIdlePlayback()"), true);
  for (let cycle = 0; cycle < 3; cycle++) {
    app.backend.state.progress_ms = app.backend.duration - 61000;
    await app.run("checkIdlePlayback()");
    assert.equal(app.plays().length, cycle + 1);
    app.backend.state.progress_ms = app.backend.duration - 59000;
    await app.run("checkIdlePlayback()");
    assert.equal(app.plays().length, cycle + 2);
    assert.equal(app.plays().at(-1).body.position_ms, 0);
  }
  assert.equal(app.backend.requests.filter(request => request.path === `/tracks/${SILENCE}`).length, 1);
});

test("the next check is pulled forward to the renewal deadline instead of another full polling interval", async t => {
  const app = controller(t);
  const clock = installIdleClock(app);
  app.run("idleReady = true");
  const initial = app.run("checkIdlePlayback()");
  await clock.advance(1000);
  await initial;
  app.backend.state.progress_ms = app.backend.duration - 66000;
  await app.run("checkIdlePlayback()");
  assert.equal(app.run("idleNextCheckAt"), clock.now + 6000);
});

test("a short silence track uses proportional headroom rather than restarting immediately", async t => {
  const app = controller(t);
  app.backend.duration = 32500;
  await app.run("checkIdlePlayback()");
  app.backend.state.progress_ms = 24000;
  await app.run("checkIdlePlayback()");
  assert.equal(app.plays().length, 1);
  app.backend.state.progress_ms = 25000;
  await app.run("checkIdlePlayback()");
  assert.equal(app.plays().length, 2);
});

test("time spent waiting for a playback response is included in the renewal decision", async t => {
  const app = controller(t);
  const clock = installIdleClock(app);
  app.run("waitForDeviceActivation = async current => current()");
  await app.run("checkIdlePlayback()");
  const realApi = app.window.testApi;
  let delayNextState = true;
  app.window.testApi = async (url, options) => {
    if (url === "/me/player" && delayNextState) {
      delayNextState = false;
      const snapshot = structuredClone({ ...app.backend.state, device: app.backend.device });
      await clock.wait(12000);
      return snapshot;
    }
    return realApi(url, options);
  };
  app.backend.state.progress_ms = app.backend.duration - 66000;
  const check = app.run("checkIdlePlayback()");
  await clock.advance(12000);
  assert.equal(await check, true);
  assert.equal(app.plays().length, 2);
});

test("a delayed pre-renewal reconciliation cannot overwrite the new silence deadline", async t => {
  const app = controller(t);
  const clock = installIdleClock(app);
  app.run("waitForDeviceActivation = async current => current()");
  app.tile();
  await app.run("pausePlayback()");
  app.backend.state.progress_ms = app.backend.duration - 1000;
  const staleState = structuredClone({ ...app.backend.state, device: app.backend.device });
  const entered = deferred(), release = deferred();
  const realApi = app.window.testApi;
  let first = true;
  app.window.testApi = async (url, options) => {
    if (url === "/me/player" && first) {
      first = false;
      entered.resolve();
      await release.promise;
      return staleState;
    }
    return realApi(url, options);
  };
  const reconciliation = app.run("reconcilePlayback()");
  await entered.promise;
  await clock.advance(100);
  await app.run("checkIdlePlayback()");
  const deadline = app.run("idlePlayback.renewAt");
  release.resolve();
  assert.equal(await reconciliation, true);
  assert.equal(app.run("idlePlayback.renewAt"), deadline);
  await app.run("checkIdlePlayback()");
  assert.equal(app.plays().length, 2);
});

test("hidden pages do not start or renew silence", async t => {
  const app = controller(t);
  Object.defineProperty(app.window.document, "visibilityState", { value: "hidden", configurable: true });
  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(app.backend.requests.length, 0);
});

test("hiding the page during a device lookup prevents late idle playback", async t => {
  const app = controller(t);
  const entered = deferred(), release = deferred();
  app.backend.beforeRequest = async request => {
    if (request.path === "/me/player/devices") { entered.resolve(); await release.promise; }
  };
  const check = app.run("checkIdlePlayback()");
  await entered.promise;
  Object.defineProperty(app.window.document, "visibilityState", { value: "hidden", configurable: true });
  app.window.document.dispatchEvent(new app.window.Event("visibilitychange"));
  release.resolve();
  assert.equal(await check, false);
  assert.equal(app.plays().length, 0);
  assert.equal(app.run("idleTimer"), null);
});

test("pagehide prevents an in-flight probe from scheduling more work even if visibility lags", async t => {
  const app = controller(t);
  app.run("idleReady = true");
  const entered = deferred(), release = deferred();
  app.backend.beforeRequest = async request => {
    if (request.path === "/me/player/devices") { entered.resolve(); await release.promise; }
  };
  const check = app.run("checkIdlePlayback()");
  await entered.promise;
  app.window.dispatchEvent(new app.window.Event("pagehide"));
  release.resolve();
  assert.equal(await check, false);
  assert.equal(app.plays().length, 0);
  assert.equal(app.run("idleTimer"), null);
});

test("reconciliation cannot continually postpone the existing idle-renewal check", async t => {
  const app = controller(t);
  app.tile();
  await app.run("pausePlayback()");
  app.run("idleReady = true; scheduleIdleCheck()");
  const timer = app.run("idleTimer");
  const deadline = app.run("idleNextCheckAt");
  for (let refresh = 0; refresh < 3; refresh++) {
    assert.equal(await app.run("reconcilePlayback()"), true);
    assert.equal(app.run("idleTimer"), timer);
    assert.equal(app.run("idleNextCheckAt"), deadline);
  }
});

test("a legitimate local refresh-token rotation does not permanently block idle playback", async t => {
  const app = controller(t);
  app.backend.beforeRequest = async request => {
    if (request.path === "/me/player/devices") {
      app.window.localStorage.setItem("s9000.auth", JSON.stringify({
        clientId: "synthetic-client", refreshToken: "synthetic-rotated-refresh",
      }));
    }
  };
  assert.equal(await app.run("checkIdlePlayback()"), true);
  assert.equal(app.plays().length, 1);
  assert.equal(app.run("idleBlocked"), false);
});

test("logout or auth invalidation cancels an outstanding idle decision", async t => {
  const app = controller(t);
  const entered = deferred(), release = deferred();
  app.backend.beforeRequest = async request => {
    if (request.path === "/me/player/devices") { entered.resolve(); await release.promise; }
  };
  const check = app.run("checkIdlePlayback()");
  await entered.promise;
  app.run("invalidateAuthWork(); invalidateTransportWork(); localStorage.removeItem(LS_AUTH)");
  release.resolve();
  assert.equal(await check, false);
  assert.equal(app.plays().length, 0);
  assert.equal(app.run("idlePlayback"), null);
});

test("a newer Start supersedes a delayed idle state request", async t => {
  const app = controller(t);
  app.tile();
  app.run("setPlaybackPaused(true)");
  const entered = deferred(), release = deferred();
  app.backend.beforeRequest = async request => {
    if (request.path === "/me/player" && request.method === "GET") { entered.resolve(); await release.promise; }
  };
  const check = app.run("checkIdlePlayback()");
  await entered.promise;
  const start = app.run("startPlayback(window.testTile)");
  release.resolve();
  await check;
  assert.equal(await start, true);
  assert.deepEqual(app.plays().map(request => request.body.uris), [["spotify:track:synthetic-song"]]);
});

test("disabling during an already-sent silence start queues a confirmed pause afterward", async t => {
  const app = controller(t);
  const entered = deferred(), release = deferred();
  app.backend.beforeRequest = async request => {
    if (request.path === "/me/player/play") { entered.resolve(); await release.promise; }
  };
  const check = app.run("checkIdlePlayback()");
  await entered.promise;
  const disabling = app.run("setIdleEnabled(false)");
  release.resolve();
  await check;
  assert.equal(await disabling, true);
  assert.equal(app.backend.state.is_playing, false);
  assert.equal(app.backend.requests.at(-1).path, "/me/player/pause");
});

test("disabling after a silence acknowledgement still owns the pending confirmation", async t => {
  const app = controller(t);
  const confirmation = deferred();
  app.window.testConfirmation = confirmation.promise;
  app.run(`
    waitForDeviceActivation = async current => {
      await window.testConfirmation;
      return current();
    };
  `);
  const check = app.run("checkIdlePlayback()");
  for (let attempts = 0; attempts < 20 && app.plays().length === 0; attempts++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(app.plays().length, 1);
  assert.equal(app.run("idlePendingDevice.deviceId"), "synthetic-device");
  const disabling = app.run("setIdleEnabled(false)");
  confirmation.resolve();
  await check;
  assert.equal(await disabling, true);
  assert.equal(app.backend.state.is_playing, false);
  assert.equal(app.backend.requests.at(-1).path, "/me/player/pause");
});

test("a failed silence command leaves the song paused and saved settings intact", async t => {
  const app = controller(t);
  app.tile();
  app.window.localStorage.setItem("s9000.volume", "35");
  app.backend.beforeRequest = async request => {
    if (request.path === "/me/player/play") throw new Error("Synthetic silent playback failure");
  };
  assert.equal(await app.run("pausePlayback()"), true);
  assert.equal(app.run("nowPlaying.paused"), true);
  assert.match(app.window.document.getElementById("ipad-keepalive-status").textContent, /Idle silence was not confirmed/);
  assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
  assert.equal(app.run("pendingCount()"), 0);
  const before = app.backend.requests.length;
  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(app.backend.requests.length, before);
  app.backend.beforeRequest = null;
  app.window.document.querySelector("#ipad-keepalive-status [data-idle-action='retry']").click();
  assert.equal(await app.run("idleCheckPromise"), true);
  assert.equal(app.backend.state.item.id, SILENCE);
  assert.equal(app.run("nowPlaying.paused"), true);
  assert.equal(app.run("idleBlocked"), false);
});

test("device disappearance and invalid track duration fail without fallback playback", async t => {
  const app = controller(t);
  app.backend.devices = [];
  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(app.plays().length, 0);
  assert.match(app.window.document.getElementById("ipad-keepalive-status").textContent, /unavailable/);
  app.backend.devices = null;
  app.backend.duration = 0;
  app.run("idleBlocked = false");
  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(app.plays().length, 0);
  assert.match(app.window.document.getElementById("ipad-keepalive-status").textContent, /duration cannot be verified/);
});

test("missing Web Locks cannot trigger unlocked automatic playback", async t => {
  const app = controller(t);
  app.window.navigator.locks = undefined;
  assert.equal(await app.run("checkIdlePlayback()"), false);
  assert.equal(app.backend.requests.length, 0);
  assert.match(app.window.document.getElementById("ipad-keepalive-status").textContent, /Web Locks/);
});

test("requests coalesce and concurrent idle tabs cannot both start against one stale probe", async t => {
  const first = controller(t), second = controller(t);
  second.window.navigator.locks = first.window.navigator.locks;
  const entered = deferred(), release = deferred();
  first.backend.beforeRequest = async request => {
    if (request.path === "/me/player/devices") { entered.resolve(); await release.promise; }
  };
  const one = first.run("checkIdlePlayback()");
  await entered.promise;
  const duplicate = first.run("checkIdlePlayback()");
  assert.equal(one, duplicate);
  assert.equal(await second.run("checkIdlePlayback()"), false);
  release.resolve();
  assert.equal(await one, true);
  assert.equal(first.plays().length, 1);
  assert.equal(second.plays().length, 0);
});

test("the capability guard prevents a late token from sending idle play after hiding", async t => {
  const app = createApp();
  t.after(app.close);
  const entered = deferred(), release = deferred();
  app.window.testToken = () => { entered.resolve(); return release.promise; };
  app.run("getAccessToken = window.testToken");
  const request = app.run("api('/me/player/play?device_id=synthetic-device', { method: 'PUT' }, () => document.visibilityState === 'visible')");
  await entered.promise;
  Object.defineProperty(app.window.document, "visibilityState", { value: "hidden", configurable: true });
  release.resolve("synthetic-access");
  await assert.rejects(request, /superseded/);
});
