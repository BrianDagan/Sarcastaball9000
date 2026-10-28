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
  app.run(`
    api = (...args) => window.testApi(...args);
    ensureDevice = async () => "synthetic-device";
    trackPlayedOn = false;
    activeDeviceCapabilities = { supports_volume: true };
    trackPlaybackContexts.set("synthetic-track", {
      requestedTrackId: "synthetic-track", resolvedTrackId: "synthetic-track",
      trackUri: "spotify:track:synthetic-track", albumUri: null, durationMs: 60000,
    });
  `);
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

test("album-context playback survives the native-client bare-track regression and relinking", async t => {
  const app = player(t, 0);
  const plays = [];
  let state = null;
  app.run("trackPlaybackContexts.clear(); activeDeviceCapabilities = { id: 'synthetic-device', type: 'Computer', supports_volume: false }");
  app.window.testApi = async (path, options = {}) => {
    if (path.startsWith("/tracks/synthetic-track")) {
      return {
        id: "synthetic-relinked-track",
        uri: "spotify:track:synthetic-relinked-track",
        duration_ms: 61000,
        is_playable: true,
        album: { uri: "spotify:album:synthetic-album" },
      };
    }
    if (path.startsWith("/me/player/play")) {
      const body = JSON.parse(options.body);
      plays.push(body);
      // This models the current Spotify native-client regression: a bare
      // `uris` request is acknowledged but leaves no current item.
      state = body.context_uri ? {
        is_playing: true,
        progress_ms: body.position_ms,
        item: { id: "synthetic-relinked-track" },
        device: { id: "synthetic-device", type: "Computer", supports_volume: false },
        actions: { disallows: {} },
      } : null;
      return null;
    }
    if (path === "/me/player") return state;
    return null;
  };

  assert.equal(await app.run("startPlayback(window.testCell)"), true);
  assert.deepEqual(plays, [{
    context_uri: "spotify:album:synthetic-album",
    offset: { uri: "spotify:track:synthetic-relinked-track" },
    position_ms: 0,
  }]);
  assert.equal(app.run("playingSnapshot.spotifyTrackId"), "synthetic-relinked-track");
  assert.equal(app.run("playingSnapshot.contextPlayback"), true);
  assert.equal(app.run("progress.durationMs"), 61000);
  assert.equal(app.run("transportStopDeadlineMs()"), 61000);
  assert.equal(await app.run("reconcilePlayback()"), true);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
});

test("track metadata failure falls back to direct playback without an album spillover deadline", async t => {
  const app = player(t, 0);
  const plays = [];
  const warnings = [];
  app.run("trackPlaybackContexts.clear(); activeDeviceCapabilities = { id: 'synthetic-device', type: 'Computer', supports_volume: false }");
  app.window.console.warn = (...args) => warnings.push(args);
  app.window.testApi = async (path, options = {}) => {
    if (path.startsWith("/tracks/synthetic-track")) throw new Error("Synthetic metadata failure");
    if (path.startsWith("/me/player/play")) plays.push(JSON.parse(options.body));
    return null;
  };

  assert.equal(await app.run("startPlayback(window.testCell)"), true);
  assert.deepEqual(plays, [{
    uris: ["spotify:track:synthetic-track"],
    position_ms: 0,
  }]);
  assert.equal(app.run("playingSnapshot.contextPlayback"), false);
  assert.equal(app.run("transportStopDeadlineMs()"), 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /album-context lookup failed/i);
});

test("Start reactivates an inactive selected device and retries once after NO_ACTIVE_DEVICE", async t => {
  const app = player(t);
  const requests = [];
  let active = false;
  let attempts = 0;
  const noActive = app.run("new SpotifyError(404, 'NO_ACTIVE_DEVICE', null)");
  app.run(`
    activeDeviceCapabilities = { id: "synthetic-device", supports_volume: false };
    waitForDeviceActivation = async current => current();
  `);
  app.window.testApi = async (path, options = {}) => {
    requests.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (path.startsWith("/me/player/play")) {
      attempts++;
      if (attempts === 1) throw noActive;
      return null;
    }
    if (path === "/me/player/devices") {
      return { devices: [{
        id: "synthetic-device", name: "Synthetic iPad", is_active: active,
        is_restricted: false, supports_volume: false,
      }] };
    }
    if (path === "/me/player" && options.method === "PUT") {
      active = true;
      return null;
    }
    if (path === "/me/player") return playbackState(true);
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  assert.equal(await app.run("startPlayback(window.testCell)"), true);
  assert.equal(attempts, 2);
  assert.deepEqual(requests.map(request => request.path), [
    "/me/player/play?device_id=synthetic-device",
    "/me/player/devices",
    "/me/player",
    "/me/player/play?device_id=synthetic-device",
    "/me/player",
  ]);
  assert.deepEqual(requests[2].body, { device_ids: ["synthetic-device"], play: false });
  assert.deepEqual(requests[0].body, requests[3].body);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  assert.equal(app.window.document.getElementById("transport-status").classList.contains("hidden"), true);
});

test("a reasonless 404 reactivates a device whose active flag is stale", async t => {
  const app = player(t);
  const paths = [];
  const unavailable = app.run("new SpotifyError(404, null, null)");
  let attempts = 0;
  let transfers = 0;
  app.run(`
    activeDeviceCapabilities = { id: "synthetic-device", supports_volume: false };
    waitForDeviceActivation = async current => current();
  `);
  app.window.testApi = async (path, options = {}) => {
    paths.push(path);
    if (path.startsWith("/me/player/play")) {
      attempts++;
      if (attempts === 1) throw unavailable;
      return null;
    }
    if (path === "/me/player/devices") {
      return { devices: [{
        id: "synthetic-device", name: "Synthetic iPad", is_active: true,
        is_restricted: false, supports_volume: false,
      }] };
    }
    if (path === "/me/player" && options.method === "PUT") {
      transfers++;
      return null;
    }
    if (path === "/me/player") return playbackState(true);
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  assert.equal(await app.run("startPlayback(window.testCell)"), true);
  assert.equal(attempts, 2);
  assert.equal(transfers, 1);
  assert.deepEqual(paths, [
    "/me/player/play?device_id=synthetic-device",
    "/me/player/devices",
    "/me/player",
    "/me/player/play?device_id=synthetic-device",
    "/me/player",
  ]);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
});

test("a selected iPad Start retries one transient Spotify 502", async t => {
  const app = player(t);
  const requests = [];
  let attempts = 0;
  const gateway = app.run("new SpotifyError(502, null, null)");
  app.run(`
    activeDeviceCapabilities = {
      id: "synthetic-device", name: "Synthetic iPad",
      is_restricted: false, supports_volume: false
    };
    waitForDeviceActivation = async current => current();
  `);
  app.window.testApi = async (path, options = {}) => {
    requests.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (path.startsWith("/me/player/play")) {
      attempts++;
      if (attempts === 1) throw gateway;
      return null;
    }
    if (path === "/me/player/devices") {
      return { devices: [{
        id: "synthetic-device", name: "Synthetic iPad", is_active: true,
        is_restricted: false, supports_volume: false,
      }] };
    }
    if (path === "/me/player" && options.method === "PUT") return null;
    if (path === "/me/player") return playbackState(true);
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  assert.equal(await app.run("startPlayback(window.testCell)"), true);
  assert.equal(attempts, 2);
  assert.deepEqual(requests.map(request => request.path), [
    "/me/player/play?device_id=synthetic-device",
    "/me/player/devices",
    "/me/player",
    "/me/player/play?device_id=synthetic-device",
    "/me/player",
  ]);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  assert.equal(app.run("nowPlaying.detached"), false);
  assert.deepEqual(
    Array.from(
      app.run("playbackDiagnosticBuffer.filter(entry => entry.event === 'play-failed').map(entry => [entry.purpose, entry.attempt, entry.status])"),
      entry => Array.from(entry),
    ),
    [["start", 1, 502]],
  );
});

test("a non-iPad Start surfaces a transient Spotify 502 without retrying", async t => {
  const app = player(t);
  let attempts = 0;
  const gateway = app.run("new SpotifyError(502, null, null)");
  app.run(`
    activeDeviceCapabilities = {
      id: "synthetic-device", name: "Synthetic Laptop",
      is_restricted: false, supports_volume: false
    };
  `);
  app.window.testApi = async path => {
    if (path.startsWith("/me/player/play")) {
      attempts++;
      throw gateway;
    }
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  assert.equal(await app.run("startPlayback(window.testCell)"), false);
  assert.equal(attempts, 1);
  assert.equal(app.run("nowPlaying"), null);
  assert.match(app.window.document.getElementById("transport-status").textContent, /Spotify 502/i);
});

test("a genuine playback 404 remains visible after one bounded recovery retry", async t => {
  const app = player(t);
  const unavailable = app.run("new SpotifyError(404, null, null)");
  let attempts = 0;
  let transfers = 0;
  app.run("activeDeviceCapabilities = { id: 'synthetic-device', supports_volume: false }");
  app.window.testApi = async (path, options = {}) => {
    if (path.startsWith("/me/player/play")) {
      attempts++;
      throw unavailable;
    }
    if (path === "/me/player/devices") {
      return { devices: [{
        id: "synthetic-device", name: "Synthetic iPad", is_active: true,
        is_restricted: false, supports_volume: false,
      }] };
    }
    if (path === "/me/player" && options.method === "PUT") {
      transfers++;
      return null;
    }
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  assert.equal(await app.run("startPlayback(window.testCell)"), false);
  assert.equal(attempts, 2);
  assert.equal(transfers, 1);
  assert.equal(app.run("nowPlaying"), null);
  assert.match(app.window.document.getElementById("transport-status").textContent, /requested item or playback device is unavailable/i);
});

for (const scenario of [
  {
    name: "missing",
    devices: [],
    message: /selected Spotify device is asleep or unavailable/i,
  },
  {
    name: "restricted",
    devices: [{
      id: "synthetic-device", name: "Synthetic iPad", is_active: false,
      is_restricted: true, supports_volume: false,
    }],
    message: /currently blocks remote playback/i,
  },
]) {
  test(`inactive-device recovery fails explicitly when the selected device is ${scenario.name}`, async t => {
    const app = player(t);
    const noActive = app.run("new SpotifyError(404, 'NO_ACTIVE_DEVICE', null)");
    const paths = [];
    app.run("activeDeviceCapabilities = { id: 'synthetic-device', supports_volume: false }");
    app.window.testApi = async path => {
      paths.push(path);
      if (path.startsWith("/me/player/play")) throw noActive;
      if (path === "/me/player/devices") return { devices: structuredClone(scenario.devices) };
      throw new Error(`Unexpected synthetic request: ${path}`);
    };

    assert.equal(await app.run("startPlayback(window.testCell)"), false);
    assert.deepEqual(paths, [
      "/me/player/play?device_id=synthetic-device",
      "/me/player/devices",
    ]);
    assert.equal(app.run("nowPlaying"), null);
    assert.match(app.window.document.getElementById("transport-status").textContent, scenario.message);
  });
}

test("inactive-device recovery stops after one failed playback retry", async t => {
  const app = player(t);
  const noActive = app.run("new SpotifyError(404, 'NO_ACTIVE_DEVICE', null)");
  let active = false;
  let playAttempts = 0;
  let transfers = 0;
  app.run("activeDeviceCapabilities = { id: 'synthetic-device', supports_volume: false }");
  app.window.testApi = async (path, options = {}) => {
    if (path.startsWith("/me/player/play")) {
      playAttempts++;
      throw noActive;
    }
    if (path === "/me/player/devices") {
      return { devices: [{
        id: "synthetic-device", name: "Synthetic iPad", is_active: active,
        is_restricted: false, supports_volume: false,
      }] };
    }
    if (path === "/me/player" && options.method === "PUT") {
      transfers++;
      active = true;
      return null;
    }
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  assert.equal(await app.run("startPlayback(window.testCell)"), false);
  assert.equal(playAttempts, 2);
  assert.equal(transfers, 1);
  assert.equal(app.run("nowPlaying"), null);
  assert.match(app.window.document.getElementById("transport-status").textContent, /reactivated the selected device but still could not start playback/i);
});

test("Stop supersedes Start while inactive-device recovery is refreshing", async t => {
  const app = player(t);
  const devices = deferred();
  const entered = deferred();
  const paths = [];
  const noActive = app.run("new SpotifyError(404, 'NO_ACTIVE_DEVICE', null)");
  app.run("activeDeviceCapabilities = { id: 'synthetic-device', supports_volume: false }");
  app.window.testApi = async (path, options = {}) => {
    paths.push(path);
    if (path.startsWith("/me/player/play")) {
      throw noActive;
    }
    if (path === "/me/player/devices") {
      entered.resolve();
      return devices.promise;
    }
    if (path === "/me/player/pause") return null;
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  const start = app.run("startPlayback(window.testCell)");
  await entered.promise;
  const stop = app.run("stopPlayback()");
  devices.resolve({ devices: [{
    id: "synthetic-device", name: "Synthetic iPad", is_active: false,
    is_restricted: false, supports_volume: false,
  }] });

  assert.equal(await start, false);
  assert.equal(await stop, true);
  assert.deepEqual(paths, [
    "/me/player/play?device_id=synthetic-device",
    "/me/player/devices",
    "/me/player/pause",
  ]);
  assert.equal(app.run("nowPlaying"), null);
});

test("Stop supersedes Start while album metadata is still loading", async t => {
  const app = player(t);
  const metadata = deferred();
  const entered = deferred();
  const paths = [];
  app.run("trackPlaybackContexts.clear()");
  app.window.testApi = async path => {
    paths.push(path);
    if (path.startsWith("/tracks/synthetic-track")) {
      entered.resolve();
      return metadata.promise;
    }
    return null;
  };

  const start = app.run("startPlayback(window.testCell)");
  await entered.promise;
  const stop = app.run("stopPlayback()");
  metadata.resolve({
    id: "synthetic-track",
    uri: "spotify:track:synthetic-track",
    duration_ms: 60000,
    is_playable: true,
    album: { uri: "spotify:album:synthetic-album" },
  });

  assert.equal(await start, false);
  assert.equal(await stop, true);
  assert.deepEqual(paths, [
    "/tracks/synthetic-track?market=from_token",
    "/me/player/pause",
  ]);
  assert.equal(app.run("nowPlaying"), null);
});

test("a transient post-Start null state does not surrender cue control", async t => {
  const app = player(t);
  let clock = 0;
  let state = null;
  app.window.performance.now = () => clock;
  app.window.testApi = async (path, options = {}) => {
    if (path.startsWith("/me/player/play")) return null;
    if (path === "/me/player") return state;
    return null;
  };
  assert.equal(await app.run("startPlayback(window.testCell)"), true);
  assert.equal(await app.run("reconcilePlayback()"), true);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  clock = 4500;
  state = playbackState(true);
  assert.equal(await app.run("reconcilePlayback()"), true);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  assert.equal(app.window.document.getElementById("transport-status").classList.contains("hidden"), true);
});

for (const operation of ["start", "resume"]) {
  for (const laggingReads of [0, 1]) {
    test(`iPad ${operation} tolerates ${laggingReads} stale confirmation reads without extra playback`, async t => {
      const app = player(t);
      const requests = [];
      const delays = [];
      let reads = 0;
      app.run(`
        localStorage.setItem(LS_IPAD_KEEPALIVE, "0");
        activeDeviceCapabilities = {
          id: "synthetic-device", name: "Synthetic iPad", supports_volume: false
        };
      `);
      if (operation === "resume") app.run("setNowPlaying(window.testCell); setPlaybackPaused(true)");
      app.window.confirmationWait = async (current, delay) => { delays.push(delay); return current(); };
      app.run("waitForDeviceActivation = (current, delay = DEVICE_ACTIVATION_SETTLE_MS) => window.confirmationWait(current, delay)");
      app.window.testApi = async (path, options = {}) => {
        requests.push({ path, method: options.method || "GET" });
        if (path.startsWith("/me/player/play")) return null;
        if (path === "/me/player" && !options.method) {
          reads++;
          return {
            ...playbackState(true),
            item: { id: reads <= laggingReads ? "previous-track" : "synthetic-track" },
          };
        }
        if (path === "/me/player/devices") {
          return { devices: [{
            id: "synthetic-device", name: "Synthetic iPad", is_active: true, supports_volume: false,
          }] };
        }
        if (path === "/me/player" && options.method === "PUT") return null;
        throw new Error(`Unexpected synthetic request: ${path}`);
      };

      assert.equal(await app.run(operation === "start" ? "startPlayback(window.testCell)" : "resumePlayback()"), true);
      assert.equal(requests.filter(request => request.path.startsWith("/me/player/play")).length, 1);
      assert.equal(requests.filter(request => request.path === "/me/player/devices").length, 0);
      assert.equal(requests.filter(request => request.path === "/me/player" && request.method === "PUT").length, 0);
      assert.equal(reads, laggingReads + 1);
      assert.deepEqual(delays, laggingReads === 0 ? [750] : [750, 1000]);
      assert.equal(app.run("nowPlaying.paused"), false);
      const events = Array.from(app.run("playbackDiagnosticBuffer.filter(entry => entry.event === 'track-confirmation')"));
      assert.equal(events.at(-1).outcome, "confirmed");
      assert.equal(events.at(-1).stage, laggingReads === 0 ? "confirmation" : "confirmation-recheck");
      assert.equal(events.at(-1).progressSec, 1);
      assert.equal(Number.isFinite(events.at(-1).requestedPositionSec), true);
    });
  }
}

test("Stop cancels a stale iPad confirmation recheck before any replay", async t => {
  const app = player(t);
  const entered = deferred(), release = deferred();
  const requests = [];
  app.run(`
    localStorage.setItem(LS_IPAD_KEEPALIVE, "0");
    activeDeviceCapabilities = {
      id: "synthetic-device", name: "Synthetic iPad", supports_volume: false
    };
  `);
  app.window.confirmationWait = async (current, delay) => {
    if (delay === 1000) { entered.resolve(); await release.promise; }
    return current();
  };
  app.run("waitForDeviceActivation = (current, delay) => window.confirmationWait(current, delay)");
  app.window.testApi = async (path, options = {}) => {
    requests.push(path);
    if (path.startsWith("/me/player/play") || path === "/me/player/pause") return null;
    if (path === "/me/player" && !options.method) {
      return { ...playbackState(true), item: { id: "previous-track" } };
    }
    throw new Error(`Unexpected synthetic request: ${path}`);
  };
  const start = app.run("startPlayback(window.testCell)");
  await entered.promise;
  const stop = app.run("stopPlayback()");
  release.resolve();
  assert.equal(await start, false);
  assert.equal(await stop, true);
  assert.deepEqual(requests, [
    "/me/player/play?device_id=synthetic-device", "/me/player", "/me/player/pause",
  ]);
  assert.equal(app.run("nowPlaying"), null);
});

test("iPad identity mismatch never replays or falsely pauses audible playback", async t => {
  const app = player(t);
  const requests = [];
  let plays = 0;
  let state = {
    is_playing: true,
    progress_ms: 4000,
    item: { id: "previous-track" },
    device: { id: "synthetic-device", name: "Synthetic iPad", supports_volume: false },
    actions: { disallows: {} },
  };
  app.run(`
    activeDeviceCapabilities = {
      id: "synthetic-device", name: "Synthetic iPad",
      is_restricted: false, supports_volume: false
    };
    waitForDeviceActivation = async current => current();
  `);
  app.window.testApi = async (path, options = {}) => {
    requests.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (path.startsWith("/me/player/play")) {
      plays++;
      if (plays === 2) state = playbackState(true);
      return null;
    }
    if (path === "/me/player" && !options.method) return structuredClone(state);
    if (path === "/me/player/devices") {
      return { devices: [{
        id: "synthetic-device", name: "Synthetic iPad", is_active: true,
        is_restricted: false, supports_volume: false,
      }] };
    }
    if (path === "/me/player" && options.method === "PUT") return null;
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  assert.equal(await app.run("startPlayback(window.testCell)"), false);
  assert.equal(plays, 1);
  assert.deepEqual(requests.map(request => request.path), [
    "/me/player/play?device_id=synthetic-device",
    "/me/player",
    "/me/player",
  ]);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  assert.equal(app.run("nowPlaying.paused"), false);
  assert.equal(app.run("!!nowPlaying.detached"), false);
  assert.equal(app.run("nowPlaying.confirmationUncertain"), true);
  assert.equal(await app.run("reconcilePlayback()"), false);
  assert.equal(requests.length, 3, "Unverified track IDs must not trigger recurring checks or false detachment");
  assert.match(app.window.document.getElementById("transport-status").textContent, /No automatic replay/i);
  assert.deepEqual(
    Array.from(app.run("playbackDiagnosticBuffer.filter(entry => entry.event === 'track-confirmation').map(entry => entry.outcome)")),
    ["unconfirmed", "unconfirmed"],
  );
});

test("a quick Pause after uncertain iPad Start sends Pause, never a replay", async t => {
  const app = player(t);
  const confirmationStarted = deferred();
  const releaseConfirmation = deferred();
  const requests = [];
  let plays = 0;
  let waits = 0;
  let state = {
    is_playing: true,
    progress_ms: 4000,
    item: { id: "previous-track" },
    device: { id: "synthetic-device", name: "Synthetic iPad", supports_volume: false },
    actions: { disallows: {} },
  };
  app.run(`
    localStorage.setItem(LS_IPAD_KEEPALIVE, "0");
    activeDeviceCapabilities = {
      id: "synthetic-device", name: "Synthetic iPad",
      is_restricted: false, supports_volume: false
    };
  `);
  app.window.testWait = async current => {
    waits++;
    if (waits === 1) {
      confirmationStarted.resolve();
      await releaseConfirmation.promise;
    }
    return current();
  };
  app.run("waitForDeviceActivation = current => window.testWait(current)");
  app.window.testApi = async (path, options = {}) => {
    requests.push({ path, method: options.method || "GET" });
    if (path.startsWith("/me/player/play")) {
      plays++;
      if (plays === 2) state = playbackState(true);
      return null;
    }
    if (path === "/me/player" && !options.method) return structuredClone(state);
    if (path === "/me/player/devices") {
      return { devices: [{
        id: "synthetic-device", name: "Synthetic iPad", is_active: true,
        is_restricted: false, supports_volume: false,
      }] };
    }
    if (path === "/me/player" && options.method === "PUT") return null;
    if (path === "/me/player/pause") {
      state = { ...playbackState(false), progress_ms: 1000 };
      return null;
    }
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  const start = app.run("startPlayback(window.testCell)");
  await confirmationStarted.promise;
  const pause = app.run("pausePlayback()");
  releaseConfirmation.resolve();

  assert.equal(await start, false);
  assert.equal(await pause, true);
  assert.equal(plays, 1);
  assert.deepEqual(requests.map(request => request.path), [
    "/me/player/play?device_id=synthetic-device",
    "/me/player",
    "/me/player",
    "/me/player/pause",
  ]);
  assert.deepEqual(
    Array.from(app.run("playbackDiagnosticBuffer.filter(entry => entry.event === 'track-confirmation').map(entry => entry.outcome)")),
    ["unconfirmed", "unconfirmed"],
  );
  assert.equal(app.run("nowPlaying.paused"), true);
});

test("unverified iPad Start retains its local clock and only explicit Retry sends Play", async t => {
  const app = player(t);
  const plays = [];
  let recover = false;
  let state = {
    is_playing: true,
    progress_ms: 4000,
    item: { id: "previous-track" },
    device: { id: "synthetic-device", name: "Synthetic iPad", supports_volume: false },
    actions: { disallows: {} },
  };
  app.window.syntheticClock = 0;
  app.run(`
    performance.now = () => window.syntheticClock;
    activeDeviceCapabilities = {
      id: "synthetic-device", name: "Synthetic iPad",
      is_restricted: false, supports_volume: false
    };
    waitForDeviceActivation = async (current, delay = DEVICE_ACTIVATION_SETTLE_MS) => {
      window.syntheticClock += delay;
      return current();
    };
  `);
  app.window.testApi = async (path, options = {}) => {
    if (path.startsWith("/me/player/play")) {
      const body = JSON.parse(options.body);
      plays.push(body);
      if (recover) {
        state = {
          ...playbackState(true),
          progress_ms: body.position_ms,
        };
      }
      return null;
    }
    if (path === "/me/player" && !options.method) return structuredClone(state);
    if (path === "/me/player/devices") {
      return { devices: [{
        id: "synthetic-device", name: "Synthetic iPad", is_active: true,
        is_restricted: false, supports_volume: false,
      }] };
    }
    if (path === "/me/player" && options.method === "PUT") return null;
    throw new Error(`Unexpected synthetic request: ${path}`);
  };

  assert.equal(await app.run("startPlayback(window.testCell)"), false);
  assert.equal(plays.length, 1);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  assert.equal(app.run("nowPlaying.paused"), false);
  assert.equal(app.run("!!nowPlaying.detached"), false);
  assert.equal(app.run("nowPlaying.confirmationUncertain"), true);
  assert.equal(Math.round(app.run("currentPositionMs()")), 1750);
  const status = app.window.document.getElementById("transport-status");
  assert.match(status.textContent, /No automatic replay.*Pause normally/i);
  assert.equal(status.querySelector("button")?.textContent, "Retry");

  recover = true;
  assert.equal(await app.run("resumePlayback()"), true);
  assert.equal(plays.length, 2);
  assert.deepEqual(plays[1], {
    uris: ["spotify:track:synthetic-track"],
    position_ms: 1750,
  });
  assert.equal(app.run("nowPlaying.paused"), false);
  assert.equal(app.run("nowPlaying.detached"), false);
  assert.equal(app.run("nowPlaying.confirmationUncertain"), false);
  assert.equal(app.window.document.getElementById("transport-status").classList.contains("hidden"), true);
});

test("only spaced consistent mismatches pause local cue control and preserve progress", async t => {
  const app = player(t);
  let clock = 0;
  app.window.performance.now = () => clock;
  app.window.testApi = async () => ({
    is_playing: true,
    progress_ms: 9000,
    item: { id: "external-track" },
    device: { id: "other-device", supports_volume: true },
    actions: { disallows: {} },
  });
  app.run("setNowPlaying(window.testCell)");
  assert.equal(await app.run("reconcilePlayback()"), true);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  clock = 500;
  assert.equal(await app.run("reconcilePlayback()"), true);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  clock = 1500;
  assert.equal(await app.run("reconcilePlayback()"), true);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  assert.equal(app.run("nowPlaying.paused"), true);
  assert.equal(app.run("nowPlaying.detached"), true);
  assert.equal(app.run("progress.paused"), true);
  assert.equal(Math.round(app.run("currentPositionMs()")), 1500);
  const status = app.window.document.getElementById("transport-status");
  assert.equal(status.classList.contains("hidden"), false);
  assert.match(status.textContent, /different track.*position was preserved/i);
  assert.equal(status.querySelector("button")?.textContent, "Retry");
});

test("sustained missing playback preserves the local cue for an explicit retry", async t => {
  const app = player(t);
  let clock = 0;
  app.window.performance.now = () => clock;
  app.window.testApi = async () => null;
  app.run("setNowPlaying(window.testCell)");
  assert.equal(await app.run("reconcilePlayback()"), true);
  clock = 1500;
  assert.equal(await app.run("reconcilePlayback()"), true);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  assert.equal(app.run("nowPlaying.paused"), true);
  assert.equal(app.run("nowPlaying.detached"), true);
  const status = app.window.document.getElementById("transport-status");
  assert.equal(status.classList.contains("hidden"), false);
  assert.match(status.textContent, /stopped reporting the requested track.*position was preserved/i);
  assert.doesNotMatch(app.window.document.getElementById("toast")?.textContent || "", /outside this controller/i);
});

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
