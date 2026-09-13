const { test, expect } = require("@playwright/test");
const { getSql, fixture } = require("../helpers/database.cjs");
const { buttonContrast } = require("../helpers/contrast.cjs");

test.beforeEach(async ({ page }) => {
  page.appErrors = [];
  page.on("pageerror", error => page.appErrors.push(error.message));
  await page.route(/https:\/\/(?:api|accounts)\.spotify\.com\//, route => route.abort("blockedbyclient"));
});

test.afterEach(async ({ page }) => {
  expect(page.appErrors).toEqual([]);
});

async function browserIdentity(page, { userAgent, platform = "iPhone", maxTouchPoints = 5 }, fullscreen = false) {
  await page.addInitScript(({ userAgent, platform, maxTouchPoints, fullscreen }) => {
    Object.defineProperties(navigator, {
      userAgent: { value: userAgent, configurable: true },
      platform: { value: platform, configurable: true },
      maxTouchPoints: { value: maxTouchPoints, configurable: true },
    });
    if (!fullscreen) {
      Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true });
      Object.defineProperty(document, "webkitFullscreenEnabled", { value: false, configurable: true });
    }
  }, { userAgent, platform, maxTouchPoints, fullscreen });
}

async function loadPlayer(page, supportsVolume = true) {
  const backend = { supportsVolume, playing: false, volumeCalls: 0, pauseCalls: 0 };
  await page.route("https://api.spotify.com/v1/me/player**", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/v1/me/player") {
      return route.fulfill({ json: {
        item: { id: "synthetic-track-0" }, is_playing: backend.playing, progress_ms: 500,
        device: { id: "synthetic-device", supports_volume: backend.supportsVolume },
      } });
    }
    if (request.method() === "GET" && url.pathname === "/v1/me/player/devices") {
      return route.fulfill({ json: { devices: [{
        id: "synthetic-device", name: "Synthetic device", is_active: true,
        supports_volume: backend.supportsVolume,
      }] } });
    }
    if (request.method() !== "PUT") return route.abort("blockedbyclient");
    if (url.pathname.endsWith("/volume")) backend.volumeCalls++;
    if (url.pathname.endsWith("/play")) backend.playing = true;
    if (url.pathname.endsWith("/pause")) { backend.playing = false; backend.pauseCalls++; }
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await expect(page.locator("#empty-state")).toBeVisible();
  const SQL = await getSql();
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic.sqlite", mimeType: "application/octet-stream", buffer: Buffer.from(fixture(SQL)),
  });
  await expect(page.locator("#grid .cell")).toHaveCount(1);
  await page.evaluate(() => {
    getAccessToken = async () => "synthetic-access";
    trackPlayedOn = false;
    localStorage.setItem(LS_VOLUME, "35");
    localStorage.setItem(LS_FADE_IN, "2");
  });
  await page.locator("#grid .cell").first().click();
  await expect(page.locator("#grid .cell").first()).toHaveClass(/playing/);
  return backend;
}

for (const [device, identity] of [
  ["iPhone", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1" }],
  ["iPad desktop mode", {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15",
    platform: "MacIntel", maxTouchPoints: 5,
  }],
]) {
  test(`${device} hides ineffective volume controls without a popup or volume requests`, async ({ page }) => {
    await browserIdentity(page, identity);
    const backend = await loadPlayer(page);
    await expect(page.locator("#vol-rail")).toBeHidden();
    expect(await page.locator("body").evaluate(element => element.classList.contains("vol-open"))).toBe(false);
    await page.evaluate(() => showCueFine(0));
    await expect(page.locator("#np-cue-fine-slider")).toBeVisible();
    await expect(page.locator("#np-volume-row")).toBeHidden();
    await page.locator("#np-pause").click();
    await expect.poll(() => page.evaluate(() => nowPlaying.paused)).toBe(true);
    await page.locator("#np-pause").click();
    await expect.poll(() => page.evaluate(() => nowPlaying.paused)).toBe(false);
    await page.evaluate(async () => {
      await setVolume(50);
      await fadeIn();
      applyRailVolumeLive(50);
      applyVolumeFine(50);
      return transportQueue;
    });
    await page.locator("#btn-settings").click();
    await expect(page.locator("#volume-support-hint")).toBeVisible();
    for (const id of ["in-volume", "in-fade-in", "in-fade-out"]) {
      await expect(page.locator(`#${id}`)).toBeDisabled();
    }
    expect(await page.evaluate(() => localStorage.getItem(LS_VOLUME))).toBe("35");
    expect(await page.evaluate(() => localStorage.getItem(LS_FADE_IN))).toBe("2");
    expect(await page.evaluate(() => Object.keys(pending.volumes).length)).toBe(0);
    expect(await page.locator("#toast").allTextContents()).not.toEqual(expect.arrayContaining([expect.stringMatching(/physical or Spotify volume/i)]));
    expect(backend.volumeCalls).toBe(0);
    await expect(page.locator("#transport-status")).toBeHidden();
  });
}

test("an iPad end cue still pauses without sending volume changes", async ({ page }) => {
  await browserIdentity(page, {
    userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1",
    platform: "iPad",
  });
  const backend = await loadPlayer(page);
  await page.evaluate(() => {
    pending.stops[nowPlaying.uuid] = currentPositionMs() + 300;
    renderProgress();
  });
  await expect(page.locator("#nowplaying")).toBeHidden();
  expect(backend.pauseCalls).toBe(1);
  expect(backend.volumeCalls).toBe(0);
});

test("device capability refresh hides and restores supported desktop volume controls", async ({ page }) => {
  const backend = await loadPlayer(page, false);
  await expect(page.locator("#vol-rail")).toBeHidden();
  expect(backend.volumeCalls).toBe(0);
  backend.supportsVolume = true;
  expect(await page.evaluate(() => reconcilePlayback())).toBe(true);
  await expect(page.locator("#vol-rail")).toBeVisible();
  await page.locator("#vol-rail-slider").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => backend.volumeCalls).toBeGreaterThan(0);
  backend.supportsVolume = false;
  expect(await page.evaluate(() => reconcilePlayback())).toBe(true);
  await expect(page.locator("#vol-rail")).toBeHidden();
  await expect(page.locator("#np-pause")).toBeFocused();
});

test("the fullscreen button uses native fullscreen and tracks exits outside the button", async ({ page }) => {
  await page.goto("/");
  const button = page.locator("#btn-fullscreen");
  await expect(button).toHaveAccessibleName("Enter full screen");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await button.click();
  await expect(button).toHaveAccessibleName("Enter full screen");
  await expect(button).toHaveAttribute("aria-pressed", "false");
});

test("Home Screen help is reachable from Settings and its tabs remain readable", async ({ page }) => {
  await page.goto("/");
  await page.locator("#btn-settings").click();
  await page.locator("#btn-fullscreen-help").click();
  const dialog = page.locator("#fullscreen-help-modal");
  await expect(dialog).toBeVisible();
  for (const tab of await dialog.getByRole("tab").all()) {
    expect((await buttonContrast(tab)).ratio).toBeGreaterThanOrEqual(4.5);
    await tab.click();
    for (const state of ["normal", "hover", "focus", "pressed"]) {
      if (state === "normal") {
        await page.mouse.move(0, 0);
        await tab.evaluate(element => element.blur());
      }
      if (state === "hover") await tab.hover();
      if (state === "focus") {
        await page.mouse.move(0, 0);
        await tab.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(tab).toBeFocused();
      }
      if (state === "pressed") { await tab.hover(); await page.mouse.down(); }
      try {
        const contrast = await buttonContrast(tab);
        expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
        expect(contrast.opacity).toBe("1");
      } finally {
        if (state === "pressed") await page.mouse.up();
      }
    }
  }
  await page.locator("#btn-close-fullscreen-help").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#btn-settings")).toBeFocused();
});

for (const [browser, ua] of [
  ["safari", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1"],
  ["chrome", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/140.0 Mobile Safari/604.1"],
  ["edge", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) EdgiOS/140.0 Mobile Safari/604.1"],
  ["firefox", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) FxiOS/140.0 Mobile Safari/604.1"],
]) {
  test(`unsupported fullscreen opens accessible ${browser} Home Screen guidance`, async ({ page }) => {
    await browserIdentity(page, { userAgent: ua });
    await page.goto("/");
    await page.evaluate(() => {
      window.unwantedPlayback = 0;
      smartSingleTap = () => { window.unwantedPlayback++; };
      const tile = document.createElement("button");
      tile.className = "cell";
      tile.dataset.hotkey = "A";
      document.getElementById("grid").appendChild(tile);
      focusedCell = tile;
      localStorage.setItem("s9000.volume", "35");
    });
    const launcher = page.locator("#btn-fullscreen");
    await expect(launcher).toHaveAccessibleName("Full screen help");
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "Full screen and Home Screen", exact: true });
    await expect(dialog).toBeVisible();
    const selected = page.locator(`#fullscreen-tab-${browser}`);
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(selected).toBeFocused();
    await expect(dialog.getByRole("table")).toHaveCount(1);
    await expect(dialog).toContainText("This device");
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#btn-close-fullscreen-help")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(selected).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.locator("#fullscreen-tab-firefox")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator("#fullscreen-tab-safari")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#fullscreen-tab-chrome")).toHaveAttribute("aria-selected", "true");
    const panel = dialog.getByRole("tabpanel", { name: "Chrome", exact: true });
    await panel.focus();
    await page.keyboard.press("a");
    await page.keyboard.press("Space");
    expect(await page.evaluate(() => window.unwantedPlayback)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem("s9000.volume"))).toBe("35");
  });
}

for (const [width, height] of [[320, 568], [844, 390]]) {
  test(`browser guidance fits ${width}x${height} with enlarged text`, async ({ page }) => {
    await browserIdentity(page, { userAgent: "Mozilla/5.0 (iPhone) EdgiOS/140.0 Mobile Safari/604.1" });
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.locator("#btn-fullscreen").click();
    await page.evaluate(() => {
      const sheet = document.styleSheets[0];
      sheet.insertRule("#fullscreen-help-modal button, #fullscreen-help-modal p, #fullscreen-help-modal th, #fullscreen-help-modal td, #fullscreen-help-modal caption { font-size: 24px !important; }", sheet.cssRules.length);
    });
    const card = page.locator("#fullscreen-help-modal .modal-card");
    expect(await card.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    for (const control of await card.locator("button").all()) {
      await control.scrollIntoViewIfNeeded();
      const rect = await control.boundingBox();
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height);
    }
  });
}
