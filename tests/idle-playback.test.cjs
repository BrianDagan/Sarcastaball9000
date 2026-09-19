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
    beforeRequest: null,
  };
  app.window.testApi = async (url, options = {}) => {
    const request = { path: url.split("?")[0], url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    backend.requests.push(request);
    if (backend.beforeRequest) await backend.beforeRequest(request);
    if (request.path === "/me/player/devices") return { devices: backend.devices || [backend.device] };
    if (request.path === "/me/player" && request.method === "GET") {
      return structuredClone({ ...backend.state, device: backend.device });
    }
    if (request.path === `/tracks/${SILENCE}`) return { id: SILENCE, duration_ms: backend.duration, is_playable: true };
    if (request.path === "/me/player/play") {
      if (request.body?.uris) {
        const id = request.body.uris[0].split(":").at(-1);
        backend.state.item = { id, duration_ms: id === SILENCE ? backend.duration : 180000 };
        backend.state.progress_ms = request.body.position_ms || 0;
      }
      backend.state.is_playing = true;
      return null;
    }
    if (request.path === "/me/player/pause") { backend.state.is_playing = false; return null; }
    if (request.path === "/me/player/seek") return null;
    throw new Error("Unexpected synthetic request");
  };
  app.window.testDevice = backend.device;
  app.run("api = (...args) => window.testApi(...args); activeDeviceId = 'synthetic-device'; activeDeviceCapabilities = window.testDevice; trackPlayedOn = false");
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

test("default idle behavior starts only on a freshly available selected iPad device", async t => {
  const app = controller(t, "Synthetic IPAD");
  assert.equal(await app.run("checkIdlePlayback()"), true);
  assert.equal(app.plays().length, 1);
  assert.deepEqual(app.plays()[0].body, { uris: [`spotify:track:${SILENCE}`], position_ms: 0 });
  assert.match(app.plays()[0].url, /device_id=synthetic-device/);
  assert.equal(app.run("nowPlaying"), null);
  assert.equal(app.run("pendingCount()"), 0);
  assert.equal(app.backend.requests.some(request => /volume|repeat/.test(request.path)), false);
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
  assert.equal(await app.run("pausePlayback()"), true);
  assert.equal(app.run("nowPlaying.paused"), true);
  const position = app.run("Math.round(currentPositionMs())");
  assert.equal(app.backend.state.item.id, SILENCE);
  assert.equal(await app.run("reconcilePlayback()"), true);
  assert.equal(app.run("nowPlaying.uuid"), "synthetic-playback");
  assert.equal(app.run("Math.round(currentPositionMs())"), position);
  assert.equal(await app.run("resumePlayback()"), true);
  assert.deepEqual(app.plays().at(-1).body, { uris: ["spotify:track:synthetic-song"], position_ms: position });
  assert.equal(app.run("nowPlaying.paused"), false);
  assert.equal(app.run("idlePlayback"), null);
});

test("Stop clears the tile but starts silence; disabling then stops only that silence", async t => {
  const app = controller(t);
  app.tile();
  assert.equal(await app.run("stopPlayback()"), true);
  assert.equal(app.run("nowPlaying"), null);
  assert.equal(app.backend.state.item.id, SILENCE);
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
    app.backend.state.progress_ms = 640000;
    await app.run("checkIdlePlayback()");
    assert.equal(app.plays().length, cycle + 1);
    app.backend.state.progress_ms = 650000;
    await app.run("checkIdlePlayback()");
    assert.equal(app.plays().length, cycle + 2);
    assert.equal(app.plays().at(-1).body.position_ms, 0);
  }
  assert.equal(app.backend.requests.filter(request => request.path === `/tracks/${SILENCE}`).length, 1);
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
