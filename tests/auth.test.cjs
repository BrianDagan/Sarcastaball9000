const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, createOrigin, deferred } = require("./helpers/app.cjs");
const { captureNavigation, startLogin, callback, holdAuthLock, waitFor, settlePeers } = require("./helpers/auth.cjs");
const { databaseApp, getSql, fixture, ids } = require("./helpers/database.cjs");

function signedIn(t) {
  const app = createApp();
  t.after(app.close);
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({
    clientId: "synthetic-client",
    refreshToken: "synthetic-refresh",
  }));
  return app;
}

function tokenResponse() {
  return new Response(JSON.stringify({
    access_token: "synthetic-access",
    refresh_token: "synthetic-rotated",
    expires_in: 3600,
  }));
}

function authenticatedApi(t) {
  const app = signedIn(t);
  app.run("accessToken = 'synthetic-access'; accessTokenExpiresAt = Date.now() + 60000; accessTokenAuth = localStorage.getItem(LS_AUTH)");
  return app;
}

test("invalid saved sign-in offers reconnection without recommending data erasure", t => {
  const app = signedIn(t);
  app.window.localStorage.setItem("s9000.auth", "synthetic-invalid-json");
  app.window.localStorage.setItem("s9000.volume", "35");
  assert.equal(app.run("getAuth()"), null);
  const message = app.window.document.getElementById("auth-status").textContent;
  assert.match(message, /Reconnect in Setup/);
  assert.doesNotMatch(message, /Log out to clear|synthetic-invalid-json/);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), "synthetic-invalid-json");
  assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
});

for (const [label, status, body] of [
  ["empty", 200, ""],
  ["whitespace", 200, "\r\n "],
  ["text acknowledgement", 200, "OK"],
  ["accepted", 202, "Accepted"],
  ["no content", 204, null],
]) {
  test(`playback commands accept successful ${label} responses without requiring JSON`, async t => {
    const app = authenticatedApi(t);
    app.window.fetch = async () => new Response(body, { status });
    for (const path of ["/me/player", "/me/player/play?device_id=synthetic", "/me/player/pause", "/me/player/seek?position_ms=5000", "/me/player/volume?volume_percent=20"]) {
      assert.equal(await app.run(`api(${JSON.stringify(path)}, {method:'PUT'})`), null);
    }
  });
}

test("JSON query responses are parsed and malformed bodies still fail without disclosure", async t => {
  const app = authenticatedApi(t);
  app.window.fetch = async () => new Response(JSON.stringify({ is_playing: false }));
  assert.equal((await app.run("api('/me/player')")).is_playing, false);
  app.window.fetch = async () => new Response("synthetic-private-response-must-not-surface");
  for (const path of ["/me/player", "/me/player/devices", "/me"]) {
    await assert.rejects(app.run(`api(${JSON.stringify(path)})`), error => {
      assert.match(error.message, /unreadable response/);
      assert.doesNotMatch(error.message, /must-not-surface/);
      return true;
    });
  }
});

test("failed playback commands still report HTTP errors regardless of response format", async t => {
  const app = authenticatedApi(t);
  for (const [status, body] of [[401, ""], [403, "synthetic-private-error"], [429, '{"error":{"reason":"QUOTA_EXCEEDED"}}'], [500, "<html>synthetic-private-error</html>"]]) {
    app.window.fetch = async () => new Response(body, { status, headers: { "Retry-After": "2" } });
    await assert.rejects(app.run("api('/me/player/pause', {method:'PUT'})"), error => {
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 2000);
      assert.doesNotMatch(error.message, /synthetic-private/);
      if (status === 429) assert.equal(error.reason, "QUOTA_EXCEEDED");
      return true;
    });
  }
});

test("concurrent requests share one refresh", async t => {
  const app = signedIn(t);
  const request = deferred();
  let calls = 0;
  app.window.fetch = () => { calls++; return request.promise; };
  const first = app.run("getAccessToken()");
  const second = app.run("getAccessToken()");
  assert.equal(calls, 1);
  request.resolve(tokenResponse());
  assert.equal(await first, "synthetic-access");
  assert.equal(await second, "synthetic-access");
});

test("a refresh resolving after logout cannot restore credentials", async t => {
  const app = signedIn(t);
  const request = deferred();
  app.window.fetch = () => request.promise;
  const refresh = app.run("getAccessToken()");
  app.run("invalidateAuthWork(); localStorage.removeItem(LS_AUTH)");
  request.resolve(tokenResponse());
  await assert.rejects(refresh, /canceled/);
  assert.equal(app.run("accessToken"), null);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), null);
});

test("changed persistent sign-in invalidates refresh even before a storage event", async t => {
  const app = signedIn(t);
  const request = deferred();
  app.window.fetch = () => request.promise;
  const refresh = app.run("getAccessToken()");
  app.window.localStorage.removeItem("s9000.auth");
  request.resolve(tokenResponse());
  await assert.rejects(refresh, /changed/);
  assert.equal(app.run("accessToken"), null);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), null);
});

test("API errors expose status and Retry-After but not response content", async t => {
  const app = signedIn(t);
  app.run("accessToken = 'synthetic-access'; accessTokenExpiresAt = Date.now() + 60000; accessTokenAuth = localStorage.getItem(LS_AUTH)");
  app.window.fetch = async () => new Response(JSON.stringify({
    error: { message: "synthetic-private-metadata-must-not-surface", reason: "QUOTA_EXCEEDED" },
  }), { status: 429, headers: { "Retry-After": "2" } });
  await assert.rejects(app.run("api('/me')"), error => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 2000);
    assert.equal(error.reason, "QUOTA_EXCEEDED");
    assert.doesNotMatch(error.message, /must-not-surface/);
    return true;
  });
});

test("PKCE generation uses only the base64url alphabet at requested lengths", t => {
  const app = createApp();
  t.after(app.close);
  for (const length of [16, 64, 128]) {
    const verifier = app.run(`randomVerifier(${length})`);
    assert.equal(verifier.length, length);
    assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  }
});

test("unsupported device volume is rejected before network access", async t => {
  const app = signedIn(t);
  app.run("activeDeviceCapabilities = { supports_volume: false }");
  await assert.rejects(app.run("api('/me/player/volume?volume_percent=20', {method:'PUT'})"), /physical or Spotify volume/);
});

test("clearing sign-in blocks a cached token even before the storage event", async t => {
  const app = signedIn(t);
  app.run("accessToken = 'synthetic-access'; accessTokenExpiresAt = Date.now() + 60000; accessTokenAuth = localStorage.getItem(LS_AUTH)");
  app.window.localStorage.removeItem("s9000.auth");
  await assert.rejects(app.run("getAccessToken()"), /Not authenticated/);
  assert.equal(app.run("accessToken"), null);
});

test("OAuth state mismatch scrubs the URL without canceling the tab's newer attempt", async t => {
  const app = createApp();
  t.after(app.close);
  const attempt = await startLogin(app);
  app.window.history.replaceState({}, "", "?code=synthetic-code&state=wrong-state");
  assert.equal(await app.run("handleAuthRedirect()"), "error");
  assert.equal(app.window.location.search, "");
  assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), attempt.raw);
  assert.ok(app.window.localStorage.getItem(attempt.key));
  assert.equal(app.window.localStorage.getItem("s9000.auth"), null);
});

test("explicit login invalidation rejects a delayed exchange independently of API invalidation", async t => {
  const app = createApp();
  t.after(app.close);
  const attempt = await startLogin(app);
  const request = deferred();
  const entered = deferred();
  app.window.fetch = () => { entered.resolve(); return request.promise; };
  const exchange = callback(app, attempt);
  await entered.promise;
  app.run("invalidateLoginWork()");
  request.resolve(tokenResponse());
  assert.equal(await exchange, "error");
  assert.equal(app.run("accessToken"), null);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), null);
});

test("pending registrations contain bindings only and leave an established sign-in usable", async t => {
  const app = authenticatedApi(t);
  const saved = app.window.localStorage.getItem("s9000.auth");
  const attempt = await startLogin(app);
  const registration = JSON.parse(app.window.localStorage.getItem(attempt.key));
  assert.deepEqual(Object.keys(registration).sort(),
    ["version", "state", "transaction", "clientId", "redirectUri", "expiresAt", "phase", "claim"].sort());
  assert.equal(registration.version, 1);
  assert.equal(registration.phase, "pending");
  assert.equal(registration.claim, null);
  assert.equal(registration.expiresAt, attempt.pkce.expiresAt);
  assert.equal(app.run("LOGIN_TTL_MS"), 600000);
  assert.ok(registration.expiresAt > Date.now() && registration.expiresAt <= Date.now() + 600000);
  assert.equal(app.window.localStorage.getItem("s9000.pkce"), null);
  assert.equal(app.window.localStorage.getItem(attempt.key).includes(attempt.pkce.verifier), false);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
  assert.equal(await app.run("getAccessToken()"), "synthetic-access");
  assert.equal(app.navigations.length, 1);
});

test("challenge preparation is registered first and cannot navigate or recreate state after erase", async t => {
  const origin = createOrigin({ autoEvents: false });
  const app = createApp({ origin });
  const eraser = createApp({ origin });
  t.after(app.close); t.after(eraser.close);
  captureNavigation(app);
  const challenge = deferred();
  const entered = deferred();
  app.window.testChallenge = () => { entered.resolve(); return challenge.promise; };
  app.run("challengeFromVerifier = window.testChallenge");
  const starting = app.run("beginSpotifyLogin('synthetic-client')");
  await entered.promise;
  assert.equal(Object.keys(app.window.localStorage).filter(key => key.startsWith("s9000.login.")).length, 1);
  assert.equal(await eraser.run("eraseBrowserData()"), true);
  challenge.resolve("synthetic-challenge");
  await assert.rejects(starting, /expired|canceled/);
  assert.equal(app.navigations.length, 0);
  assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), null);
  assert.deepEqual(Object.keys(app.window.localStorage).filter(key => key.startsWith("s9000.")), []);
});

test("a login start fails rather than queuing through the shared gate", async t => {
  const app = signedIn(t);
  const held = await holdAuthLock(app);
  try {
    await assert.rejects(app.run("beginSpotifyLogin('synthetic-client')"), /busy/);
    assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), null);
    assert.equal(Object.keys(app.window.localStorage).some(key => key.startsWith("s9000.login.")), false);
    assert.equal((await app.window.navigator.locks.query()).pending.length, 0);
  } finally { held.release(); await held.done; }
});

test("a fresh callback document with retained tab state rejects a logout it never observed", async t => {
  const origin = createOrigin({ autoEvents: false });
  const away = createApp({ origin });
  const attempt = await startLogin(away);
  away.close();
  const eraser = createApp({ origin });
  t.after(eraser.close);
  assert.equal(await eraser.run("eraseBrowserData()"), true);
  const returned = createApp({ origin, sessionStorage: { "s9000.pkce": attempt.raw } });
  t.after(returned.close);
  let requests = 0;
  returned.window.fetch = async () => { requests++; return tokenResponse(); };
  assert.equal(await callback(returned, attempt), "error");
  assert.equal(requests, 0);
  assert.equal(returned.window.location.search, "");
  assert.equal(returned.window.sessionStorage.getItem("s9000.pkce"), null);
  assert.equal(returned.run("accessToken"), null);
  assert.deepEqual(Object.keys(returned.window.localStorage), []);
});

test("a returning document without callback parameters cleans only its revoked temporary state", async t => {
  const app = signedIn(t);
  const saved = app.window.localStorage.getItem("s9000.auth");
  const attempt = await startLogin(app);
  app.window.localStorage.removeItem(attempt.key);
  assert.equal(await app.run("handleAuthRedirect()"), null);
  assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), null);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
});

test("a back-forward cached page cleans revoked temporary state on return without resetting its saved session", async t => {
  const app = signedIn(t);
  const saved = app.window.localStorage.getItem("s9000.auth");
  const attempt = await startLogin(app);
  app.window.localStorage.removeItem(attempt.key);
  app.window.dispatchEvent(new app.window.PageTransitionEvent("pageshow", { persisted: true }));
  await waitFor(() => app.window.sessionStorage.getItem("s9000.pkce") === null);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
});

test("legacy localStorage PKCE is never accepted as callback authority", async t => {
  const app = signedIn(t);
  const saved = app.window.localStorage.getItem("s9000.auth");
  app.window.localStorage.setItem("s9000.pkce", JSON.stringify({
    state: "synthetic-legacy-state", verifier: "v".repeat(64), clientId: "synthetic-client",
  }));
  app.window.history.replaceState({}, "", "?code=synthetic-code&state=synthetic-legacy-state");
  let requests = 0;
  app.window.fetch = async () => { requests++; return tokenResponse(); };
  assert.equal(await app.run("handleAuthRedirect()"), "error");
  assert.equal(requests, 0);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
});

for (const [label, mutate] of [
  ["missing", (app, attempt) => app.window.localStorage.removeItem(attempt.key)],
  ["malformed", (app, attempt) => app.window.localStorage.setItem(attempt.key, "{invalid")],
  ["wrong version", (_, __, registration) => { registration.version = 2; }],
  ["wrong client", (_, __, registration) => { registration.clientId = "synthetic-other-client"; }],
  ["wrong redirect", (_, __, registration) => { registration.redirectUri = "https://synthetic.invalid/"; }],
  ["wrong transaction", (_, __, registration) => { registration.transaction = "x".repeat(32); }],
  ["wrong expiry", (_, __, registration) => { registration.expiresAt += 1; }],
  ["wrong phase", (_, __, registration) => { registration.phase = "consumed"; }],
  ["invalid pending claim", (_, __, registration) => { registration.claim = "x".repeat(32); }],
  ["unexpected field", (_, __, registration) => { registration.code = "synthetic-disallowed-field"; }],
]) {
  test(`${label} registration fails closed without changing saved sign-in or settings`, async t => {
    const app = signedIn(t);
    const saved = app.window.localStorage.getItem("s9000.auth");
    app.window.localStorage.setItem("s9000.volume", "35");
    const attempt = await startLogin(app);
    const registration = JSON.parse(app.window.localStorage.getItem(attempt.key));
    mutate(app, attempt, registration);
    if (!["missing", "malformed"].includes(label)) app.window.localStorage.setItem(attempt.key, JSON.stringify(registration));
    let requests = 0;
    app.window.fetch = async () => { requests++; return tokenResponse(); };
    assert.equal(await callback(app, attempt), "error");
    assert.equal(requests, 0);
    assert.equal(app.window.location.search, "");
    assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
    assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
  });
}

test("expiry applies to an unfinished login, never to the saved session", async t => {
  const app = signedIn(t);
  const saved = app.window.localStorage.getItem("s9000.auth");
  const attempt = await startLogin(app);
  const registration = JSON.parse(app.window.localStorage.getItem(attempt.key));
  registration.expiresAt = attempt.pkce.expiresAt = Date.now() - 1;
  app.window.localStorage.setItem(attempt.key, JSON.stringify(registration));
  app.window.sessionStorage.setItem("s9000.pkce", JSON.stringify(attempt.pkce));
  let requests = 0;
  app.window.fetch = async () => { requests++; return tokenResponse(); };
  assert.equal(await callback(app, attempt), "error");
  assert.equal(requests, 0);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
  assert.equal(await app.run("getAccessToken()"), "synthetic-access");
});

test("denied and duplicate-parameter callbacks reject only their login attempt", async t => {
  const app = signedIn(t);
  const saved = app.window.localStorage.getItem("s9000.auth");
  for (const query of ["error=access_denied", "code=synthetic-code&code=duplicate", "code=synthetic-code&error=access_denied"]) {
    const attempt = await startLogin(app);
    assert.equal(await callback(app, attempt, query), "error");
    assert.equal(app.window.location.search, "");
    assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
  }
});

test("a duplicate callback cannot consume or clean up another callback's claim", async t => {
  const app = createApp();
  t.after(app.close);
  const attempt = await startLogin(app);
  const request = deferred();
  const entered = deferred();
  let requests = 0;
  app.window.fetch = () => { requests++; entered.resolve(); return request.promise; };
  const first = callback(app, attempt);
  await entered.promise;
  const claimed = app.window.localStorage.getItem(attempt.key);
  assert.equal(await callback(app, attempt), "error");
  assert.equal(app.window.localStorage.getItem(attempt.key), claimed);
  assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), attempt.raw);
  request.resolve(tokenResponse());
  assert.equal(await first, "ok");
  assert.equal(requests, 1);
  assert.equal(app.window.localStorage.getItem(attempt.key), null);
});

test("a consumed transaction cannot be replayed, including from a new document", async t => {
  const origin = createOrigin();
  const app = createApp({ origin });
  t.after(app.close);
  const attempt = await startLogin(app);
  app.window.fetch = async () => tokenResponse();
  assert.equal(await callback(app, attempt), "ok");
  const saved = app.window.localStorage.getItem("s9000.auth");
  const replay = createApp({ origin, sessionStorage: { "s9000.pkce": attempt.raw } });
  t.after(replay.close);
  let requests = 0;
  replay.window.fetch = async () => { requests++; return tokenResponse(); };
  assert.equal(await callback(replay, attempt), "error");
  assert.equal(requests, 0);
  assert.equal(replay.window.localStorage.getItem("s9000.auth"), saved);
});

test("independent login tabs coexist through replacement, API invalidation and another successful login", async t => {
  const origin = createOrigin();
  const first = createApp({ origin });
  const second = createApp({ origin });
  t.after(first.close); t.after(second.close);
  const old = await startLogin(first);
  const other = await startLogin(second, "synthetic-second-client");
  const replacement = await startLogin(first);
  assert.equal(first.window.localStorage.getItem(old.key), null);
  assert.ok(first.window.localStorage.getItem(other.key));
  first.run("invalidateAuthWork()");
  second.window.fetch = async () => tokenResponse();
  assert.equal(await callback(second, other), "ok");
  await settlePeers(origin, first, second);
  assert.ok(first.window.localStorage.getItem(replacement.key));
  first.window.fetch = async () => tokenResponse();
  assert.equal(await callback(first, replacement), "ok");
  assert.equal(JSON.parse(first.window.localStorage.getItem("s9000.auth")).clientId, "synthetic-client");
});

test("a tab with copied sessionStorage starts independently without revoking the original tab's attempt", async t => {
  const origin = createOrigin();
  const first = createApp({ origin });
  t.after(first.close);
  const original = await startLogin(first);
  const copied = createApp({ origin, sessionStorage: { "s9000.pkce": original.raw } });
  t.after(copied.close);
  const independent = await startLogin(copied, "synthetic-independent-client");
  assert.ok(first.window.localStorage.getItem(original.key));
  assert.ok(copied.window.localStorage.getItem(independent.key));
  first.window.fetch = async () => tokenResponse();
  assert.equal(await callback(first, original), "ok");
  copied.window.fetch = async () => tokenResponse();
  assert.equal(await callback(copied, independent), "ok");
});

for (const stage of ["exchange", "body"]) {
  test(`erase during OAuth ${stage} processing defeats a delayed response without storage events`, async t => {
    const origin = createOrigin({ autoEvents: false });
    const app = createApp({ origin });
    const eraser = createApp({ origin });
    t.after(app.close); t.after(eraser.close);
    const attempt = await startLogin(app);
    const gate = deferred();
    const entered = deferred();
    app.window.fetch = stage === "exchange"
      ? () => { entered.resolve(); return gate.promise; }
      : async () => ({ ok: true, json: () => { entered.resolve(); return gate.promise; } });
    const exchange = callback(app, attempt);
    await entered.promise;
    assert.equal(await eraser.run("eraseBrowserData()"), true);
    gate.resolve(stage === "exchange" ? tokenResponse() : { access_token: "synthetic-access", refresh_token: "synthetic-rotated", expires_in: 3600 });
    assert.equal(await exchange, "error");
    assert.equal(app.run("accessToken"), null);
    assert.equal(app.window.localStorage.getItem("s9000.auth"), null);
    assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), null);
  });
}

for (const firstOperation of ["erase", "commit"]) {
  test(`the shared gate orders ${firstOperation} first at the OAuth final-check/write boundary`, async t => {
    const origin = createOrigin();
    const app = createApp({ origin });
    const eraser = createApp({ origin });
    t.after(app.close); t.after(eraser.close);
    const attempt = await startLogin(app);
    const response = deferred();
    const entered = deferred();
    app.window.fetch = () => { entered.resolve(); return response.promise; };
    const exchange = callback(app, attempt);
    await entered.promise;
    const held = await holdAuthLock(app);
    let erasing;
    try {
      if (firstOperation === "erase") erasing = eraser.run("eraseBrowserData()");
      else response.resolve(tokenResponse());
      await waitFor(async () => (await origin.locks.query()).pending.length === 1);
      if (firstOperation === "erase") response.resolve(tokenResponse());
      else erasing = eraser.run("eraseBrowserData()");
      await waitFor(async () => (await origin.locks.query()).pending.length === 2);
    } finally { held.release(); await held.done; }
    assert.equal(await erasing, true);
    await exchange;
    await settlePeers(origin, app, eraser);
    assert.equal(app.run("accessToken"), null);
    assert.deepEqual(Object.keys(app.window.localStorage).filter(key => key.startsWith("s9000.")), []);
  });
}

test("credential persistence failure never authenticates memory or overwrites the old sign-in", async t => {
  const origin = createOrigin();
  const app = createApp({ origin });
  t.after(app.close);
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-old-client", refreshToken: "synthetic-old-refresh" }));
  const saved = app.window.localStorage.getItem("s9000.auth");
  const attempt = await startLogin(app);
  origin.failure = (operation, key) => operation === "write" && key === "s9000.auth";
  app.window.fetch = async () => tokenResponse();
  assert.equal(await callback(app, attempt), "error");
  assert.equal(app.run("accessToken"), null);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
  assert.equal(app.window.localStorage.getItem(attempt.key), null);
  assert.match(app.run("authError"), /storage is unavailable/);
});

test("missing locks and registration-storage failures have no unsafe fallback", async t => {
  const origin = createOrigin();
  const app = createApp({ origin, locks: false });
  t.after(app.close);
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
  app.window.localStorage.setItem("s9000.volume", "35");
  const saved = app.window.localStorage.getItem("s9000.auth");
  await assert.rejects(app.run("beginSpotifyLogin('synthetic-client')"), /Web Locks/);
  await assert.rejects(app.run("getAccessToken()"), /Web Locks/);
  app.window.navigator.locks = origin.locks;
  origin.failure = (operation, key) => operation === "write" && key.startsWith("s9000.login.");
  await assert.rejects(app.run("beginSpotifyLogin('synthetic-client')"), /storage is unavailable/);
  assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), null);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
  assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
  assert.equal(Object.keys(app.window.localStorage).some(key => key.startsWith("s9000.login.")), false);
});

test("tab-local storage failure rolls back only the newly created registration", async t => {
  const app = signedIn(t);
  const saved = app.window.localStorage.getItem("s9000.auth");
  const store = app.window.sessionStorage;
  Object.defineProperty(app.window, "sessionStorage", { configurable: true, value: {
    getItem: key => store.getItem(key),
    setItem() { throw new Error("Synthetic tab storage unavailable"); },
    removeItem: key => store.removeItem(key),
  } });
  await assert.rejects(app.run("beginSpotifyLogin('synthetic-client')"), /storage is unavailable/);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
  assert.equal(Object.keys(app.window.localStorage).some(key => key.startsWith("s9000.login.")), false);
});

test("bad callbacks and refresh failures preserve the valid library, pending edits, preferences and Client ID", async t => {
  const app = await databaseApp(t);
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
  app.window.localStorage.setItem("s9000.volume", "35");
  app.window.localStorage.setItem("unrelated-app-key", "keep");
  app.run(`setCellColor('${ids.firstPlayback}', 2)`);
  await app.run("databaseQueue");
  const before = await app.run("idbGet(IDB_KEY)");
  const saved = app.window.localStorage.getItem("s9000.auth");
  app.window.sessionStorage.setItem("s9000.pkce", JSON.stringify({
    state: "synthetic-legacy-state", verifier: "v".repeat(64), clientId: "synthetic-client",
  }));
  app.window.history.replaceState({}, "", "?code=synthetic-code&state=synthetic-legacy-state");
  assert.equal(await app.run("handleAuthRedirect()"), "error");
  for (const response of [
    () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    () => new Response("", { status: 503 }),
    () => new Response("synthetic-private-unreadable-response"),
    () => { throw new Error("Synthetic offline"); },
  ]) {
    app.window.fetch = async () => response();
    await assert.rejects(app.run("getAccessToken()"), error => {
      assert.doesNotMatch(error.message, /synthetic-private/);
      return true;
    });
    assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
    assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
    assert.equal(app.window.localStorage.getItem("unrelated-app-key"), "keep");
    assert.equal(app.run(`pending.colors['${ids.firstPlayback}']`), 2);
    assert.equal(app.rows("SELECT COUNT(*) AS n FROM Playback")[0].n, 2);
    assert.equal((await app.run("idbGet(IDB_KEY)")).version, before.version);
  }
});

test("fresh startup and repeated reload restore saved sign-in and recovery without any registration", async t => {
  const origin = createOrigin();
  const SQL = await getSql();
  const seed = createApp({ origin });
  seed.window.testSQL = SQL;
  seed.window.testFixture = fixture(SQL);
  seed.run("SQL = window.testSQL; triggerDownload = () => {}");
  await seed.run("loadDbFromBytes(window.testFixture)");
  seed.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
  seed.window.localStorage.setItem("s9000.volume", "35");
  seed.window.localStorage.setItem("s9000.trackPlayed", "0");
  seed.run(`setCellColor('${ids.firstPlayback}', 2)`);
  await seed.run("databaseQueue");
  seed.close();
  for (let reload = 0; reload < 2; reload++) {
    const app = createApp({ origin });
    t.after(app.close);
    app.window.testSQL = SQL;
    app.run("SQL = window.testSQL");
    app.window.fetch = async (url, options) => {
      if (url.endsWith("/api/token")) {
        assert.equal(options.body.get("grant_type"), "refresh_token");
        return tokenResponse();
      }
      return new Response(JSON.stringify(url.endsWith("/me") ? { display_name: "Synthetic account" } : { devices: [] }));
    };
    await app.window.startApp();
    await waitFor(() => app.window.document.getElementById("device-list").textContent.includes("No devices"));
    assert.equal(app.window.document.getElementById("in-client-id").value, "synthetic-client");
    assert.equal(app.window.document.getElementById("in-volume").value, "35");
    assert.equal(app.window.document.getElementById("track-played").checked, false);
    assert.equal(app.run(`pending.colors['${ids.firstPlayback}']`), 2);
    assert.equal(app.run("queryAll('SELECT COUNT(*) AS n FROM Playback')[0].n"), 2);
    assert.equal(Object.keys(app.window.localStorage).some(key => key.startsWith("s9000.login.")), false);
    app.close();
  }
});

test("an in-flight OAuth claim survives another tab's legitimate refresh", async t => {
  const origin = createOrigin();
  const login = createApp({ origin });
  const refresher = createApp({ origin });
  t.after(login.close); t.after(refresher.close);
  login.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
  const attempt = await startLogin(login);
  const response = deferred();
  const entered = deferred();
  login.window.fetch = () => { entered.resolve(); return response.promise; };
  const exchange = callback(login, attempt);
  await entered.promise;
  refresher.window.fetch = async () => tokenResponse();
  assert.equal(await refresher.run("getAccessToken()"), "synthetic-access");
  await settlePeers(origin, login, refresher);
  response.resolve(tokenResponse());
  assert.equal(await exchange, "ok");
});

test("expiry is rechecked under the commit lock after delayed token body processing", async t => {
  const app = signedIn(t);
  const saved = app.window.localStorage.getItem("s9000.auth");
  const attempt = await startLogin(app);
  const body = deferred();
  const entered = deferred();
  app.window.fetch = async () => ({ ok: true, json: () => { entered.resolve(); return body.promise; } });
  const exchange = callback(app, attempt);
  await entered.promise;
  app.window.testNow = attempt.pkce.expiresAt + 1;
  app.run("Date.now = () => window.testNow");
  body.resolve({ access_token: "synthetic-access", refresh_token: "synthetic-rotated", expires_in: 3600 });
  assert.equal(await exchange, "error");
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
  assert.equal(app.run("accessToken"), null);
});

for (const stage of ["claim", "consume", "read", "locks"]) {
  test(`unavailable ${stage} protection fails a callback closed without resetting saved data`, async t => {
    const origin = createOrigin();
    const app = createApp({ origin });
    t.after(app.close);
    app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-old-client", refreshToken: "synthetic-old-refresh" }));
    const saved = app.window.localStorage.getItem("s9000.auth");
    const attempt = await startLogin(app);
    if (stage === "locks") app.window.navigator.locks = undefined;
    else origin.failure = (operation, key) =>
      (stage === "read" && operation === "read") ||
      (key?.startsWith("s9000.login.") && operation === (stage === "claim" ? "write" : "remove"));
    let requests = 0;
    app.window.fetch = async () => { requests++; return tokenResponse(); };
    assert.equal(await callback(app, attempt), "error");
    origin.failure = null;
    assert.equal(requests, stage === "consume" ? 1 : 0);
    assert.equal(app.window.location.search, "");
    assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
    assert.equal(app.run("accessToken"), null);
  });
}

test("a refresh body arriving after explicit erase cannot restore saved credentials", async t => {
  const origin = createOrigin({ autoEvents: false });
  const app = createApp({ origin });
  const eraser = createApp({ origin });
  t.after(app.close); t.after(eraser.close);
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
  const body = deferred();
  const entered = deferred();
  app.window.fetch = async () => ({ ok: true, json: () => { entered.resolve(); return body.promise; } });
  const refresh = app.run("getAccessToken()");
  await entered.promise;
  assert.equal(await eraser.run("eraseBrowserData()"), true);
  body.resolve({ access_token: "synthetic-access", refresh_token: "synthetic-rotated", expires_in: 3600 });
  await assert.rejects(refresh, /changed/);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), null);
  assert.equal(app.run("accessToken"), null);
});

test("refreshes from separate tabs compare the saved session inside the serialized commit", async t => {
  const origin = createOrigin({ autoEvents: false });
  const first = createApp({ origin });
  const second = createApp({ origin });
  t.after(first.close); t.after(second.close);
  first.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
  const firstResponse = deferred();
  const secondResponse = deferred();
  first.window.fetch = () => firstResponse.promise;
  second.window.fetch = () => secondResponse.promise;
  const firstRefresh = first.run("getAccessToken()");
  const secondRefresh = second.run("getAccessToken()");
  const held = await holdAuthLock(first);
  try {
    firstResponse.resolve(tokenResponse());
    await waitFor(async () => (await origin.locks.query()).pending.length === 1);
    secondResponse.resolve(tokenResponse());
    await waitFor(async () => (await origin.locks.query()).pending.length === 2);
  } finally { held.release(); await held.done; }
  assert.equal(await firstRefresh, "synthetic-access");
  await assert.rejects(secondRefresh, /Saved sign-in changed/);
  assert.equal(second.run("accessToken"), null);
});

test("a failed refresh credential write leaves the previous sign-in and any pending OAuth attempt intact", async t => {
  const origin = createOrigin();
  const app = createApp({ origin });
  t.after(app.close);
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
  const saved = app.window.localStorage.getItem("s9000.auth");
  const attempt = await startLogin(app);
  origin.failure = (operation, key) => operation === "write" && key === "s9000.auth";
  app.window.fetch = async () => tokenResponse();
  await assert.rejects(app.run("getAccessToken()"), /storage is unavailable/);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
  assert.equal(app.window.sessionStorage.getItem("s9000.pkce"), attempt.raw);
  assert.ok(app.window.localStorage.getItem(attempt.key));
  assert.equal(app.run("accessToken"), null);
});

test("provider revocation asks for reconnection without removing saved configuration", async t => {
  const app = signedIn(t);
  const saved = app.window.localStorage.getItem("s9000.auth");
  app.window.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 400 });
  await assert.rejects(app.run("getAccessToken()"), /Reconnect in Setup; your library and settings are preserved/);
  assert.equal(app.window.localStorage.getItem("s9000.auth"), saved);
});

test("a delayed auth event does not cancel a refresh already bound to the newer saved session", async t => {
  const origin = createOrigin({ autoEvents: false });
  const app = createApp({ origin });
  const peer = createApp({ origin });
  t.after(app.close); t.after(peer.close);
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-old-client", refreshToken: "synthetic-old-refresh" }));
  app.run("accessTokenAuth = localStorage.getItem(LS_AUTH)");
  const oldResponse = deferred();
  const newResponse = deferred();
  let requests = 0;
  app.window.fetch = () => ++requests === 1 ? oldResponse.promise : newResponse.promise;
  const oldRefresh = app.run("getAccessToken()");
  peer.window.localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-new-client", refreshToken: "synthetic-new-refresh" }));
  const newRefresh = app.run("getAccessToken()");
  await settlePeers(origin, app, peer);
  newResponse.resolve(tokenResponse());
  assert.equal(await newRefresh, "synthetic-access");
  oldResponse.resolve(tokenResponse());
  await assert.rejects(oldRefresh, /canceled/);
  assert.equal(JSON.parse(app.window.localStorage.getItem("s9000.auth")).clientId, "synthetic-new-client");
  assert.equal(app.run("accessToken"), "synthetic-access");
});
