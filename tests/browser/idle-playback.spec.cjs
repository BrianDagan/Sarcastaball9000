const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const { getSql, fixture, ids } = require("../helpers/database.cjs");
const { buttonContrast } = require("../helpers/contrast.cjs");

const SILENCE_ID = "3mkOlbSv5RYadx0JsjTrKq";
const SILENCE_URI = `spotify:track:${SILENCE_ID}`;
const SONG_ID = "synthetic-track-0";
const SONG_URI = `spotify:track:${SONG_ID}`;
const DEVICE_ID = "synthetic-idle-device";
const OTHER_DEVICE_ID = "synthetic-other-device";
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1";

function device(id = DEVICE_ID, name = "Synthetic iPad", extra = {}) {
  return {
    id, name, type: "Smartphone", is_active: id === DEVICE_ID,
    is_restricted: false, supports_volume: false, volume_percent: 35, ...extra,
  };
}

function track(id, durationMs = 123456) {
  return {
    id, uri: `spotify:track:${id}`, type: "track", is_local: false,
    is_playable: true, duration_ms: durationMs, name: "Synthetic track",
    artists: [{ name: "Synthetic artist" }],
    album: { name: "Synthetic album", images: [], uri: "spotify:album:synthetic-album" },
  };
}

test.beforeEach(async ({ page }) => {
  page.appErrors = [];
  page.on("pageerror", error => page.appErrors.push(error.message));
  await page.route(/https:\/\/(?:[^/]+\.)?spotify\.com\//, route => route.abort("blockedbyclient"));
});

test.afterEach(async ({ page }) => {
  expect(page.appErrors).toEqual([]);
  if (page.idleBackend) {
    expect(page.idleBackend.unexpected).toEqual([]);
    expect(page.idleBackend.calls.filter(call => /\/(?:repeat|queue|shuffle|volume)$/.test(call.path))).toEqual([]);
  }
});

async function prepare(page, options = {}) {
  const devices = options.devices || [device()];
  const selected = options.selectedDevice || devices[0] || device();
  const backend = page.idleBackend = {
    devices,
    durationMs: options.durationMs || 93750,
    silenceId: options.silenceId || SILENCE_ID,
    playable: options.playable !== false,
    failSilence: false,
    failNextPlayNoActive: options.failNextPlayNoActive === true,
    failNextPlayWithoutReason: options.failNextPlayWithoutReason === true,
    failNextTrackStatus: options.failNextTrackStatus || null,
    acknowledgeSilenceWithoutPlayback: false,
    acknowledgeNextTrackWithoutPlayback: false,
    leavePauseStateStale: false,
    pendingPauseState: false,
    calls: [],
    unexpected: [],
    state: {
      device: { ...(devices[0] || selected) }, item: track("synthetic-external-track"),
      is_playing: !!options.playing, progress_ms: 0,
      repeat_state: options.repeatState === undefined ? "off" : options.repeatState,
      shuffle_state: false, actions: { disallows: {} },
    },
    holdNext(stage) {
      let release;
      const wait = new Promise(resolve => { release = resolve; });
      const hold = { stage, wait, release, entered: false };
      backend.hold = hold;
      return hold;
    },
    async waitAt(stage) {
      if (backend.hold?.stage !== stage) return;
      const hold = backend.hold;
      backend.hold = null;
      hold.entered = true;
      await hold.wait;
    },
  };
  if (options.stateDevice) backend.state.device = { ...options.stateDevice };
  await page.route(/https:\/\/(?:[^/]+\.)?spotify\.com\//, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const call = {
      method,
      path: url.pathname,
      deviceId: url.searchParams.get("device_id"),
      market: url.searchParams.get("market"),
      body: null,
    };
    if (request.postData() && url.hostname === "api.spotify.com") call.body = request.postDataJSON();
    backend.calls.push(call);
    if (url.hostname === "accounts.spotify.com" && url.pathname === "/api/token" &&
        method === "POST" && new URLSearchParams(request.postData()).get("grant_type") === "refresh_token") {
      await backend.waitAt("token");
      return route.fulfill({ json: {
        access_token: "synthetic-idle-access", refresh_token: "synthetic-idle-refresh", expires_in: 3600,
      } });
    }
    if (url.hostname === "api.spotify.com") {
      if (method === "GET" && url.pathname === "/v1/me") {
        return route.fulfill({ json: { display_name: "Synthetic listener", country: "US" } });
      }
      if (method === "GET" && url.pathname === "/v1/me/player/devices") {
        return route.fulfill({ json: { devices: structuredClone(backend.devices) } });
      }
      if (method === "GET" && url.pathname === "/v1/me/player") {
        // Capture before the gate so releasing it delivers genuinely stale state.
        const state = structuredClone(backend.state);
        if (backend.pendingPauseState) {
          backend.pendingPauseState = false;
          backend.state.is_playing = false;
        }
        await backend.waitAt("state");
        return route.fulfill({ json: state });
      }
      if (method === "GET" && url.pathname === `/v1/tracks/${SILENCE_ID}`) {
        return route.fulfill({ json: {
          ...track(backend.silenceId, backend.durationMs),
          ...(backend.silenceId === SILENCE_ID ? {} : { linked_from: { id: SILENCE_ID } }),
          is_playable: backend.playable,
          ...(backend.playable ? {} : { restrictions: { reason: "market" } }),
        } });
      }
      if (method === "GET" && url.pathname.startsWith("/v1/tracks/")) {
        const id = url.pathname.split("/").at(-1);
        return route.fulfill({ json: {
          ...track(id),
          album: { name: "Synthetic album", images: [], uri: "spotify:album:synthetic-album" },
        } });
      }
      if (method === "PUT" && url.pathname === "/v1/me/player/play") {
        if (backend.failNextPlayWithoutReason) {
          backend.failNextPlayWithoutReason = false;
          return route.fulfill({ status: 404, json: {
            error: { status: 404, message: "Synthetic unavailable item or device" },
          } });
        }
        if (backend.failNextPlayNoActive) {
          backend.failNextPlayNoActive = false;
          return route.fulfill({ status: 404, json: {
            error: { status: 404, message: "Synthetic inactive device", reason: "NO_ACTIVE_DEVICE" },
          } });
        }
        const uri = call.body?.uris?.[0] || call.body?.offset?.uri;
        const id = uri?.replace("spotify:track:", "") || backend.state.item?.id;
        if (id !== backend.silenceId && backend.failNextTrackStatus) {
          const status = backend.failNextTrackStatus;
          backend.failNextTrackStatus = null;
          return route.fulfill({ status, json: {
            error: { status, message: "Synthetic transient playback failure" },
          } });
        }
        if (id === backend.silenceId && backend.failSilence) {
          return route.fulfill({ status: 503, json: { error: { status: 503, message: "Synthetic failure" } } });
        }
        if (id === backend.silenceId && backend.acknowledgeSilenceWithoutPlayback) {
          return route.fulfill({ status: 204 });
        }
        if (id !== backend.silenceId && backend.acknowledgeNextTrackWithoutPlayback) {
          backend.acknowledgeNextTrackWithoutPlayback = false;
          return route.fulfill({ status: 204 });
        }
        backend.state.item = {
          ...track(id, id === backend.silenceId ? backend.durationMs : 123456),
          ...(id === backend.silenceId && backend.silenceId !== SILENCE_ID
            ? { linked_from: { id: SILENCE_ID } } : {}),
        };
        backend.state.is_playing = true;
        if (Number.isFinite(call.body?.position_ms)) backend.state.progress_ms = call.body.position_ms;
        backend.state.device = { ...(backend.devices.find(item => item.id === call.deviceId) || backend.state.device) };
        return route.fulfill({ status: 204 });
      }
      if (method === "PUT" && url.pathname === "/v1/me/player/pause") {
        if (backend.leavePauseStateStale) backend.pendingPauseState = true;
        else backend.state.is_playing = false;
        return route.fulfill({ status: 204 });
      }
      if (method === "PUT" && url.pathname === "/v1/me/player") {
        const selected = backend.devices.find(item => item.id === call.body?.device_ids?.[0]);
        if (selected) {
          for (const item of backend.devices) item.is_active = item.id === selected.id;
          backend.state.device = { ...selected };
          backend.state.is_playing = !!call.body.play;
        }
        return route.fulfill({ status: 204 });
      }
    }
    backend.unexpected.push(`${method} ${url.hostname}${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  await page.addInitScript(({ selected, storedName, keepAlive, ipad, trackPlayed }) => {
    if (!sessionStorage.getItem("synthetic-idle-seeded")) {
      sessionStorage.setItem("synthetic-idle-seeded", "1");
      localStorage.setItem("s9000.auth", JSON.stringify({
        clientId: "synthetic-idle-client", refreshToken: "synthetic-idle-refresh",
      }));
      localStorage.setItem("s9000.deviceId", selected.id);
      localStorage.setItem("s9000.deviceName", storedName || selected.name);
      localStorage.setItem("s9000.volume", "35");
      localStorage.setItem("s9000.fadeInSec", "0");
      localStorage.setItem("s9000.fadeOutSec", "0");
      localStorage.setItem("unrelated-app-key", "keep");
      if (keepAlive === false) localStorage.setItem("s9000.ipadKeepAlive", "0");
      if (trackPlayed === false) localStorage.setItem("s9000.trackPlayed", "0");
    }
    if (ipad) {
      Object.defineProperties(navigator, {
        userAgent: { value: ipad, configurable: true },
        platform: { value: "iPad", configurable: true },
        maxTouchPoints: { value: 5, configurable: true },
      });
    }
  }, {
    selected, storedName: options.storedName,
    keepAlive: options.keepAlive, ipad: options.ipad ? IPAD_UA : null,
    trackPlayed: options.trackPlayed,
  });
  await page.goto("/");
  await expect(page.locator("#empty-state")).toBeVisible();
  await expect(page.locator("#auth-status")).toContainText("Connected");
  await expect(page.locator("#device-list .device")).toHaveCount(devices.length);
  return backend;
}

function plays(backend, uri = SILENCE_URI) {
  return backend.calls.filter(call => call.method === "PUT" && call.path === "/v1/me/player/play" &&
    (call.body?.uris?.includes(uri) || call.body?.offset?.uri === uri));
}

function commands(backend, path) {
  return backend.calls.filter(call => call.method !== "GET" && call.path === path);
}

async function idlePass(page) {
  await page.evaluate(async () => {
    await checkIdlePlayback();
    await transportQueue;
  });
}

async function loadLibrary(page) {
  const SQL = await getSql();
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic-idle.sqlite", mimeType: "application/x-sqlite3", buffer: Buffer.from(fixture(SQL)),
  });
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  await page.evaluate(() => databaseQueue);
}

async function setKeepAlive(page, enabled) {
  await page.locator("#btn-settings").click();
  await page.locator("#in-ipad-keepalive").setChecked(enabled);
  await page.locator("#btn-close-modal").click();
}

async function startSong(page) {
  await page.locator("#grid .cell").first().click();
  await expect(page.locator("#grid .cell").first()).toHaveClass(/playing/);
  await expect.poll(() => page.evaluate(() => nowPlaying?.paused)).toBe(false);
  await page.evaluate(() => transportQueue);
  await expect(page.locator("#song-playing-indicator")).toBeVisible();
  await expect(page.locator("#idle-playing-indicator")).toBeHidden();
}

async function deviceChoice(page, selected) {
  await page.locator("#device-pill").click();
  const row = page.locator("#device-picker-list .device").filter({ hasText: selected.name });
  const choice = row.getByRole("button", { name: "Use", exact: true });
  await expect(choice).toBeVisible();
  return choice;
}

async function selectDevice(page, selected) {
  const choice = await deviceChoice(page, selected);
  await choice.click();
}

async function librarySnapshot(page) {
  return page.evaluate(async () => {
    await databaseQueue;
    const digest = async bytes => bytes == null ? null : Array.from(new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    ), byte => byte.toString(16).padStart(2, "0")).join("");
    const record = await idbGet(IDB_KEY);
    const exportedDb = new SQL.Database(await exportWorkingDatabase());
    const exported = {};
    try {
      for (const table of ["PlaybackGroup", "Playback", "Sound", "AppSettings"]) {
        exported[table] = queryDatabase(exportedDb, `SELECT * FROM ${table}`).map(row => {
          // Export legitimately timestamps pending Playback edits on each call.
          if (table === "Playback") delete row.updatedTimestamp1970;
          return row;
        });
      }
    } finally {
      exportedDb.close();
    }
    return {
      database: await digest(db.export()),
      exported,
      pending: structuredClone(pending),
      baseline: await digest(baselineBytes),
      recovery: {
        version: record.version, identity: record.identity, bytes: await digest(record.bytes),
        pending: record.pending, baseline: await digest(record.baseline), baselineActive: record.baselineActive,
      },
      auth: localStorage.getItem(LS_AUTH),
      settings: [LS_VOLUME, LS_FADE_IN, LS_FADE_OUT, LS_TRACK_PLAYED, "unrelated-app-key"]
        .map(key => [key, localStorage.getItem(key)]),
      tracks: queryAll("SELECT trackID FROM Sound ORDER BY trackID"),
      played: queryAll("SELECT hasBeenPlayedRaw FROM Playback ORDER BY playbackUUIDRaw"),
    };
  });
}

async function expectIdleStatus(page) {
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-idle-state", "running");
  await expect(page.locator("#song-playing-indicator")).toBeHidden();
  await expect(page.locator("#idle-playing-indicator")).toBeVisible();
  await expect(page.locator("#idle-state-text")).toHaveAttribute("role", "status");
  await expect(page.locator("#idle-state-text")).toContainText(/silence/i);
  await expect(page.locator("#ipad-keepalive-status")).toBeHidden();
}

test("a saved iPad selection starts known silence automatically with the default enabled", async ({ page }) => {
  const backend = await prepare(page);
  await expect.poll(() => plays(backend).length).toBe(1);
  const play = plays(backend)[0];
  expect(play.deviceId).toBe(DEVICE_ID);
  expect(play.body).toEqual({
    context_uri: "spotify:album:synthetic-album",
    offset: { uri: SILENCE_URI },
    position_ms: 0,
  });
  const preceding = backend.calls.slice(0, backend.calls.indexOf(play));
  for (const path of ["/v1/me/player/devices", "/v1/me/player", `/v1/tracks/${SILENCE_ID}`]) {
    expect(preceding.some(call => call.method === "GET" && call.path === path)).toBe(true);
  }
  expect(commands(backend, "/v1/me/player")).toEqual([]);
  await expectIdleStatus(page);
  await expect(page.locator("#nowplaying")).toBeHidden();
  await expect(page.locator("#grid .cell")).toHaveCount(0);
  await page.locator("#btn-settings").click();
  await expect(page.locator("#in-ipad-keepalive")).toBeChecked();
  await expect(page.locator("#in-ipad-keepalive")).toHaveAccessibleName(/iPad|idle|awake/i);
  const playback = page.locator("#settings-panel-awake");
  await expect(playback.locator("#in-ipad-keepalive")).toHaveCount(1);
  const guidance = playback.locator("p").filter({ hasText: /Queue or Autoplay/i });
  await expect(guidance).toContainText(/queue/i);
  await expect(guidance).toContainText(/clos|hid|background/i);
  await expect(guidance).toContainText(/not necessarily|not guaranteed|cannot guarantee|can't guarantee/i);
});

test("a missing saved iPad requires a user-tapped Spotify wake and recovers once on return", async ({ page }) => {
  const selected = device();
  const backend = await prepare(page, { devices: [], selectedDevice: selected });
  await page.setViewportSize({ width: 320, height: 568 });
  const status = page.locator("#ipad-keepalive-status");
  const wake = status.getByRole("link", { name: "Open Spotify to wake iPad", exact: true });

  await expect(status).toBeVisible();
  await expect(wake).toHaveAttribute("href", `https://open.spotify.com/track/${SILENCE_ID}`);
  await expect(wake).toHaveAttribute("target", "_blank");
  await expect(wake).toHaveAttribute("rel", /noopener/);
  expect(plays(backend)).toEqual([]);
  expect(await page.evaluate(() =>
    playbackDiagnosticBuffer.some(event => event.event === "spotify-wake"))).toBe(false);

  for (const state of ["normal", "hover", "focus", "pressed"]) {
    if (state === "normal") await page.mouse.move(0, 0);
    if (state === "hover") await wake.hover();
    if (state === "focus") {
      await wake.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(wake).toBeFocused();
    }
    if (state === "pressed") {
      await wake.hover();
      await page.mouse.down();
    }
    try {
      expect((await buttonContrast(wake)).ratio).toBeGreaterThanOrEqual(4.5);
    } finally {
      if (state === "pressed") {
        await page.mouse.move(0, 0);
        await page.mouse.up();
      }
    }
  }

  const deviceReadsBeforeWake = backend.calls.filter(call =>
    call.method === "GET" && call.path === "/v1/me/player/devices").length;
  await wake.evaluate(link => {
    link.addEventListener("click", event => event.preventDefault(), { once: true });
    link.click();
  });
  expect(backend.calls.filter(call =>
    call.method === "GET" && call.path === "/v1/me/player/devices")).toHaveLength(deviceReadsBeforeWake);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  backend.devices = [selected];
  backend.state.device = { ...selected };
  backend.state.is_playing = false;
  const deviceReadsBeforeReturn = backend.calls.filter(call =>
    call.method === "GET" && call.path === "/v1/me/player/devices").length;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect.poll(() => plays(backend).length).toBe(1);
  expect(backend.calls.filter(call =>
    call.method === "GET" && call.path === "/v1/me/player/devices")).toHaveLength(deviceReadsBeforeReturn + 1);
  expect(await page.evaluate(() => playbackDiagnosticBuffer
    .filter(event => event.event === "spotify-wake")
    .map(event => event.stage))).toEqual(["request", "hidden", "return"]);
  await expectIdleStatus(page);
});

test("a Spotify wake return that remains missing stays blocked without polling or relaunching", async ({ page }) => {
  const backend = await prepare(page, { devices: [], selectedDevice: device() });
  const status = page.locator("#ipad-keepalive-status");
  const wake = status.getByRole("link", { name: "Open Spotify to wake iPad", exact: true });
  await expect(wake).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    playbackDiagnosticBuffer.filter(event => event.event === "idle-failed").length)).toBe(1);
  const failuresBefore = await page.evaluate(() =>
    playbackDiagnosticBuffer.filter(event => event.event === "idle-failed").length);
  const deviceReadsBefore = backend.calls.filter(call =>
    call.method === "GET" && call.path === "/v1/me/player/devices").length;

  await wake.evaluate(link => {
    link.addEventListener("click", event => event.preventDefault(), { once: true });
    link.click();
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect.poll(() => page.evaluate(() =>
    playbackDiagnosticBuffer.filter(event => event.event === "idle-failed").length)).toBe(failuresBefore + 1);
  expect(backend.calls.filter(call =>
    call.method === "GET" && call.path === "/v1/me/player/devices")).toHaveLength(deviceReadsBefore + 1);
  expect(plays(backend)).toEqual([]);
  expect(await page.evaluate(() => ({
    blocked: idleBlocked,
    timer: idleTimer,
    pendingWake: spotifyWakePending,
    stages: playbackDiagnosticBuffer
      .filter(event => event.event === "spotify-wake")
      .map(event => event.stage),
  }))).toEqual({
    blocked: true,
    timer: null,
    pendingWake: null,
    stages: ["request", "hidden", "return"],
  });
  await expect(status).toBeVisible();
  await expect(status.getByRole("link", { name: "Open Spotify to wake iPad", exact: true })).toBeVisible();
});

test("an explicit Start on a missing saved iPad offers wake without opening Spotify automatically", async ({ page }) => {
  const backend = await prepare(page, {
    devices: [],
    selectedDevice: device(),
    keepAlive: false,
    trackPlayed: false,
  });
  await loadLibrary(page);
  await page.locator("#grid .cell").first().click();
  await page.evaluate(() => transportQueue);

  const status = page.locator("#transport-status");
  await expect(status).toBeVisible();
  await expect(status.getByRole("link", { name: "Open Spotify to wake iPad", exact: true }))
    .toHaveAttribute("href", `https://open.spotify.com/track/${SILENCE_ID}`);
  expect(plays(backend, SONG_URI)).toEqual([]);
  expect(await page.evaluate(() =>
    playbackDiagnosticBuffer.some(event => event.event === "spotify-wake"))).toBe(false);
});

test("a missing non-iPad device never receives the Spotify wake action", async ({ page }) => {
  const backend = await prepare(page, {
    devices: [],
    selectedDevice: device(DEVICE_ID, "Synthetic Laptop", { supports_volume: true }),
    keepAlive: false,
    trackPlayed: false,
  });
  await loadLibrary(page);
  await page.locator("#grid .cell").first().click();
  await page.evaluate(() => transportQueue);

  const status = page.locator("#transport-status");
  await expect(status).toBeVisible();
  await expect(status).toContainText(/No active Spotify device/i);
  await expect(status.getByRole("link", { name: "Open Spotify to wake iPad", exact: true })).toHaveCount(0);
  expect(plays(backend, SONG_URI)).toEqual([]);
});

test("idle silence follows Spotify's market-relinked track URI", async ({ page }) => {
  const resolved = "synthetic-market-silence";
  const resolvedUri = `spotify:track:${resolved}`;
  const backend = await prepare(page, { silenceId: resolved });
  await expect.poll(() => plays(backend, resolvedUri).length).toBe(1);
  expect(plays(backend, SILENCE_URI)).toEqual([]);
  const metadata = backend.calls.find(call =>
    call.method === "GET" && call.path === `/v1/tracks/${SILENCE_ID}`);
  expect(metadata.market).toBe("from_token");
  expect(plays(backend, resolvedUri)[0].body).toEqual({
    context_uri: "spotify:album:synthetic-album",
    offset: { uri: resolvedUri },
    position_ms: 0,
  });
  await expectIdleStatus(page);
});

test("an acknowledged iPad Start no-op gets one bounded confirmation retry", async ({ page }) => {
  const backend = await prepare(page, { keepAlive: false, trackPlayed: false });
  await loadLibrary(page);
  backend.acknowledgeNextTrackWithoutPlayback = true;

  await startSong(page);

  expect(plays(backend, SONG_URI)).toHaveLength(2);
  expect(backend.calls.filter(call =>
    call.method === "GET" && call.path === "/v1/me/player").length).toBe(2);
  expect(backend.calls.filter(call =>
    call.method === "GET" && call.path === "/v1/me/player/devices").length).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => ({
    uuid: nowPlaying?.uuid,
    paused: nowPlaying?.paused,
    detached: nowPlaying?.detached,
    confirmations: playbackDiagnosticBuffer
      .filter(event => event.event === "track-confirmation")
      .map(event => event.outcome),
  }))).toMatchObject({
    uuid: ids.firstPlayback,
    paused: false,
    detached: false,
    confirmations: ["unconfirmed", "confirmed"],
  });
});

test("a transient iPad Start 502 gets one bounded device recovery retry", async ({ page }) => {
  const backend = await prepare(page, {
    keepAlive: false,
    trackPlayed: false,
    failNextTrackStatus: 502,
  });
  await loadLibrary(page);

  await startSong(page);

  expect(plays(backend, SONG_URI)).toHaveLength(2);
  expect(commands(backend, "/v1/me/player")).toHaveLength(1);
  expect(await page.evaluate(() => ({
    uuid: nowPlaying?.uuid,
    paused: nowPlaying?.paused,
    detached: nowPlaying?.detached,
    failures: playbackDiagnosticBuffer
      .filter(event => event.event === "play-failed")
      .map(event => ({ purpose: event.purpose, attempt: event.attempt, status: event.status })),
    acknowledgements: playbackDiagnosticBuffer
      .filter(event => event.event === "play-acknowledged" && event.purpose === "start")
      .map(event => ({ attempt: event.attempt, recovered: event.recovered })),
  }))).toMatchObject({
    uuid: ids.firstPlayback,
    paused: false,
    detached: false,
    failures: [{ purpose: "start", attempt: 1, status: 502 }],
    acknowledgements: [{ attempt: 2, recovered: true }],
  });
});

test("zero reported iPad volume blocks idle playback without sending a volume command", async ({ page }) => {
  const backend = await prepare(page, {
    devices: [device(DEVICE_ID, "Synthetic iPad", { volume_percent: 0 })],
  });
  await idlePass(page);
  expect(plays(backend)).toEqual([]);
  await expect(page.locator("#ipad-keepalive-status")).toContainText(/volume at 0/i);
  await expect(page.locator("#ipad-keepalive-status")).toContainText(/one notch/i);
  expect(await page.evaluate(() =>
    playbackDiagnosticBuffer.some(entry =>
      entry.event === "idle-state-read" && entry.volumePercent === 0))).toBe(true);
});

test("Settings downloads a sanitized playback diagnostic JSON file", async ({ page }) => {
  await prepare(page);
  await expectIdleStatus(page);
  await page.locator("#btn-settings").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download JSON", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^Sarcastaball-playback-diagnostics-\d{8}T\d{6}Z\.json$/);
  const reportText = await fs.readFile(await download.path(), "utf8");
  const report = JSON.parse(reportText);
  expect(report.format).toBe("sarcastaball-playback-diagnostics");
  expect(report.runtime).toMatchObject({
    hasAuth: true,
    selectedDeviceStored: true,
    persistenceComplete: true,
  });
  expect(report.events.length).toBeGreaterThan(0);
  for (const privateValue of [
    "synthetic-idle-client",
    "synthetic-idle-refresh",
    "synthetic-idle-access",
    DEVICE_ID,
    "Synthetic iPad",
    SILENCE_ID,
    "Synthetic listener",
    SONG_ID,
  ]) {
    expect(reportText).not.toContain(privateValue);
  }
});

test("Settings shares sanitized playback diagnostics through the native share sheet", async ({ page }) => {
  await prepare(page);
  await expectIdleStatus(page);
  await page.evaluate(() => {
    window.sharedDiagnostic = null;
    Object.defineProperties(navigator, {
      canShare: {
        configurable: true,
        value: data => data.files?.length === 1,
      },
      share: {
        configurable: true,
        value: async data => {
          window.sharedDiagnostic = {
            filename: data.files[0].name,
            type: data.files[0].type,
            text: await data.files[0].text(),
          };
        },
      },
    });
  });
  await page.locator("#btn-settings").click();
  await page.getByRole("button", { name: "Share diagnostics", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sharedDiagnostic?.filename || null))
    .toMatch(/^Sarcastaball-playback-diagnostics-\d{8}T\d{6}Z\.json$/);
  const shared = await page.evaluate(() => window.sharedDiagnostic);
  expect(shared.type).toBe("application/json");
  expect(JSON.parse(shared.text).format).toBe("sarcastaball-playback-diagnostics");
  expect(shared.text).not.toContain("synthetic-idle-client");
  expect(shared.text).not.toContain(DEVICE_ID);
  await expect(page.locator("#playback-diagnostics-status")).toContainText(/shared/i);
});

test("automatic idle silence recovers from a reasonless 404 and stale active flag", async ({ page }) => {
  const backend = await prepare(page, { failNextPlayWithoutReason: true });
  await expect.poll(() => plays(backend).length).toBe(2);
  expect(commands(backend, "/v1/me/player").map(call => call.body)).toEqual([
    { device_ids: [DEVICE_ID], play: false },
  ]);
  await expectIdleStatus(page);
});

test("Start reactivates an inactive selected device after Spotify reports NO_ACTIVE_DEVICE", async ({ page }) => {
  const inactive = device(DEVICE_ID, "Synthetic iPad", { is_active: false });
  const backend = await prepare(page, {
    devices: [inactive], stateDevice: inactive, keepAlive: false,
    failNextPlayNoActive: true,
  });
  await loadLibrary(page);
  await page.locator("#grid .cell").first().click();
  await expect(page.locator("#grid .cell").first()).toHaveClass(/playing/);
  await expect.poll(() => plays(backend, SONG_URI).length).toBe(2);
  expect(commands(backend, "/v1/me/player").map(call => call.body)).toEqual([
    { device_ids: [DEVICE_ID], play: false },
  ]);
  expect(backend.devices[0].is_active).toBe(true);
  await expect(page.locator("#transport-status")).toBeHidden();
});

test("idle status actions stay readable, keyboard-accessible and within a narrow screen", async ({ page }) => {
  const backend = await prepare(page, { repeatState: "track" });
  await page.setViewportSize({ width: 320, height: 568 });
  const status = page.locator("#ipad-keepalive-status");
  await expect(status).toBeVisible();
  for (const action of await status.getByRole("button").all()) {
    for (const state of ["normal", "hover", "focus", "pressed"]) {
      if (state === "normal") await page.mouse.move(0, 0);
      if (state === "hover") await action.hover();
      if (state === "focus") {
        await action.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(action).toBeFocused();
      }
      if (state === "pressed") {
        await action.hover();
        await page.mouse.down();
      }
      try {
        expect((await buttonContrast(action)).ratio).toBeGreaterThanOrEqual(4.5);
      } finally {
        if (state === "pressed") {
          // Release away from the button so measuring its pressed state does not act.
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
      }
    }
    await action.scrollIntoViewIfNeeded();
    const bounds = await action.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(568);
  }
  backend.state.repeat_state = "off";
  await status.getByRole("button", { name: "Retry", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => plays(backend).length).toBe(1);
});
for (const name of ["Synthetic Laptop", "Synthetic iPhone"]) {
  test(`${name} is ineligible even from an iPad browser with a stale iPad name`, async ({ page }) => {
    const backend = await prepare(page, {
      ipad: true, storedName: "Stale iPad name",
      devices: [device(DEVICE_ID, name), device(OTHER_DEVICE_ID, "Unselected iPad")],
    });
    await idlePass(page);
    expect(commands(backend, "/v1/me/player/play")).toEqual([]);
    expect(commands(backend, "/v1/me/player")).toEqual([]);
    expect(commands(backend, "/v1/me/player/pause")).toEqual([]);
  });
}

for (const name of ["Synthetic Laptop", ""]) {
  test(`fresh playback state with ${name ? "a non-iPad" : "no"} device name overrides an iPad device-list entry`, async ({ page }) => {
    const backend = await prepare(page, { ipad: true, stateDevice: device(DEVICE_ID, name) });
    await idlePass(page);
    expect(commands(backend, "/v1/me/player/play")).toEqual([]);
    expect(commands(backend, "/v1/me/player/pause")).toEqual([]);
    expect(commands(backend, "/v1/me/player")).toEqual([]);
  });
}

test("explicit selection of a mixed-case iPaD starts idle silence without a controller-UA requirement", async ({ page }) => {
  const selected = device(OTHER_DEVICE_ID, "Synthetic iPaD mini");
  const backend = await prepare(page, { devices: [device(DEVICE_ID, "Synthetic Laptop"), selected] });
  await idlePass(page);
  expect(plays(backend)).toEqual([]);
  await selectDevice(page, selected);
  await expect.poll(() => plays(backend).length).toBe(1);
  expect(plays(backend)[0].deviceId).toBe(OTHER_DEVICE_ID);
  expect(commands(backend, "/v1/me/player").map(call => call.body)).toEqual([
    { device_ids: [OTHER_DEVICE_ID], play: false },
  ]);
  await expectIdleStatus(page);
});

for (const differentDevice of [false, true]) {
  test(`idle checks do not replace external music${differentDevice ? " on another device or transfer playback" : ""}`, async ({ page }) => {
    const backend = await prepare(page, {
      playing: true,
      ...(differentDevice ? { stateDevice: device(OTHER_DEVICE_ID, "Synthetic Laptop") } : {}),
    });
    await idlePass(page);
    expect(commands(backend, "/v1/me/player/play")).toEqual([]);
    expect(commands(backend, "/v1/me/player/pause")).toEqual([]);
    expect(commands(backend, "/v1/me/player")).toEqual([]);
    expect(backend.state.is_playing).toBe(true);
  });
}

test("idle silence leaves SQLite, pending edits, recovery, auth and exports untouched", async ({ page }) => {
  const backend = await prepare(page, { keepAlive: false });
  await loadLibrary(page);
  await page.evaluate(id => { setCellColor(id, 2); return databaseQueue; }, ids.firstPlayback);
  const before = await librarySnapshot(page);
  await setKeepAlive(page, true);
  await expect.poll(() => plays(backend).length).toBe(1);
  await idlePass(page);
  expect(await librarySnapshot(page)).toEqual(before);
  expect(before.played).toEqual([{ hasBeenPlayedRaw: 0 }, { hasBeenPlayedRaw: 0 }]);
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  await expect(page.locator("#grid .cell.played, #grid .cell.playing")).toHaveCount(0);
  await expect(page.locator("#nowplaying")).toBeHidden();
});

test("iPad Pause plays silence but Resume restores the original song and paused offset without volume calls", async ({ page }) => {
  const backend = await prepare(page, {
    keepAlive: false, trackPlayed: false, ipad: true,
    devices: [device(DEVICE_ID, "Synthetic iPad", { supports_volume: true })],
  });
  await loadLibrary(page);
  await startSong(page);
  await setKeepAlive(page, true);
  await idlePass(page);
  expect(plays(backend)).toEqual([]);
  backend.state.progress_ms = 42500;
  await page.evaluate(() => reconcilePlayback());
  backend.leavePauseStateStale = true;
  const pauseStart = backend.calls.length;
  await page.locator("#np-pause").click();
  await expect.poll(() => plays(backend).length).toBe(1);
  await page.evaluate(() => transportQueue);
  const handoff = backend.calls.slice(pauseStart, backend.calls.indexOf(plays(backend)[0]) + 1);
  expect(handoff.filter(call => call.method === "GET" && call.path === "/v1/me/player")).toHaveLength(2);
  expect(handoff.filter(call => call.method === "GET" && call.path === "/v1/me/player/devices")).toHaveLength(1);
  expect(await page.evaluate(() =>
    playbackDiagnosticBuffer.some(entry =>
      entry.event === "idle-state-read" && entry.stage === "pause-settle"))).toBe(true);
  const paused = await page.evaluate(() => ({
    uuid: nowPlaying?.uuid, trackId: playingSnapshot?.trackid,
    paused: nowPlaying?.paused, progressPaused: progress?.paused, position: currentPositionMs(),
  }));
  expect(paused).toMatchObject({ uuid: ids.firstPlayback, trackId: SONG_ID, paused: true, progressPaused: true });
  expect(paused.position).toBeGreaterThanOrEqual(42500);
  expect(paused.position).toBeLessThan(45000);
  await expect(page.locator("#np-title")).toHaveText("Synthetic track");
  await expect(page.locator("#grid .cell").first()).toHaveClass(/paused/);
  await page.evaluate(() => reconcilePlayback());
  expect(await page.evaluate(() => currentPositionMs())).toBe(paused.position);
  expect(await page.evaluate(() => nowPlaying?.uuid)).toBe(ids.firstPlayback);
  await page.locator("#np-pause").click();
  await expect.poll(() => plays(backend, SONG_URI).length).toBe(2);
  const resumed = plays(backend, SONG_URI).at(-1);
  expect(resumed.deviceId).toBe(DEVICE_ID);
  expect(resumed.body.position_ms).toBe(Math.round(paused.position));
  await expect.poll(() => page.evaluate(() => nowPlaying?.paused === false && progress?.paused === false)).toBe(true);
  await expect(page.locator("#vol-rail")).toBeHidden();
  await expect(page.locator("#grid .cell").first()).not.toHaveClass(/paused/);
  expect(backend.state.item.id).toBe(SONG_ID);
});

test("Stop clears the song, keeps silence, and disabling pauses only owned silence and persists across reload", async ({ page }) => {
  const backend = await prepare(page, { keepAlive: false, trackPlayed: false });
  await loadLibrary(page);
  await startSong(page);
  await setKeepAlive(page, true);
  await idlePass(page);
  const before = await librarySnapshot(page);
  await page.locator("#np-stop").click();
  await expect.poll(() => plays(backend).length).toBe(1);
  await expect(page.locator("#nowplaying")).toBeHidden();
  await expect(page.locator("#grid .cell.playing")).toHaveCount(0);
  expect(await page.evaluate(() => nowPlaying === null && progress === null)).toBe(true);
  expect(await librarySnapshot(page)).toEqual(before);
  const start = backend.calls.length;
  const paused = commands(backend, "/v1/me/player/pause").length;
  await setKeepAlive(page, false);
  await expect.poll(() => commands(backend, "/v1/me/player/pause").length).toBe(paused + 1);
  await page.evaluate(() => transportQueue);
  const disableCalls = backend.calls.slice(start);
  const observed = disableCalls.findIndex(call => call.method === "GET" && call.path === "/v1/me/player");
  const pause = disableCalls.findIndex(call => call.method === "PUT" && call.path === "/v1/me/player/pause");
  expect(observed).toBeGreaterThanOrEqual(0);
  expect(pause).toBeGreaterThan(observed);
  expect(await page.evaluate(() => localStorage.getItem("s9000.ipadKeepAlive"))).toBe("0");
  expect(backend.state.is_playing).toBe(false);
  await page.reload();
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  await expect(page.locator("#auth-status")).toContainText("Connected");
  await idlePass(page);
  expect(plays(backend)).toHaveLength(1);
  await page.locator("#btn-settings").click();
  await expect(page.locator("#in-ipad-keepalive")).not.toBeChecked();
});

for (const differentDevice of [false, true]) {
  test(`disable does not pause ${differentDevice ? "silence on another device" : "unrelated music that replaced idle silence"}`, async ({ page }) => {
    const backend = await prepare(page);
    await expect.poll(() => plays(backend).length).toBe(1);
    if (differentDevice) backend.state.device = device(OTHER_DEVICE_ID, "Synthetic other iPad");
    else backend.state.item = track("synthetic-external-replacement");
    const paused = commands(backend, "/v1/me/player/pause").length;
    await setKeepAlive(page, false);
    await idlePass(page);
    expect(commands(backend, "/v1/me/player/pause")).toHaveLength(paused);
    expect(backend.state.is_playing).toBe(true);
  });
}

for (const durationMs of [32500, 251750]) {
  test(`renewal uses the fetched ${durationMs}ms duration and never restarts early`, async ({ page }) => {
    const backend = await prepare(page, { durationMs });
    await expect.poll(() => plays(backend).length).toBe(1);
    backend.state.progress_ms = 1000;
    await idlePass(page);
    expect(plays(backend)).toHaveLength(1);
    backend.state.progress_ms = durationMs - 100;
    await idlePass(page);
    expect(plays(backend)).toHaveLength(2);
    expect(plays(backend)[1]).toMatchObject({
      deviceId: DEVICE_ID,
      body: {
        context_uri: "spotify:album:synthetic-album",
        offset: { uri: SILENCE_URI },
        position_ms: 0,
      },
    });
    await idlePass(page);
    expect(plays(backend)).toHaveLength(2);
    expect(backend.calls.filter(call => call.method === "GET" && call.path === `/v1/tracks/${SILENCE_ID}`)).toHaveLength(1);
    expect(commands(backend, "/v1/me/player")).toEqual([]);
    await expect(page.locator("#nowplaying")).toBeHidden();
  });
}

test("the visible page automatically renews through several full cycles despite slow state replies", async ({ page }) => {
  await prepare(page, { keepAlive: false, ipad: true });
  await page.clock.install();
  await page.evaluate(() => {
    const duration = 600000;
    const device = { id: "synthetic-idle-device", name: "Synthetic iPad", is_restricted: false, supports_volume: false };
    window.renewalTiming = { startedAt: null, naturalEnds: 0, restarts: [], commands: [] };
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    api = async (url, options = {}) => {
      const path = url.split("?")[0];
      const timing = window.renewalTiming;
      const elapsed = timing.startedAt === null ? 0 : performance.now() - timing.startedAt;
      if (timing.startedAt !== null && elapsed >= duration) {
        timing.naturalEnds++;
        timing.startedAt = null;
      }
      if (path === "/me/player/devices") {
        await wait(7000);
        return { devices: timing.naturalEnds ? [] : [device] };
      }
      if (path === "/me/player" && !options.method) {
        const state = timing.naturalEnds ? null : {
          device, repeat_state: "off", is_playing: timing.startedAt !== null, progress_ms: elapsed,
          item: { id: timing.startedAt === null ? "synthetic-song" : IDLE_SILENCE_TRACK, duration_ms: duration },
        };
        await wait(7000);
        return state;
      }
      if (path === `/tracks/${IDLE_SILENCE_TRACK}`) {
        await wait(7000);
        return {
          id: IDLE_SILENCE_TRACK,
          uri: `spotify:track:${IDLE_SILENCE_TRACK}`,
          album: { uri: "spotify:album:synthetic-album" },
          duration_ms: duration,
          is_playable: true,
        };
      }
      if (path !== "/me/player/play" || options.method !== "PUT") throw new Error("Unexpected renewal command");
      timing.commands.push({ path, body: JSON.parse(options.body) });
      await wait(2000);
      if (timing.startedAt !== null) timing.restarts.push(performance.now() - timing.startedAt);
      timing.startedAt = performance.now();
      return null;
    };
    localStorage.setItem(LS_IPAD_KEEPALIVE, "1");
    idleBlocked = false;
    void checkIdlePlayback();
  });
  // Move time normally, rather than invoking the idle checker or fast-forwarding
  // past scheduled callbacks. Native Web Lock grants also get an event-loop turn.
  for (let elapsed = 0; elapsed < 1860000; elapsed += 5000) await page.clock.runFor(5000);
  await page.evaluate(() => { idleReady = false; cancelIdleCheck(); });
  await page.clock.runFor(30000);
  await page.evaluate(() => transportQueue);
  const timing = await page.evaluate(() => window.renewalTiming);
  expect(timing.naturalEnds).toBe(0);
  expect(timing.restarts.length).toBeGreaterThanOrEqual(3);
  for (const interval of timing.restarts) {
    expect(interval).toBeGreaterThanOrEqual(500000);
    expect(interval).toBeLessThan(590000);
  }
  for (const command of timing.commands) {
    expect(command).toEqual({
      path: "/me/player/play",
      body: {
        context_uri: "spotify:album:synthetic-album",
        offset: { uri: SILENCE_URI },
        position_ms: 0,
      },
    });
  }
  await expect(page.locator("#ipad-keepalive-status")).toBeHidden();
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-idle-state", "running");
});

test("hidden pages do not renew; returning visible makes a fresh foreground check", async ({ page }) => {
  const backend = await prepare(page);
  await expect.poll(() => plays(backend).length).toBe(1);
  await page.clock.install();
  backend.state.progress_ms = backend.durationMs - 100;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await idlePass(page);
  await page.clock.fastForward(backend.durationMs * 2);
  await page.evaluate(() => transportQueue);
  expect(plays(backend)).toHaveLength(1);
  const start = backend.calls.length;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => plays(backend).length).toBe(2);
  const fresh = backend.calls.slice(start);
  for (const path of ["/v1/me/player/devices", "/v1/me/player"]) {
    expect(fresh.some(call => call.method === "GET" && call.path === path)).toBe(true);
  }
});

test("pagehide cancels an in-flight renewal and leaves no automatic renewal schedule", async ({ page }) => {
  const backend = await prepare(page);
  await expect.poll(() => plays(backend).length).toBe(1);
  await idlePass(page);
  backend.state.progress_ms = backend.durationMs - 100;
  const hold = backend.holdNext("state");
  try {
    await page.evaluate(() => { window.idleRace = checkIdlePlayback(); });
    await expect.poll(() => hold.entered).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  } finally {
    hold.release();
  }
  await page.evaluate(() => window.idleRace);
  await page.clock.install();
  await page.clock.fastForward(backend.durationMs * 2);
  await page.evaluate(() => transportQueue);
  expect(plays(backend)).toHaveLength(1);
});

for (const stage of ["state", "token"]) {
  for (const intent of ["Start", "disable", "device change"]) {
    test(`a delayed ${stage} response cannot start silence after newer ${intent} intent`, async ({ page }) => {
      const other = device(OTHER_DEVICE_ID, "Synthetic Laptop");
      const backend = await prepare(page, {
        devices: [device(), other], playing: true, trackPlayed: false,
      });
      await loadLibrary(page);
      await idlePass(page);
      // The picker itself needs a token, so render its choice before holding refresh.
      const choice = intent === "device change" ? await deviceChoice(page, other) : null;
      backend.state.is_playing = false;
      const hold = backend.holdNext(stage);
      try {
        await page.evaluate(stage => {
          if (stage === "token") accessTokenExpiresAt = 0;
          window.idleRace = checkIdlePlayback();
        }, stage);
        await expect.poll(() => hold.entered).toBe(true);
        if (intent === "Start") await page.locator("#grid .cell").first().click();
        else if (intent === "disable") await setKeepAlive(page, false);
        else await choice.click();
      } finally {
        hold.release();
      }
      await page.evaluate(async () => { await window.idleRace; await transportQueue; });
      if (intent === "Start") {
        await expect.poll(() => plays(backend, SONG_URI).length).toBe(1);
        await expect(page.locator("#grid .cell").first()).toHaveClass(/playing/);
        expect(backend.state.item.id).toBe(SONG_ID);
      } else if (intent === "device change") {
        await expect.poll(() => page.evaluate(() => localStorage.getItem("s9000.deviceId"))).toBe(OTHER_DEVICE_ID);
      } else {
        expect(await page.evaluate(() => localStorage.getItem("s9000.ipadKeepAlive"))).toBe("0");
      }
      await idlePass(page);
      expect(plays(backend)).toEqual([]);
    });
  }
}

test("failed silence leaves the song paused and data intact, with explicit Retry instead of automatic hammering", async ({ page }) => {
  const backend = await prepare(page, { keepAlive: false, trackPlayed: false });
  await loadLibrary(page);
  await page.evaluate(id => { setCellColor(id, 2); return databaseQueue; }, ids.firstPlayback);
  await startSong(page);
  await setKeepAlive(page, true);
  await idlePass(page);
  const before = await librarySnapshot(page);
  backend.failSilence = true;
  await page.locator("#np-pause").click();
  const status = page.locator("#ipad-keepalive-status");
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toContainText(/not confirmed|unavailable|failed|could not|couldn't/i);
  await expect(status.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => nowPlaying?.paused && progress?.paused)).toBe(true);
  expect(plays(backend)).toHaveLength(1);
  expect(backend.state.is_playing).toBe(false);
  await expect(page.locator("#np-title")).toHaveText("Synthetic track");
  await expect(page.locator("#grid .cell").first()).toHaveClass(/paused/);
  expect(await librarySnapshot(page)).toEqual(before);
  await page.clock.install();
  await page.clock.fastForward(backend.durationMs * 2);
  await page.waitForLoadState("networkidle");
  expect(plays(backend)).toHaveLength(1);
  backend.failSilence = false;
  await status.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => plays(backend).length).toBe(2);
  await expectIdleStatus(page);
  await expect(status.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => nowPlaying?.paused && progress?.paused)).toBe(true);
  expect(await librarySnapshot(page)).toEqual(before);
});

test("a success-shaped silence no-op cannot spin the ball or poll Spotify repeatedly", async ({ page }) => {
  const backend = await prepare(page, { keepAlive: false, trackPlayed: false });
  await loadLibrary(page);
  await startSong(page);
  await setKeepAlive(page, true);
  await idlePass(page);
  backend.acknowledgeSilenceWithoutPlayback = true;
  backend.leavePauseStateStale = true;
  const handoffStart = backend.calls.length;

  await page.locator("#np-pause").click();
  const status = page.locator("#ipad-keepalive-status");
  await expect(status).toBeVisible();
  await expect(status).toContainText(/acknowledged two silence requests|not confirmed/i);
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-idle-state", "attention");
  await expect(page.locator("#idle-playing-indicator")).toBeHidden();
  await expect.poll(() => plays(backend, SILENCE_URI).length).toBe(2);

  const handoff = backend.calls.slice(handoffStart);
  expect(handoff.filter(call => call.method === "GET" && call.path === "/v1/me/player")).toHaveLength(4);
  expect(handoff.filter(call => call.method === "GET" && call.path === "/v1/me/player/devices")).toHaveLength(2);
  expect(handoff.filter(call => call.method === "PUT" && call.path === "/v1/me/player")).toHaveLength(1);
  expect(handoff.filter(call => call.method === "PUT" && call.path === "/v1/me/player/play")).toHaveLength(2);
  expect(handoff).toHaveLength(11);
  const retryRequest = await page.evaluate(() =>
    createPlaybackDiagnosticExport().report.events.find(event =>
      event.event === "play-request" && event.purpose === "silence" && event.attempt === 2));
  expect(retryRequest).toMatchObject({
    requestMode: "album-context",
    recovered: true,
  });

  await page.locator("#btn-settings").click();
  await expect(page.getByRole("button", { name: "Share diagnostics", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download JSON", exact: true })).toBeVisible();
  await expect(page.locator("#modal")).toContainText(/excludes credentials/i);
});

for (const repeatState of ["track", "context", null]) {
  test(`repeat state ${repeatState || "unknown"} blocks silence without changing Spotify repeat`, async ({ page }) => {
    const backend = await prepare(page, { repeatState });
    await idlePass(page);
    expect(plays(backend)).toEqual([]);
    const status = page.locator("#ipad-keepalive-status");
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toContainText(/repeat|loop/i);
    await expect(status.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    expect(backend.state.repeat_state).toBe(repeatState);
    backend.state.repeat_state = "off";
    await status.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => plays(backend).length).toBe(1);
  });
}

test("a restricted selected iPad never receives an idle playback command", async ({ page }) => {
  const backend = await prepare(page, { devices: [device(DEVICE_ID, "Synthetic iPad", { is_restricted: true })] });
  await idlePass(page);
  expect(commands(backend, "/v1/me/player/play")).toEqual([]);
  expect(commands(backend, "/v1/me/player/pause")).toEqual([]);
  expect(commands(backend, "/v1/me/player")).toEqual([]);
});

for (const blocked of ["offline device", "unavailable silence"]) {
  test(`${blocked} fails safely with a visible retry rather than a fallback device or track`, async ({ page }) => {
    const backend = await prepare(page, { keepAlive: false });
    if (blocked === "offline device") backend.devices = [device(OTHER_DEVICE_ID, "Unselected iPad")];
    if (blocked === "unavailable silence") backend.playable = false;
    await setKeepAlive(page, true);
    await idlePass(page);
    expect(commands(backend, "/v1/me/player/play")).toEqual([]);
    expect(commands(backend, "/v1/me/player")).toEqual([]);
    const status = page.locator("#ipad-keepalive-status");
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute("role", "status");
    await expect(status.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("s9000.auth")).refreshToken)).toBe("synthetic-idle-refresh");
  });
}
