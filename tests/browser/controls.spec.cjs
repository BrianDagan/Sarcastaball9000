const { test, expect } = require("@playwright/test");

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

test("native toolbar keys do not start the previously focused song", async ({ page }) => {
  await page.evaluate(() => {
    window.started = 0;
    window.stopped = 0;
    smartSingleTap = () => { window.started++; };
    stopPlayback = async () => { window.stopped++; };
    const cell = document.createElement("button");
    cell.className = "cell";
    cell.textContent = "Synthetic song";
    document.getElementById("grid").appendChild(cell);
    cell.focus();
  });
  await page.locator("#btn-stop-all").focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.started)).toBe(0);
  expect(await page.evaluate(() => window.stopped)).toBe(1);
  await page.locator("#btn-settings").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#modal")).toBeVisible();
  expect(await page.evaluate(() => window.started)).toBe(0);
});

test("dialogs contain keyboard focus and restore their opener", async ({ page }) => {
  expect(await page.locator('[role="dialog"]').evaluateAll(dialogs =>
    dialogs.every(dialog => dialog.parentElement === document.body))).toBe(true);
  await page.locator("#btn-settings").click();
  await expect(page.locator("#modal")).toHaveAttribute("role", "dialog");
  await page.locator("#btn-close-modal").focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.getElementById("modal").contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal")).toBeHidden();
  await expect(page.locator("#btn-settings")).toBeFocused();
});

test("the nested playhead drags and its marker is keyboard reachable", async ({ page }) => {
  await page.evaluate(() => {
    api = async path => {
      if (path.startsWith("/me/player/seek")) window.lastSeek = Number(new URL(path, location.origin).searchParams.get("position_ms"));
      return null;
    };
    const cell = document.createElement("button");
    Object.assign(cell.dataset, { pbuuid: "synthetic", trackid: "synthetic-track", startms: "0", stopms: "60000", duration: "60000", volume: "0.5", fadeout: "0" });
    cell.innerHTML = '<span class="title">Synthetic song</span><span class="meta">Synthetic artist</span>';
    setNowPlaying(cell);
  });
  const dot = page.locator("#np-bar-dot .np-ball");
  const dotBox = await dot.boundingBox();
  await page.mouse.move(dotBox.x + dotBox.width / 2, dotBox.y + dotBox.height / 2);
  await page.mouse.down();
  expect(await page.evaluate(() => dragTarget)).toBe("dot");
  const bar = await page.locator("#np-bar").boundingBox();
  await page.mouse.move(bar.x + bar.width * 0.5, bar.y + bar.height / 2);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.lastSeek)).toBeGreaterThan(20000);
  await page.locator("#np-bar-dot").focus();
  expect(await page.evaluate(() => barFocused)).toBe("dot");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#np-bar-dot")).toHaveAttribute("role", "slider");
  await expect(page.locator("#np-bar-dot")).toHaveAttribute("aria-valuemin", "0");
});

test("failed Stop stays visible and can be retried without a false stopped state", async ({ page }) => {
  await page.evaluate(() => {
    const cell = document.createElement("button");
    Object.assign(cell.dataset, { pbuuid: "synthetic", trackid: "synthetic-track", startms: "0", stopms: "60000", duration: "60000" });
    cell.innerHTML = '<span class="title">Synthetic song</span><span class="meta">Synthetic artist</span>';
    setNowPlaying(cell);
    api = async () => { throw new Error("Synthetic network failure"); };
  });
  await page.locator("#np-stop").click();
  await expect(page.locator("#transport-status")).toContainText("Stop was not confirmed");
  await expect(page.locator("#nowplaying")).toBeVisible();
  await page.evaluate(() => { api = async () => null; });
  await page.locator("#transport-status button").click();
  await expect(page.locator("#nowplaying")).toBeHidden();
  await expect(page.locator("#transport-status")).toBeHidden();
});

test("logout cancellation and canceled discard preserve unrelated and app storage", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("unrelated-app-key", "keep");
    localStorage.setItem("s9000.volume", "45");
  });
  await page.locator("#btn-settings").click();
  await page.locator("#btn-logout-spotify").click();
  await page.locator("#btn-logout-cancel").click();
  expect(await page.evaluate(() => localStorage.getItem("s9000.volume"))).toBe("45");
  await page.locator("#btn-settings").click();
  await page.locator("#btn-logout-spotify").click();
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#btn-logout-discard").click();
  expect(await page.evaluate(() => localStorage.getItem("s9000.volume"))).toBe("45");
  expect(await page.evaluate(() => localStorage.getItem("unrelated-app-key"))).toBe("keep");
});

test("database-free logout erases only app storage after explicit confirmation", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("unrelated-app-key", "keep");
    localStorage.setItem("s9000.volume", "45");
  });
  await page.locator("#btn-settings").click();
  await page.locator("#btn-logout-spotify").click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#btn-logout-discard").click();
  await expect(page.locator("#auth-status")).toContainText("browser data was erased");
  expect(await page.evaluate(() => localStorage.getItem("s9000.volume"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("unrelated-app-key"))).toBe("keep");
});

for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 800]]) {
  test(`controls fit ${width}x${height} including enlarged text`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      document.getElementById("empty-state").classList.add("hidden");
      for (const id of ["nowplaying", "np-progress", "vol-rail", "np-cue-fine"]) {
        document.getElementById(id).classList.remove("hidden");
      }
      document.getElementById("np-title").textContent = "Synthetic track with a longer title";
      document.getElementById("np-sub").textContent = "Synthetic artist and album";
      document.getElementById("np-remaining").textContent = "2:00 left";
    });
    const check = async () => {
      const dimensions = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
      expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.width);
      for (const id of ["btn-stop-all", "btn-settings", "np-stop", "vol-mute"]) {
        await page.locator(`#${id}`).scrollIntoViewIfNeeded();
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
      }
    };
    await check();
    await page.evaluate(() => {
      const sheet = document.styleSheets[0];
      sheet.insertRule("body, button, input { font-size: 24px !important; }", sheet.cssRules.length);
    });
    await check();
    expect(await page.locator('meta[name="viewport"]').getAttribute("content")).not.toContain("user-scalable=no");
  });
}
