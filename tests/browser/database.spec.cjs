const { test, expect } = require("@playwright/test");
const { getSql, fixture, scalar, ids } = require("../helpers/database.cjs");

test.beforeEach(async ({ page }) => {
  page.appErrors = [];
  page.on("pageerror", error => page.appErrors.push(error.message));
  await page.route(/https:\/\/(?:api|accounts)\.spotify\.com\//, route => route.abort("blockedbyclient"));
  await page.goto("/");
  await expect(page.locator("#empty-state")).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(page.appErrors).toEqual([]);
});

async function loadFixture(page) {
  const SQL = await getSql();
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic.sqlite", mimeType: "application/x-sqlite3", buffer: Buffer.from(fixture(SQL)),
  });
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  return SQL;
}

async function exportForLogout(page) {
  const pendingDownload = page.waitForEvent("download");
  await page.locator("#btn-logout-export").click();
  const download = await pendingDownload;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("real SQLite import rejects corrupt replacement without losing edits", async ({ page }) => {
  await loadFixture(page);
  await page.evaluate(id => setCellColor(id, 2), ids.firstPlayback);
  await page.evaluate(() => databaseQueue);
  const revision = await page.evaluate(() => getWorkingDatabaseRevision());
  await page.locator("#in-db-file").setInputFiles({
    name: "broken.sqlite", mimeType: "application/x-sqlite3", buffer: Buffer.from("not a database"),
  });
  await expect(page.locator("#db-status")).toContainText("Import did not complete");
  expect(await page.evaluate(() => getWorkingDatabaseRevision())).toBe(revision);
  expect(await page.evaluate(id => pending.colors[id], ids.firstPlayback)).toBe(2);
  await expect(page.locator("#grid .cell")).toHaveCount(1);
});

test("repeated tile toggles survive state refreshes and text acknowledgements", async ({ page }) => {
  await loadFixture(page);
  let pauseRequests = 0;
  let isPlaying = false;
  await page.route("https://api.spotify.com/v1/me/player**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/v1/me/player") {
      return route.fulfill({ json: {
        is_playing: isPlaying, progress_ms: 1000,
        item: { id: "synthetic-track-0" },
        device: { id: "synthetic-device", supports_volume: true },
        actions: { disallows: { [isPlaying ? "resuming" : "pausing"]: true } },
      } });
    }
    if (request.method() !== "PUT") return route.abort("blockedbyclient");
    if (path.endsWith("/pause")) {
      pauseRequests++;
      isPlaying = false;
      return route.fulfill({ status: 200, contentType: "text/plain", body: "OK" });
    }
    if (path.endsWith("/play")) isPlaying = true;
    return route.fulfill({ status: 204 });
  });
  await page.evaluate(() => {
    getAccessToken = async () => "synthetic-access";
    activeDeviceId = "synthetic-device";
    activeDeviceCapabilities = { supports_volume: true };
    trackPlayedOn = false;
  });
  const tile = page.locator("#grid .cell").first();
  await tile.click();
  await expect(tile).toHaveClass(/playing/);
  for (let toggle = 0; toggle < 6; toggle++) {
    if (toggle % 3 === 0) expect(await page.evaluate(() => reconcilePlayback())).toBe(true);
    const shouldPause = toggle % 2 === 0;
    await tile.click();
    if (shouldPause) await expect(tile).toHaveClass(/paused/);
    else await expect(tile).not.toHaveClass(/paused/);
    expect(await page.evaluate(() => nowPlaying.paused)).toBe(shouldPause);
    expect(await page.evaluate(() => progress.paused)).toBe(shouldPause);
    expect(isPlaying).toBe(!shouldPause);
    expect(pauseRequests).toBe(Math.floor(toggle / 2) + 1);
    await expect(page.locator("#transport-status")).toBeHidden();
  }
});

test("export-before-erase preserves work until acknowledgement and clears peer tabs", async ({ page, context }) => {
  const SQL = await loadFixture(page);
  await page.evaluate(id => setCellColor(id, 2), ids.firstPlayback);
  await page.evaluate(() => databaseQueue);
  const peer = await context.newPage();
  await peer.route(/https:\/\/(?:api|accounts)\.spotify\.com\//, route => route.abort("blockedbyclient"));
  await peer.goto("/");
  await expect(peer.locator("#grid .cell")).toHaveCount(1);
  await page.evaluate(() => {
    localStorage.setItem("unrelated-app-key", "keep");
    localStorage.setItem("s9000.auth", JSON.stringify({ clientId: "synthetic-client", refreshToken: "synthetic-browser-only-secret" }));
  });
  await page.locator("#btn-settings").click();
  await page.locator("#btn-logout-spotify").click();
  const exported = await exportForLogout(page);
  expect(scalar(SQL, exported, `SELECT songCellColorRaw FROM Playback WHERE playbackUUIDRaw='${ids.firstPlayback}'`)).toBe(2);
  expect(exported.includes(Buffer.from("synthetic-browser-only-secret"))).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("s9000.auth"))).not.toBeNull();
  expect(await page.evaluate(() => db !== null)).toBe(true);
  await page.locator("#btn-logout-cancel").click();
  expect(await page.evaluate(() => db !== null)).toBe(true);
  await page.locator("#btn-settings").click();
  await page.locator("#btn-logout-spotify").click();
  await expect(page.locator("#btn-logout-saved")).toBeHidden();
  await exportForLogout(page);
  await page.locator("#btn-logout-saved").click();
  await expect(page.locator("#auth-status")).toContainText("browser data was erased");
  await expect(peer.locator("#auth-status")).toContainText("browser data was erased");
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("s9000.")))).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("unrelated-app-key"))).toBe("keep");
  expect(await page.evaluate(async () => (await indexedDB.databases()).some(item => item.name === "s9000"))).toBe(false);
  expect(await peer.evaluate(() => db === null && nowPlaying === null)).toBe(true);
});
