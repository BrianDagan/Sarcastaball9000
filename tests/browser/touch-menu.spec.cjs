const { test, expect } = require("@playwright/test");
const { getSql, fixture, ids } = require("../helpers/database.cjs");

test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });

test.beforeEach(async ({ page }) => {
  page.appErrors = [];
  page.on("pageerror", error => page.appErrors.push(error.message));
  await page.route(/https:\/\/(?:api|accounts)\.spotify\.com\//, route => route.abort("blockedbyclient"));
  await page.goto("/");
  await expect(page.locator("#empty-state")).toBeVisible();
  const SQL = await getSql();
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic.sqlite", mimeType: "application/octet-stream", buffer: Buffer.from(fixture(SQL)),
  });
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  await page.evaluate(() => {
    window.playbackGestures = 0;
    window.doubleTapGestures = 0;
    smartSingleTap = () => { window.playbackGestures++; };
    appSettings.doubleTapStartRaw = "Stop";
    TAP_ACTIONS.Stop = () => { window.doubleTapGestures++; };
    triggerDownload = () => {};
    return databaseQueue;
  });
  await page.clock.install();
});

test.afterEach(async ({ page }) => {
  expect(page.appErrors).toEqual([]);
});

async function beginTouch(page) {
  const cell = page.locator("#grid .cell").first();
  await cell.scrollIntoViewIfNeeded();
  const bounds = await cell.boundingBox();
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
  return { cdp, point };
}

async function holdAndRelease(page) {
  const { cdp } = await beginTouch(page);
  try {
    await page.clock.fastForward(550);
    await expect(page.locator("#ctx-menu")).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
  await page.clock.fastForward(350);
  await expect(page.locator("#ctx-menu")).toBeVisible();
  expect(await page.evaluate(() => window.playbackGestures)).toBe(0);
  expect(await page.evaluate(() => window.doubleTapGestures)).toBe(0);
}

test("in-app and browser titles are shortened without changing the source-repository link", async ({ page }) => {
  await expect(page).toHaveTitle("Sarcastaball");
  await expect(page.locator("#title")).toHaveText("Sarcastaball");
  await page.locator("#btn-settings").click();
  await expect(page.getByRole("link", { name: "Source on GitHub", exact: true }))
    .toHaveAttribute("href", "https://github.com/briandagan/Sarcastaball9000");
});

test("a native touch hold opens track editing and release cannot activate playback", async ({ page }) => {
  await holdAndRelease(page);
  const menu = page.locator("#ctx-menu");
  await expect(menu.getByRole("button", { name: /Copy song/ })).toBeVisible();
  await expect(menu.getByRole("button", { name: /Rename song/ })).toBeVisible();
  await expect(menu.getByRole("button", { name: /Set hotkey/ })).toBeVisible();
  await expect(menu.getByRole("button", { name: /Mark for deletion/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.locator("#grid .cell").first()).toBeFocused();
  await page.locator("#grid .cell").first().tap();
  await page.clock.fastForward(300);
  expect(await page.evaluate(() => window.playbackGestures)).toBe(1);
});

test("a track can be renamed by touch without first playing it", async ({ page }) => {
  await holdAndRelease(page);
  page.once("dialog", dialog => dialog.accept("Renamed synthetic tile"));
  await page.locator("#ctx-menu").getByRole("button", { name: /Rename song/ }).tap();
  await expect(page.locator("#grid .cell .title")).toHaveText("Renamed synthetic tile");
  await expect(page.locator("#ctx-menu")).toBeHidden();
  expect(await page.evaluate(() => window.playbackGestures)).toBe(0);
  expect(await page.evaluate(() => nowPlaying)).toBeNull();
  expect(await page.evaluate(id => queryAll("SELECT displayTitle FROM Playback WHERE playbackUUIDRaw=?", [id])[0].displayTitle, ids.firstPlayback))
    .toBe("Renamed synthetic tile");
});

test("Copy song from the touch-opened context menu creates a separate tile without playback", async ({ page }) => {
  await holdAndRelease(page);
  page.once("dialog", dialog => dialog.accept("Copied synthetic tile"));
  await page.locator("#ctx-menu").getByRole("button", { name: /Copy song/ }).tap();
  await expect(page.locator("#grid .cell")).toHaveCount(2);
  await expect(page.locator("#grid .cell .title")).toHaveText(["Synthetic track", "Copied synthetic tile"]);
  await expect(page.locator("#ctx-menu")).toBeHidden();
  expect(await page.evaluate(() => window.playbackGestures)).toBe(0);
  expect(await page.evaluate(() => nowPlaying)).toBeNull();
  const copied = await page.evaluate(id => {
    const original = queryAll("SELECT * FROM Playback WHERE playbackUUIDRaw=?", [id])[0];
    const duplicate = queryAll("SELECT * FROM Playback WHERE displayTitle=?", ["Copied synthetic tile"])[0];
    return {
      separateTile: duplicate.playbackUUIDRaw !== original.playbackUUIDRaw,
      sameSource: duplicate.sourceUUIDRaw === original.sourceUUIDRaw,
      originalName: original.displayTitle,
      exactEndCue: duplicate.stopAtSeconds === original.stopAtSeconds && duplicate.stopAtSubSec === original.stopAtSubSec,
      sounds: queryAll("SELECT COUNT(*) AS n FROM Sound")[0].n,
    };
  }, ids.firstPlayback);
  expect(copied).toEqual({
    separateTile: true, sameSource: true, originalName: "Synthetic track", exactEndCue: true, sounds: 2,
  });
});

test("canceling Copy song leaves the library and playback untouched", async ({ page }) => {
  await holdAndRelease(page);
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#ctx-menu").getByRole("button", { name: /Copy song/ }).tap();
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  expect(await page.evaluate(() => pendingCount())).toBe(0);
  expect(await page.evaluate(() => queryAll("SELECT COUNT(*) AS n FROM Playback")[0].n)).toBe(2);
  expect(await page.evaluate(() => window.playbackGestures)).toBe(0);
});

test("moving a native touch cancels editing and does not leave a queued play", async ({ page }) => {
  const { cdp, point } = await beginTouch(page);
  try {
    await page.clock.fastForward(100);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x: point.x, y: point.y - 45, id: 1 }],
    });
    await page.clock.fastForward(550);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
  await page.clock.fastForward(350);
  await expect(page.locator("#ctx-menu")).toBeHidden();
  expect(await page.evaluate(() => window.playbackGestures)).toBe(0);
});

test("a canceled native touch cannot open the menu or play a song later", async ({ page }) => {
  const { cdp } = await beginTouch(page);
  try {
    await page.clock.fastForward(100);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  } finally { await cdp.detach(); }
  await page.clock.fastForward(700);
  await expect(page.locator("#ctx-menu")).toBeHidden();
  expect(await page.evaluate(() => window.playbackGestures)).toBe(0);
});

test("quick touch double taps still use their configured action", async ({ page }) => {
  const cell = page.locator("#grid .cell").first();
  await cell.tap();
  await page.clock.fastForward(70);
  await cell.tap();
  await page.clock.fastForward(300);
  expect(await page.evaluate(() => window.doubleTapGestures)).toBe(1);
  expect(await page.evaluate(() => window.playbackGestures)).toBe(0);
  await expect(page.locator("#ctx-menu")).toBeHidden();
});

test("secondary click and keyboard context menu remain available", async ({ page }) => {
  const cell = page.locator("#grid .cell").first();
  await cell.click({ button: "right" });
  await expect(page.locator("#ctx-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cell).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(page.locator("#ctx-menu")).toBeVisible();
  await expect(page.locator("#ctx-menu .ctx-item").first()).toBeFocused();
  expect(await page.evaluate(() => window.playbackGestures)).toBe(0);
});

test("touch-and-hold exposes exactly the existing right-click context menu", async ({ page }) => {
  const cell = page.locator("#grid .cell").first();
  const actions = page.locator("#ctx-menu .ctx-item");
  await cell.click({ button: "right" });
  const rightClickActions = await actions.allTextContents();
  expect(rightClickActions.length).toBeGreaterThan(5);
  await page.keyboard.press("Escape");
  await holdAndRelease(page);
  expect(await actions.allTextContents()).toEqual(rightClickActions);
  expect(await page.evaluate(() => window.playbackGestures)).toBe(0);
});
