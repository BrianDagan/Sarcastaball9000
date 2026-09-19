const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  page.appErrors = [];
  page.on("pageerror", error => page.appErrors.push(error.message));
  await page.route(/https:\/\/(?:api|accounts)\.spotify\.com\//, route => route.abort("blockedbyclient"));
});

test.afterEach(async ({ page }) => {
  expect(page.appErrors).toEqual([]);
});

async function openApp(page) {
  await page.goto("/");
  await expect(page.locator("#empty-state")).toBeVisible();
  await expect(page.locator("#btn-fullscreen")).toBeVisible();
}

async function renderKeepAwake(page, state) {
  await page.evaluate(state => {
    localStorage.setItem(LS_IPAD_KEEPALIVE, state === "off" ? "0" : "1");
    idlePlayback = state === "running" ? { deviceId: "synthetic-device", durationMs: 600000 } : null;
    idleFailure = null;
    idleBlocked = false;
    updateIdleControls();
  }, state);
}

for (const [width, height] of [[1280, 800], [1024, 768], [768, 1024], [390, 844], [320, 568], [844, 390]]) {
  test(`keep-awake state changes do not shift the grid at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openApp(page);
    const toggle = page.locator("#keepalive-toggle");
    const geometry = () => page.evaluate(() => {
      const header = document.getElementById("topbar").getBoundingClientRect();
      const grid = document.getElementById("grid-container").getBoundingClientRect();
      const toggle = document.getElementById("keepalive-toggle").getBoundingClientRect();
      return { headerHeight: header.height, gridTop: grid.top, toggleWidth: toggle.width, toggleHeight: toggle.height };
    });
    const original = await geometry();
    for (const state of ["on", "running", "off", "running", "on"]) {
      await renderKeepAwake(page, state);
      await expect(toggle).toHaveAttribute("data-state", state);
      await expect(page.locator("#ipad-keepalive-status")).toBeHidden();
      const current = await geometry();
      for (const key of Object.keys(original)) expect(Math.abs(current[key] - original[key])).toBeLessThan(0.1);
      await toggle.scrollIntoViewIfNeeded();
      const bounds = await toggle.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test("keep-awake has three distinct accessible states and a muted shared baseball", async ({ page }) => {
  await openApp(page);
  const input = page.locator("#keepalive-enabled");
  await expect(input).toHaveAccessibleName("Keep iPad Spotify awake");
  await renderKeepAwake(page, "on");
  await expect(input).toBeChecked();
  await expect(page.locator("#keepalive-emoji")).toHaveText("\u2615\uFE0F");
  await expect(page.locator("#keepalive-ball")).toBeHidden();
  await renderKeepAwake(page, "off");
  await expect(input).not.toBeChecked();
  await expect(page.locator("#keepalive-emoji")).toHaveText("\u{1F634}");
  await renderKeepAwake(page, "running");
  const ball = page.locator("#keepalive-ball");
  await expect(input).toBeChecked();
  await expect(page.locator("#keepalive-emoji")).toBeHidden();
  await expect(ball).toBeVisible();
  await expect(ball).toHaveAttribute("src", "assets/baseball.svg");
  await expect(ball).toHaveAttribute("alt", "");
  expect(await ball.evaluate(element => {
    const style = getComputedStyle(element);
    return { filter: style.filter, opacity: Number(style.opacity), playState: style.animationPlayState };
  })).toEqual({ filter: "grayscale(1)", opacity: 0.65, playState: "running" });
  await expect(page.locator("#keepalive-state-text")).toContainText("Silence is playing");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await ball.evaluate(element => element.getAnimations().length)).toBe(0);
  await expect(page.locator("#keepalive-toggle")).toHaveAttribute("data-state", "running");
});

test("toolbar and Settings keep-awake switches stay synchronized without stealing focus", async ({ page }) => {
  await openApp(page);
  await page.locator("#keepalive-enabled").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#keepalive-toggle")).toHaveAttribute("data-state", "off");
  await expect(page.locator("#keepalive-enabled")).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem(LS_IPAD_KEEPALIVE))).toBe("0");
  await page.locator("#btn-settings").click();
  await expect(page.locator("#in-ipad-keepalive")).not.toBeChecked();
  await page.locator("#in-ipad-keepalive").check();
  await expect(page.locator("#keepalive-enabled")).toBeChecked();
  await expect(page.locator("#keepalive-toggle")).toHaveAttribute("data-state", "on");
  await page.locator("#btn-close-modal").click();
  await page.locator("#keepalive-toggle").click();
  await expect(page.locator("#keepalive-enabled")).not.toBeChecked();
  await page.reload();
  await expect(page.locator("#keepalive-toggle")).toHaveAttribute("data-state", "off");
  await expect(page.locator("#keepalive-emoji")).toHaveText("\u{1F634}");
});

test("the toolbar switch disables owned silence without an activity banner", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    window.idlePauses = 0;
    api = async (path, options = {}) => {
      if (!options.method) return {
        device: { id: "synthetic-device", name: "Synthetic iPad" },
        item: { id: IDLE_SILENCE_TRACK }, is_playing: true,
      };
      if (path.startsWith("/me/player/pause?")) { window.idlePauses++; return null; }
      throw new Error("Unexpected synthetic command");
    };
  });
  await renderKeepAwake(page, "running");
  await page.locator("#keepalive-enabled").focus();
  await page.keyboard.press("Space");
  await page.evaluate(() => transportQueue);
  expect(await page.evaluate(() => window.idlePauses)).toBe(1);
  await expect(page.locator("#keepalive-toggle")).toHaveAttribute("data-state", "off");
  await expect(page.locator("#keepalive-enabled")).toBeFocused();
  await expect(page.locator("#ipad-keepalive-status")).toBeHidden();
  await expect(page.locator("#in-ipad-keepalive")).not.toBeChecked();
});

test("Track Played uses uncovered and covered monkey faces with unchanged checkbox behavior", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("synthetic-monkey-seeded")) {
      sessionStorage.setItem("synthetic-monkey-seeded", "1");
      localStorage.setItem("s9000.trackPlayed", "0");
    }
  });
  await openApp(page);
  const input = page.locator("#track-played");
  const icon = page.locator("#track-played-icon");
  await expect(input).toHaveAccessibleName("Track played songs");
  await expect(icon).toHaveText("\u{1F648}");
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  const width = (await page.locator("#track-played-toggle").boundingBox()).width;
  await input.focus();
  await page.keyboard.press("Space");
  await expect(input).toBeChecked();
  await expect(icon).toHaveText("\u{1F435}");
  expect(await page.evaluate(() => trackPlayedOn)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem(LS_TRACK_PLAYED))).toBe("1");
  expect((await page.locator("#track-played-toggle").boundingBox()).width).toBe(width);
  await page.locator("#track-played-toggle").click();
  await expect(input).not.toBeChecked();
  await expect(icon).toHaveText("\u{1F648}");
  await page.reload();
  await expect(icon).toHaveText("\u{1F648}");
  expect(await page.evaluate(() => trackPlayedOn)).toBe(false);
});
