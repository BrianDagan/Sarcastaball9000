const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { getSql, fixture, ids } = require("../helpers/database.cjs");

test.beforeEach(async ({ page }) => {
  page.appErrors = [];
  page.on("pageerror", error => page.appErrors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(page.appErrors).toEqual([]);
});

async function prepareStoredApp(page) {
  const backend = { failRefresh: false, failedRefreshes: 0, codeExchanges: 0 };
  await page.route(/https:\/\/(?:api|accounts)\.spotify\.com\//, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "accounts.spotify.com" && url.pathname === "/api/token") {
      const grant = new URLSearchParams(request.postData()).get("grant_type");
      if (grant === "authorization_code") {
        backend.codeExchanges++;
        return route.fulfill({ status: 400, json: { error: "invalid_grant" } });
      }
      if (grant !== "refresh_token") return route.abort("blockedbyclient");
      if (backend.failRefresh) {
        backend.failedRefreshes++;
        return route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
      }
      return route.fulfill({ json: {
        access_token: "synthetic-preserved-access",
        refresh_token: "synthetic-preserved-refresh",
        expires_in: 3600,
      } });
    }
    if (url.hostname === "api.spotify.com" && url.pathname === "/v1/me") {
      return route.fulfill({ json: { display_name: "Synthetic account" } });
    }
    if (url.hostname === "api.spotify.com" && url.pathname === "/v1/me/player/devices") {
      return route.fulfill({ json: { devices: [] } });
    }
    return route.abort("blockedbyclient");
  });
  await page.goto("/");
  const SQL = await getSql();
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic.sqlite", mimeType: "application/x-sqlite3", buffer: Buffer.from(fixture(SQL)),
  });
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  await page.evaluate(id => {
    localStorage.setItem("s9000.auth", JSON.stringify({
      clientId: "synthetic-client", refreshToken: "synthetic-preserved-refresh",
    }));
    localStorage.setItem("s9000.volume", "35");
    localStorage.setItem("unrelated-app-key", "keep");
    setCellColor(id, 2);
    return databaseQueue;
  }, ids.firstPlayback);
  return backend;
}

async function expectStoredData(page) {
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  const state = await page.evaluate(id => {
    const auth = JSON.parse(localStorage.getItem("s9000.auth") || "null");
    return {
      client: auth?.clientId,
      hasRefresh: typeof auth?.refreshToken === "string" && auth.refreshToken.length > 0,
      volume: localStorage.getItem("s9000.volume"),
      unrelated: localStorage.getItem("unrelated-app-key"),
      pendingColor: pending.colors[id],
      rows: queryAll("SELECT COUNT(*) AS n FROM Playback")[0]?.n,
    };
  }, ids.firstPlayback);
  expect(state).toEqual({
    client: "synthetic-client", hasRefresh: true, volume: "35",
    unrelated: "keep", pendingColor: 2, rows: 2,
  });
  await expect(page.locator("#in-client-id")).toHaveValue("synthetic-client");
  await expect(page.locator("#empty-state")).toBeHidden();
}

test("same-origin reloads restore a saved session and library without a new OAuth registration", async ({ page }) => {
  const backend = await prepareStoredApp(page);
  for (let reload = 0; reload < 2; reload++) {
    await page.reload();
    await expectStoredData(page);
    expect(await page.evaluate(async () => !!await getAccessToken())).toBe(true);
  }
  expect(backend.codeExchanges).toBe(0);
});

test("a rejected legacy callback preserves an established sign-in, preferences and library", async ({ page }) => {
  const backend = await prepareStoredApp(page);
  await page.evaluate(() => {
    sessionStorage.setItem("s9000.pkce", JSON.stringify({
      state: "synthetic-stale-state", verifier: "v".repeat(64), clientId: "synthetic-client",
    }));
  });
  await page.route(url => url.pathname === "/" && url.searchParams.has("code"), route =>
    route.fulfill({
      contentType: "text/html",
      body: fs.readFileSync(path.resolve(__dirname, "..", "..", "docs", "index.html"), "utf8"),
    }));
  await page.goto("/?code=synthetic-rejected-code&state=synthetic-stale-state");
  await expectStoredData(page);
  expect(new URL(page.url()).search).toBe("");
  expect(backend.codeExchanges).toBe(0);
  expect(await page.evaluate(async () => !!await getAccessToken())).toBe(true);
});

test("a refresh failure leaves saved data intact and can recover without reconfiguration", async ({ page }) => {
  const backend = await prepareStoredApp(page);
  backend.failRefresh = true;
  await page.reload();
  await expectStoredData(page);
  await expect(page.locator("#auth-status")).toHaveClass(/\berr\b/);
  expect(backend.failedRefreshes).toBeGreaterThan(0);
  backend.failRefresh = false;
  expect(await page.evaluate(async () => !!await getAccessToken())).toBe(true);
  await expectStoredData(page);
  expect(backend.codeExchanges).toBe(0);
});
