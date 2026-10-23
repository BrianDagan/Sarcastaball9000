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
    nowPlaying = state === "song"
      ? { uuid: "synthetic-playback", paused: false }
      : state === "paused" ? { uuid: "synthetic-playback", paused: true } : null;
    idleFailure = null;
    idleBlocked = false;
    updateIdleControls();
  }, state);
}

for (const [width, height] of [[1280, 800], [1024, 768], [768, 1024], [390, 844], [320, 568], [844, 390]]) {
  test(`idle indicator state changes do not shift the grid at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openApp(page);
    const indicator = page.locator("#latency-pill");
    const geometry = () => page.evaluate(() => {
      const header = document.getElementById("topbar").getBoundingClientRect();
      const grid = document.getElementById("grid-container").getBoundingClientRect();
      const indicator = document.getElementById("latency-pill").getBoundingClientRect();
      return { headerHeight: header.height, gridTop: grid.top, indicatorWidth: indicator.width, indicatorHeight: indicator.height };
    });
    const original = await geometry();
    for (const state of ["on", "song", "paused", "running", "off", "song", "on"]) {
      await renderKeepAwake(page, state);
      const expected = state === "on" ? "waiting" : state === "off" ? "disabled" : "running";
      await expect(indicator).toHaveAttribute("data-idle-state",
        ["song", "paused"].includes(state) ? "waiting" : expected);
      await expect(indicator).toHaveAttribute("data-playback-state",
        state === "song" ? "playing" : state === "paused" ? "paused" : "inactive");
      await expect(page.locator("#ipad-keepalive-status")).toBeHidden();
      const current = await geometry();
      for (const key of Object.keys(original)) expect(Math.abs(current[key] - original[key])).toBeLessThan(0.1);
      await indicator.scrollIntoViewIfNeeded();
      const bounds = await indicator.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test("the latency pill swaps active-song and confirmed-idle indicators accessibly", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("#keepalive-toggle")).toHaveCount(0);
  await page.locator("#btn-settings").click();
  await page.getByRole("tab", { name: "Awake", exact: true }).click();
  const input = page.locator("#in-ipad-keepalive");
  await expect(input).toHaveAccessibleName("Use automatic iPad idle silence");
  await renderKeepAwake(page, "on");
  await expect(input).toBeChecked();
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-idle-state", "waiting");
  await expect(page.locator("#song-playing-indicator")).toBeHidden();
  await expect(page.locator("#idle-playing-indicator")).toBeHidden();
  await renderKeepAwake(page, "song");
  const play = page.locator("#song-playing-indicator");
  await expect(play).toBeVisible();
  await expect(page.locator("#idle-playing-indicator")).toBeHidden();
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-playback-state", "playing");
  await expect(page.locator("#idle-state-text")).toContainText("A song is playing");
  await renderKeepAwake(page, "paused");
  await expect(play).toBeHidden();
  await expect(page.locator("#idle-playing-indicator")).toBeHidden();
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-playback-state", "paused");
  await renderKeepAwake(page, "off");
  await expect(input).not.toBeChecked();
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-idle-state", "disabled");
  await renderKeepAwake(page, "running");
  const ball = page.locator("#idle-playing-indicator");
  await expect(input).toBeChecked();
  await expect(play).toBeHidden();
  await expect(ball).toBeVisible();
  await expect(ball).toHaveAttribute("src", "assets/baseball.svg");
  await expect(ball).toHaveAttribute("alt", "");
  expect(await ball.evaluate(element => {
    const style = getComputedStyle(element);
    return { filter: style.filter, opacity: Number(style.opacity), playState: style.animationPlayState };
  })).toEqual({ filter: "grayscale(1)", opacity: 0.65, playState: "running" });
  await expect(page.locator("#idle-state-text")).toContainText("Idle silence is playing");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await ball.evaluate(element => element.getAnimations().length)).toBe(0);
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-idle-state", "running");
});

test("the Settings opt-out persists without restoring the removed toolbar switch", async ({ page }) => {
  await openApp(page);
  await page.locator("#btn-settings").click();
  await page.getByRole("tab", { name: "Awake", exact: true }).click();
  const input = page.locator("#in-ipad-keepalive");
  await input.focus();
  await input.uncheck();
  await expect(input).toBeFocused();
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-idle-state", "disabled");
  expect(await page.evaluate(() => localStorage.getItem(LS_IPAD_KEEPALIVE))).toBe("0");
  await page.locator("#btn-close-modal").click();
  await expect(page.locator("#keepalive-toggle")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-idle-state", "disabled");
  await page.locator("#btn-settings").click();
  await page.getByRole("tab", { name: "Awake", exact: true }).click();
  await expect(page.locator("#in-ipad-keepalive")).not.toBeChecked();
});

test("the Settings opt-out disables owned silence without an activity banner", async ({ page }) => {
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
  await page.locator("#btn-settings").click();
  await page.getByRole("tab", { name: "Awake", exact: true }).click();
  const input = page.locator("#in-ipad-keepalive");
  await input.focus();
  await input.uncheck();
  await page.evaluate(() => transportQueue);
  expect(await page.evaluate(() => window.idlePauses)).toBe(1);
  await expect(page.locator("#latency-pill")).toHaveAttribute("data-idle-state", "disabled");
  await expect(input).toBeFocused();
  await expect(page.locator("#ipad-keepalive-status")).toBeHidden();
  await expect(input).not.toBeChecked();
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
