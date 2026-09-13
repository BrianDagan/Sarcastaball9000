const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { getSql, fixture, ids } = require("../helpers/database.cjs");

test.beforeEach(async ({ context, page }) => {
  context.appErrors = [];
  const watch = tab => tab.on("pageerror", error => context.appErrors.push(error.message));
  watch(page);
  context.on("page", watch);
  await context.addInitScript(() => {
    window.delayedAuthEvents = [];
    window.deferAuthEvents = false;
    // Install before app listeners so a deferred event cannot reach them first.
    window.addEventListener("storage", event => {
      if (!window.deferAuthEvents || (event.key !== "s9000.auth" && event.key !== "s9000.erase")) return;
      window.delayedAuthEvents.push({ key: event.key, oldValue: event.oldValue, newValue: event.newValue });
      event.stopImmediatePropagation();
    }, true);
  });
  context.syntheticAuth = { exchanges: 0, refreshes: 0, revoked: false };
  await context.route(/https:\/\/(?:api|accounts)\.spotify\.com\//, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "accounts.spotify.com" && url.pathname === "/authorize") {
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic authorization page</title><p>Synthetic consent page</p>" });
    }
    if (url.hostname === "accounts.spotify.com" && url.pathname === "/api/token") {
      const grant = new URLSearchParams(request.postData()).get("grant_type");
      if (grant === "authorization_code") context.syntheticAuth.exchanges++;
      else if (grant === "refresh_token") {
        context.syntheticAuth.refreshes++;
        if (context.syntheticAuth.revoked) return route.fulfill({ status: 400, json: { error: "invalid_grant" } });
      } else return route.abort("blockedbyclient");
      return route.fulfill({ json: {
        access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600,
      } });
    }
    if (url.pathname === "/v1/me") return route.fulfill({ json: { display_name: "Synthetic account" } });
    if (url.pathname === "/v1/me/player/devices") return route.fulfill({ json: { devices: [] } });
    return route.abort("blockedbyclient");
  });
  await context.route(url => url.hostname === "127.0.0.1" && url.pathname === "/" &&
    (url.searchParams.has("code") || url.searchParams.has("error")), route => route.fulfill({
    contentType: "text/html",
    body: fs.readFileSync(path.resolve(__dirname, "..", "..", "docs", "index.html"), "utf8"),
  }));
  await page.goto("/");
  await ready(page);
});

test.afterEach(async ({ context }) => {
  expect(context.appErrors).toEqual([]);
});

async function ready(page) {
  await expect.poll(() => page.evaluate(() => typeof document.getElementById("btn-login-spotify")?.onclick)).toBe("function");
}

async function peerPage(context) {
  const peer = await context.newPage();
  await peer.goto("/");
  await ready(peer);
  return peer;
}

async function registerLogin(page) {
  await page.evaluate(async () => {
    window.testNavigations = [];
    navigateToSpotify = url => window.testNavigations.push(url);
    await beginSpotifyLogin("synthetic-client");
    window.testAttempt = { raw: sessionStorage.getItem(LS_PKCE) };
    window.testAttempt.pkce = JSON.parse(window.testAttempt.raw);
  });
}

async function finishLogin(page) {
  return page.evaluate(() => {
    history.replaceState({}, "", "?code=synthetic-code&state=" + encodeURIComponent(window.testAttempt.pkce.state));
    return handleAuthRedirect();
  });
}

async function beginConfirmedLogout(page) {
  await page.evaluate(() => openLogout());
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#btn-logout-discard").click();
}

async function confirmedLogout(page) {
  await beginConfirmedLogout(page);
  await expect(page.locator("#auth-status")).toContainText("browser data was erased");
}

async function loadLibrary(page, color = 2) {
  await page.evaluate(() => { triggerDownload = () => {}; });
  const SQL = await getSql();
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic.sqlite", mimeType: "application/x-sqlite3", buffer: Buffer.from(fixture(SQL)),
  });
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  await page.evaluate(({ id, color }) => {
    setCellColor(id, color);
    return databaseQueue;
  }, { id: ids.firstPlayback, color });
}

async function delayCallback(page, stage = "body") {
  await page.evaluate(stage => {
    const realFetch = fetch;
    window.tokenEntered = false;
    window.fetch = (url, options) => {
      if (url !== TOKEN_URL) return realFetch(url, options);
      const response = { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 };
      if (stage === "body") return Promise.resolve({
        ok: true,
        json: () => {
          window.tokenEntered = true;
          return new Promise(resolve => { window.releaseTokenResponse = () => resolve(response); });
        },
      });
      window.tokenEntered = true;
      return new Promise(resolve => {
        window.releaseTokenResponse = () => resolve(new Response(JSON.stringify(response)));
      });
    };
    history.replaceState({}, "", "?code=synthetic-code&state=" + encodeURIComponent(window.testAttempt.pkce.state));
    window.testExchange = handleAuthRedirect();
  }, stage);
  await expect.poll(() => page.evaluate(() => window.tokenEntered)).toBe(true);
}

async function holdGate(page) {
  await page.evaluate(() => {
    window.gateEntered = false;
    window.testGate = navigator.locks.request(AUTH_LOCK_NAME, () => {
      window.gateEntered = true;
      return new Promise(resolve => { window.releaseGate = resolve; });
    });
  });
  await expect.poll(() => page.evaluate(() => window.gateEntered)).toBe(true);
}

async function pendingLocks(page) {
  return page.evaluate(async () => (await navigator.locks.query()).pending.filter(lock => lock.name === AUTH_LOCK_NAME).length);
}

async function deferPeerEvents(page) {
  await page.evaluate(() => {
    window.delayedAuthEvents = [];
    window.deferAuthEvents = true;
  });
}

async function flushPeerEvents(page) {
  await page.evaluate(async () => {
    window.deferAuthEvents = false;
    for (const event of window.delayedAuthEvents) window.dispatchEvent(new StorageEvent("storage", event));
    await Promise.all([...peerEraseTasks.values()]);
  });
}

test("an OAuth tab returning as a fresh document after logout rejects before exchanging any code", async ({ page, context }) => {
  await page.evaluate(() => {
    window.previousDocument = true;
    localStorage.setItem("unrelated-app-key", "keep");
  });
  await page.locator("#btn-settings").click();
  await page.locator("#in-client-id").fill("synthetic-client");
  await Promise.all([
    page.waitForURL(url => url.hostname === "accounts.spotify.com" && url.pathname === "/authorize"),
    page.locator("#btn-login-spotify").click(),
  ]);
  const state = new URL(page.url()).searchParams.get("state");
  const eraser = await peerPage(context);
  expect(await eraser.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith(LS_LOGIN_PREFIX)).length)).toBe(1);
  expect(await eraser.evaluate(() => localStorage.getItem(LS_PKCE))).toBeNull();
  await confirmedLogout(eraser);
  expect(await eraser.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith(LS_LOGIN_PREFIX)).length)).toBe(0);
  expect(await eraser.evaluate(() => localStorage.getItem(LS_ERASE))).toBeNull();
  await page.goto("/?code=synthetic-return-code&state=" + encodeURIComponent(state));
  await ready(page);
  await expect(page.locator("#auth-status")).toHaveClass(/\berr\b/);
  expect(context.syntheticAuth.exchanges).toBe(0);
  expect(new URL(page.url()).search).toBe("");
  expect(await page.evaluate(() => typeof window.previousDocument)).toBe("undefined");
  expect(await page.evaluate(() => sessionStorage.getItem(LS_PKCE))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem(LS_AUTH))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("unrelated-app-key"))).toBe("keep");
});

test("independent pending tabs and atomic claims survive another tab's successful sign-in", async ({ page, context }) => {
  const peer = await peerPage(context);
  await registerLogin(page);
  await registerLogin(peer);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith(LS_LOGIN_PREFIX)).length)).toBe(2);
  expect(await finishLogin(page)).toBe("ok");
  expect(await peer.evaluate(() => !!localStorage.getItem(LS_LOGIN_PREFIX + window.testAttempt.pkce.state))).toBe(true);
  await delayCallback(peer);
  expect(await finishLogin(peer)).toBe("error");
  expect(await peer.evaluate(() => sessionStorage.getItem(LS_PKCE) === window.testAttempt.raw)).toBe(true);
  await peer.evaluate(() => window.releaseTokenResponse());
  expect(await peer.evaluate(() => window.testExchange)).toBe("ok");
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith(LS_LOGIN_PREFIX)).length)).toBe(0);
});

for (const stage of ["exchange", "body"]) {
  test(`native cross-tab erase revokes OAuth during delayed ${stage} processing`, async ({ page, context }) => {
    const eraser = await peerPage(context);
    await registerLogin(page);
    await delayCallback(page, stage);
    await confirmedLogout(eraser);
    await page.evaluate(() => window.releaseTokenResponse());
    expect(await page.evaluate(() => window.testExchange)).toBe("error");
    await expect.poll(() => page.evaluate(() => accessToken === null)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem(LS_AUTH))).toBeNull();
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith(LS_LOGIN_PREFIX)))).toBe(false);
  });
}

for (const first of ["erase", "commit"]) {
  test(`native Web Locks serialize ${first} first at the final OAuth commit boundary`, async ({ page, context }) => {
    const eraser = await peerPage(context);
    await registerLogin(page);
    await delayCallback(page);
    await holdGate(eraser);
    try {
      if (first === "erase") await beginConfirmedLogout(eraser);
      else await page.evaluate(() => window.releaseTokenResponse());
      await expect.poll(() => pendingLocks(page)).toBe(1);
      if (first === "erase") await page.evaluate(() => window.releaseTokenResponse());
      else await beginConfirmedLogout(eraser);
      await expect.poll(() => pendingLocks(page)).toBe(2);
    } finally {
      await eraser.evaluate(() => { window.releaseGate(); return window.testGate; });
    }
    await expect(eraser.locator("#auth-status")).toContainText("browser data was erased");
    await page.evaluate(() => window.testExchange);
    await expect.poll(() => page.evaluate(() => accessToken === null)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem(LS_AUTH))).toBeNull();
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith(LS_LOGIN_PREFIX)))).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem(LS_ERASE))).toBeNull();
  });
}

test("erase during challenge preparation prevents later navigation and registration recreation", async ({ page, context }) => {
  const eraser = await peerPage(context);
  await page.evaluate(() => {
    window.testNavigations = [];
    window.challengeEntered = false;
    navigateToSpotify = url => window.testNavigations.push(url);
    challengeFromVerifier = () => {
      window.challengeEntered = true;
      return new Promise(resolve => { window.releaseChallenge = resolve; });
    };
    window.testStart = beginSpotifyLogin("synthetic-client").then(() => true, () => false);
  });
  await expect.poll(() => page.evaluate(() => window.challengeEntered)).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith(LS_LOGIN_PREFIX)).length)).toBe(1);
  await confirmedLogout(eraser);
  await page.evaluate(() => window.releaseChallenge("synthetic-challenge"));
  expect(await page.evaluate(() => window.testStart)).toBe(false);
  expect(await page.evaluate(() => window.testNavigations.length)).toBe(0);
  expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith(LS_LOGIN_PREFIX)))).toBe(false);
});

test("a genuinely new sign-in and library survive delayed peer events and old transaction cleanup", async ({ page, context }) => {
  const eraser = await peerPage(context);
  await loadLibrary(eraser);
  await registerLogin(page);
  await page.evaluate(() => { window.oldAttempt = window.testAttempt; });
  await deferPeerEvents(page);
  await confirmedLogout(eraser);
  await expect.poll(() => page.evaluate(() => window.delayedAuthEvents.some(event => event.key === LS_ERASE && event.newValue))).toBe(true);
  await registerLogin(page);
  expect(await finishLogin(page)).toBe("ok");
  await loadLibrary(page, 4);
  await page.evaluate(() => {
    localStorage.setItem(LS_VOLUME, "45");
    window.newRevision = getWorkingDatabaseRevision();
    window.newAuth = localStorage.getItem(LS_AUTH);
    return withAuthLock(() => discardLoginAttempt(window.oldAttempt.pkce, window.oldAttempt.raw));
  });
  await flushPeerEvents(page);
  await flushPeerEvents(page);
  expect(await page.evaluate(() => localStorage.getItem(LS_AUTH) === window.newAuth)).toBe(true);
  expect(await page.evaluate(() => accessToken !== null)).toBe(true);
  expect(await page.evaluate(() => getWorkingDatabaseRevision() === window.newRevision)).toBe(true);
  expect(await page.evaluate(id => pending.colors[id], ids.firstPlayback)).toBe(4);
  expect(await page.evaluate(() => localStorage.getItem(LS_VOLUME))).toBe("45");
  await expect(page.locator("#grid .cell")).toHaveCount(1);
});

test("blocked native IndexedDB deletion closes a peer connection before its auth-lock wait", async ({ page, context }) => {
  await loadLibrary(page);
  const peer = await peerPage(context);
  await expect(peer.locator("#grid .cell")).toHaveCount(1);
  await deferPeerEvents(peer);
  await peer.evaluate(async () => {
    window.blockingConnection = await idbOpen();
    window.blockingConnection.onversionchange = () => {};
    const close = window.blockingConnection.close.bind(window.blockingConnection);
    window.peerClosed = false;
    window.blockingConnection.close = () => { window.peerClosed = true; close(); };
  });
  await page.evaluate(() => {
    const remove = indexedDB.deleteDatabase.bind(indexedDB);
    window.deleteBlocked = false;
    window.deleteRequests = 0;
    indexedDB.deleteDatabase = name => {
      window.deleteRequests++;
      const request = remove(name);
      request.addEventListener("blocked", () => { window.deleteBlocked = true; });
      return request;
    };
  });
  await beginConfirmedLogout(page);
  await expect.poll(() => page.evaluate(() => window.deleteBlocked)).toBe(true);
  expect(await page.evaluate(async () => (await navigator.locks.query()).held.some(lock => lock.name === AUTH_LOCK_NAME))).toBe(true);
  expect(await peer.evaluate(() => beginSpotifyLogin("synthetic-busy-client").then(() => true, () => false))).toBe(false);
  await flushPeerEvents(peer);
  await expect(page.locator("#auth-status")).toContainText("browser data was erased");
  expect(await peer.evaluate(() => window.peerClosed)).toBe(true);
  expect(await page.evaluate(() => window.deleteRequests)).toBe(1);
  expect(await peer.evaluate(() => db === null && pendingCount() === 0)).toBe(true);
  expect(await page.evaluate(async () => (await indexedDB.databases()).some(item => item.name === IDB_NAME))).toBe(false);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("s9000.")))).toEqual([]);
});

for (const unavailable of ["Web Locks", "storage"]) {
  test(`${unavailable} failure reports a blocked operation without erasing existing browser data`, async ({ page, context }) => {
    await loadLibrary(page);
    await page.evaluate(unavailable => {
      localStorage.setItem(LS_AUTH, JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
      localStorage.setItem(LS_VOLUME, "35");
      window.savedAuthBeforeFailure = localStorage.getItem(LS_AUTH);
      window.revisionBeforeFailure = getWorkingDatabaseRevision();
      if (unavailable === "Web Locks") Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
      else {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (this === localStorage && (key.startsWith(LS_LOGIN_PREFIX) || key === LS_AUTH || key === LS_ERASE)) {
            throw new DOMException("Synthetic storage unavailable", "QuotaExceededError");
          }
          return set.call(this, key, value);
        };
      }
      showModal(true);
    }, unavailable);
    await page.locator("#in-client-id").fill("synthetic-client");
    await page.locator("#btn-login-spotify").click();
    await expect(page.locator("#auth-status")).toContainText(unavailable === "Web Locks" ? "Web Locks" : "storage is unavailable");
    await beginConfirmedLogout(page);
    await expect(page.locator("#logout-status")).toContainText("Cleanup did not complete");
    expect(await page.evaluate(() => localStorage.getItem(LS_AUTH) === window.savedAuthBeforeFailure)).toBe(true);
    expect(await page.evaluate(() => getWorkingDatabaseRevision() === window.revisionBeforeFailure)).toBe(true);
    expect(await page.evaluate(id => pending.colors[id], ids.firstPlayback)).toBe(2);
    expect(await page.evaluate(() => localStorage.getItem(LS_VOLUME))).toBe("35");
    expect(context.syntheticAuth.exchanges).toBe(0);
  });
}

test("provider revocation reports reconnection while keeping the library and Client ID", async ({ page, context }) => {
  await loadLibrary(page);
  await page.evaluate(() => {
    localStorage.setItem(LS_AUTH, JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-refresh" }));
    localStorage.setItem(LS_VOLUME, "35");
  });
  context.syntheticAuth.revoked = true;
  await page.reload();
  await ready(page);
  await expect(page.locator("#auth-status")).toContainText("Reconnect in Setup");
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  await expect(page.locator("#in-client-id")).toHaveValue("synthetic-client");
  expect(await page.evaluate(id => pending.colors[id], ids.firstPlayback)).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem(LS_VOLUME))).toBe("35");
  expect(await page.evaluate(() => !!JSON.parse(localStorage.getItem(LS_AUTH)).refreshToken)).toBe(true);
  expect(context.syntheticAuth.exchanges).toBe(0);
});
