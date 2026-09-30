const { test, expect } = require("@playwright/test");
const { getSql, fixture, ids } = require("../helpers/database.cjs");

const track = index => ({
  type: "track", id: `synthetic-bulk-${index}`, name: `Synthetic song ${index}`,
  duration_ms: 123456, artists: [{ name: "Synthetic artist" }], album: { name: "Synthetic album" },
});
const allButton = page => page.getByRole("button", { name: "Add all to this tab", exact: true });
const cancelButton = page => page.getByRole("button", { name: "Cancel loading", exact: true });
const status = page => page.locator("#add-playlist-status");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test.beforeEach(async ({ page, baseURL }) => {
  page.errors = [];
  page.external = [];
  page.backend = {
    entries: Array.from({ length: 205 }, (_, index) => ({ item: track(index) })),
    requests: [], version: "synthetic-version", versions: 0, hold: null, failSecondPage: false,
  };
  page.on("pageerror", error => page.errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === baseURL) return route.continue();
    const backend = page.backend;
    if (url.origin !== "https://api.spotify.com" || request.method() !== "GET") {
      page.external.push("Unexpected external or playback request");
      return route.abort("blockedbyclient");
    }
    backend.requests.push(url);
    if (backend.hold) await backend.hold(url);
    if (url.pathname === "/v1/me/playlists") {
      return route.fulfill({ json: { items: [{ id: "synthetic-playlist", name: "Synthetic playlist", items: { total: backend.entries.length } }], total: 1, offset: 0 } });
    }
    if (url.pathname === "/v1/playlists/synthetic-playlist") {
      backend.versions++;
      return route.fulfill({ json: { snapshot_id: backend.version } });
    }
    if (url.pathname === "/v1/playlists/synthetic-playlist/items") {
      const offset = Number(url.searchParams.get("offset"));
      if (backend.failSecondPage && offset === 100) return route.fulfill({ status: 503, json: { error: { message: "Synthetic provider failure" } } });
      const items = backend.entries.slice(offset, offset + 100);
      return route.fulfill({ json: { items, total: backend.entries.length, offset,
        next: offset + items.length < backend.entries.length ? "https://api.spotify.com/v1/playlists/synthetic-playlist/items" : null } });
    }
    page.external.push("Unexpected Spotify read");
    return route.abort("blockedbyclient");
  });
  await page.goto("/");
  await expect(page.locator("#empty-state")).toBeVisible();
  await page.evaluate(() => {
    window.testDownloads = [];
    triggerDownload = (bytes, filename) => { window.testDownloads.push({ bytes: Array.from(bytes), filename }); };
    getAccessToken = async () => "synthetic-access";
    trackPlayedOn = false;
    idleReady = false;
    cancelIdleCheck();
  });
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic.sqlite", mimeType: "application/octet-stream", buffer: Buffer.from(fixture(await getSql())),
  });
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => databaseImporting)).toBe(false);
});

test.afterEach(async ({ page }) => {
  expect(page.errors).toEqual([]);
  expect(page.external).toEqual([]);
});

async function openPlaylist(page) {
  await page.locator("#btn-add-song").click();
  await page.locator("#add-mode-playlist").click();
  await page.locator("#add-playlist-results").getByRole("button", { name: /Synthetic playlist/ }).click();
  await expect(page.locator("#add-playlist-name")).toHaveText("Synthetic playlist");
  await expect.poll(() => page.evaluate(() => plTracksState.loading)).toBe(false);
  await expect(allButton(page)).toBeVisible();
}

async function snapshot(page) {
  return page.evaluate(async () => {
    await databaseQueue;
    const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      value => value.toString(16).padStart(2, "0")).join("");
    const record = await idbGet(IDB_KEY);
    return { bytes: await digest(db.export()), revision: workingRevision, identity: databaseIdentity,
      pending: structuredClone(pending), recoveryVersion: record.version, downloads: window.testDownloads.length };
  });
}

async function holdSecondPage(page) {
  const entered = deferred(), release = deferred();
  page.backend.hold = async url => {
    if (url.searchParams.get("offset") === "100") { entered.resolve(); await release.promise; }
  };
  return { entered, release };
}

test("Add all imports the complete playlist once and normal Save exports the appended rows", async ({ page }) => {
  await openPlaylist(page);
  await expect(page.locator("#add-playlist-results .search-row")).toHaveCount(100);
  let confirmation;
  page.once("dialog", dialog => { confirmation = dialog.message(); return dialog.accept(); });
  await allButton(page).click();
  await expect(status(page)).toContainText('205 songs added to "Synthetic tab 0"');
  await expect(status(page)).toContainText("Use Save");
  await expect(allButton(page)).toBeDisabled();
  await expect(cancelButton(page)).toBeHidden();
  await expect(page.locator("#add-playlist-results")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#btn-playlist-back")).toBeFocused();
  expect(confirmation).toContain('Add 205 songs from "Synthetic playlist" to "Synthetic tab 0"');
  expect(confirmation).toContain("Repeated songs will become separate buttons");
  expect(page.backend.versions).toBe(2);
  expect(page.backend.requests.filter(url => url.searchParams.get("offset") === "200")).toHaveLength(1);
  expect(await page.evaluate(() => pending.tabOps)).toBe(1);
  expect(await page.evaluate(() => window.testDownloads.map(item => item.filename))).toEqual(["DJDad-pre-edit.sqlite.backup"]);
  await page.locator("#btn-close-add-song").click();
  await expect(page.locator("#grid .cell")).toHaveCount(206);
  await expect(page.locator("#grid .cell").first().locator(".title")).toHaveText("Synthetic track");
  await expect(page.locator("#grid .cell").last().locator(".title")).toHaveText("Synthetic song 204");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#btn-save").click();
  await expect(page.locator("#save-badge")).toHaveText("0");
  const bytes = await page.evaluate(() => window.testDownloads.at(-1).bytes);
  const db = new (await getSql()).Database(new Uint8Array(bytes));
  try {
    expect(db.exec("SELECT COUNT(*) FROM Playback")[0].values[0][0]).toBe(207);
    expect(db.exec(`SELECT stopAtSubSec FROM Playback WHERE playbackGroupUUIDRaw='${ids.firstGroup}' AND orderIndex=205`)[0].values[0][0]).toBe(0.456);
    expect(db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat()).toEqual(["AppSettings", "Playback", "PlaybackGroup", "Sound"]);
  } finally { db.close(); }
});

test("confirmation counts skipped items and preserves duplicate songs as separate buttons", async ({ page }) => {
  const repeated = { ...track(1), id: "synthetic-track-0", name: "Synthetic track" };
  page.backend.entries = [
    { item: repeated }, { track: repeated }, null, { item: null }, { item: { ...track(2), type: "episode" } },
    { item: { ...track(3), is_playable: false } }, { item: track(4), is_local: true },
  ];
  await openPlaylist(page);
  let confirmation;
  page.once("dialog", dialog => { confirmation = dialog.message(); return dialog.accept(); });
  await allButton(page).click();
  await expect(status(page)).toContainText("2 songs added");
  await expect(status(page)).toContainText("5 entries skipped");
  expect(confirmation).toContain("5 unavailable, local or non-track entries");
  await page.locator("#btn-close-add-song").click();
  await expect(page.locator("#grid .title")).toHaveText(["Synthetic track", "Synthetic track (2)", "Synthetic track (3)"]);
  expect(await page.evaluate(() => queryAll("SELECT COUNT(*) n FROM Sound")[0].n)).toBe(2);
});

test("Cancel loading stays keyboard reachable, leaves data unchanged and restores button focus", async ({ page }) => {
  await openPlaylist(page);
  const before = await snapshot(page);
  const { entered, release } = await holdSecondPage(page);
  await allButton(page).focus();
  await page.keyboard.press("Enter");
  await entered.promise;
  await expect(status(page)).toContainText("Read 100 of 205");
  await expect(cancelButton(page)).toBeFocused();
  await expect(page.locator("#add-playlist-results .search-row").first()).toBeDisabled();
  await expect(page.locator("#add-playlist-results .load-more")).toBeDisabled();
  await cancelButton(page).click();
  await expect(allButton(page)).toBeFocused();
  await expect(status(page)).toContainText("Canceled. No songs were added.");
  release.resolve();
  await expect.poll(() => page.evaluate(() => playlistBulkOperation === null)).toBe(true);
  expect(await snapshot(page)).toEqual(before);
});

for (const navigation of ["close", "back", "search", "Escape"]) {
  test(`${navigation} cancels an incomplete batch without a late confirmation or mutation`, async ({ page }) => {
    await openPlaylist(page);
    const before = await snapshot(page);
    const { entered, release } = await holdSecondPage(page);
    const dialogs = [];
    page.on("dialog", dialog => { dialogs.push(dialog.message()); return dialog.dismiss(); });
    await allButton(page).click();
    await entered.promise;
    if (navigation === "close") await page.locator("#btn-close-add-song").click();
    if (navigation === "back") await page.locator("#btn-playlist-back").click();
    if (navigation === "search") await page.locator("#add-mode-search").click();
    if (navigation === "Escape") await page.keyboard.press("Escape");
    release.resolve();
    await expect.poll(() => page.evaluate(() => playlistBulkOperation === null)).toBe(true);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    expect(await snapshot(page)).toEqual(before);
    expect(dialogs).toEqual([]);
    if (navigation === "close" || navigation === "Escape") await expect(page.locator("#btn-add-song")).toBeFocused();
  });
}

test("canceling the final confirmation performs no database change and permits another try", async ({ page }) => {
  await openPlaylist(page);
  const before = await snapshot(page);
  page.once("dialog", dialog => dialog.dismiss());
  await allButton(page).click();
  await expect(status(page)).toContainText("Canceled. No songs were added.");
  await expect(allButton(page)).toBeEnabled();
  expect(await snapshot(page)).toEqual(before);
});

test("a partial fetch failure offers a fresh retry without adding any partial rows", async ({ page }) => {
  await openPlaylist(page);
  const before = await snapshot(page);
  page.backend.failSecondPage = true;
  await allButton(page).click();
  await expect(status(page)).toContainText("No songs were added.");
  await expect(status(page)).toContainText("503");
  expect(await snapshot(page)).toEqual(before);
  page.backend.failSecondPage = false;
  page.once("dialog", dialog => dialog.accept());
  await allButton(page).click();
  await expect(status(page)).toContainText("205 songs added");
  expect(await page.evaluate(() => queryAll("SELECT COUNT(*) n FROM Playback")[0].n)).toBe(207);
});

test("recovery failure reports the already-added batch without enabling a duplicate import", async ({ page }) => {
  page.backend.entries = [{ item: track(1) }, { item: track(2) }];
  await openPlaylist(page);
  await page.evaluate(() => { idbPut = async () => { throw new Error("Synthetic recovery write failure"); }; });
  page.once("dialog", dialog => dialog.accept());
  await allButton(page).click();
  await expect(status(page)).toContainText("2 songs added");
  await expect(status(page)).toContainText("Browser recovery could not be saved");
  await expect(status(page)).toContainText("do not add the playlist again");
  await expect(allButton(page)).toBeDisabled();
  expect(await page.evaluate(() => queryAll("SELECT COUNT(*) n FROM Playback")[0].n)).toBe(4);
  expect(await page.evaluate(() => pendingCount())).toBe(1);
});

test("bulk addition preserves Lineup attendance, current paused position and individual-add behavior", async ({ page }) => {
  page.backend.entries = [{ item: track(1) }, { item: track(2) }];
  await page.evaluate(async uuid => {
    await setTabLayout(groups[0].uuid, "lineup");
    await setPlayerPresent(uuid, false);
    setNowPlaying(document.querySelector("#grid .cell"));
    setPlaybackPaused(true);
    window.savedProgress = progress;
    window.savedPosition = currentPositionMs();
    window.savedIdleGeneration = idleGeneration;
  }, ids.firstPlayback);
  await openPlaylist(page);
  page.once("dialog", dialog => dialog.accept());
  await allButton(page).click();
  await expect(status(page)).toContainText("2 songs added");
  await page.locator("#add-playlist-results .search-row").first().click();
  await expect(page.locator("#grid .cell")).toHaveCount(4);
  await page.locator("#btn-close-add-song").click();
  await expect(page.locator("#grid .lineup-row")).toHaveCount(4);
  await expect(page.locator(".lineup-present:checked")).toHaveCount(3);
  expect(await page.evaluate(() => progress === window.savedProgress && currentPositionMs() === window.savedPosition &&
    idleGeneration === window.savedIdleGeneration && nowPlaying.paused)).toBe(true);
  await expect(page.locator("#grid .cell").last().locator(".title")).toHaveText("Synthetic song 1 (2)");
});

test("bulk controls fit narrow, short and enlarged-text dialogs and remain keyboard reachable", async ({ page }) => {
  await openPlaylist(page);
  for (const [width, height] of [[320, 568], [844, 390], [768, 1024]]) {
    await page.setViewportSize({ width, height });
    if (width === 768) await page.evaluate(() => {
      const sheet = document.styleSheets[0];
      sheet.insertRule("#add-song-modal button, #add-playlist-status { font-size: 24px !important; }", sheet.cssRules.length);
    });
    await allButton(page).scrollIntoViewIfNeeded();
    await allButton(page).focus();
    await expect(allButton(page)).toBeFocused();
    const bounds = await allButton(page).boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.locator("#btn-close-add-song").scrollIntoViewIfNeeded();
    await expect(page.locator("#btn-close-add-song")).toBeInViewport();
  }
});

test("the enabled Add all button has readable text in normal, hover, keyboard-focus and pressed states", async ({ page }) => {
  await openPlaylist(page);
  const ratios = [];
  const measure = async () => {
    const colors = await allButton(page).evaluate(element => {
      const styles = getComputedStyle(element);
      return [styles.color, styles.backgroundColor];
    });
    const luminance = css => css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
      .map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
    const [first, second] = colors.map(luminance);
    ratios.push((Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05));
  };
  await page.mouse.move(1, 1);
  await measure();
  await allButton(page).hover();
  await measure();
  await page.keyboard.press("Tab");
  await allButton(page).focus();
  expect(await allButton(page).evaluate(element => element.matches(":focus-visible"))).toBe(true);
  await measure();
  await allButton(page).hover();
  await page.mouse.down();
  await measure();
  await page.mouse.move(1, 1);
  await page.mouse.up();
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
});
