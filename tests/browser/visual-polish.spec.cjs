const { test, expect } = require("@playwright/test");
const { getSql, fixture, ids } = require("../helpers/database.cjs");
const { buttonContrast } = require("../helpers/contrast.cjs");

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

async function seedPlayback(page, fromDatabase = false) {
  if (fromDatabase) {
    const SQL = await getSql();
    await page.locator("#in-db-file").setInputFiles({
      name: "synthetic.sqlite", mimeType: "application/x-sqlite3", buffer: Buffer.from(fixture(SQL)),
    });
    await expect(page.locator("#grid .cell")).toHaveCount(1);
  }
  await page.evaluate(useDatabase => {
    api = async (path, options = {}) => options.method ? null : {
      item: { id: playingSnapshot?.trackid }, is_playing: !nowPlaying?.paused,
      progress_ms: 1000, device: { id: "synthetic-device", supports_volume: true },
    };
    ensureDevice = async () => "synthetic-device";
    activeDeviceCapabilities = { supports_volume: true };
    trackPlayedOn = false;
    let cell = document.querySelector("#grid .cell");
    if (!useDatabase) {
      cell = document.createElement("button");
      cell.className = "cell";
      Object.assign(cell.dataset, {
        pbuuid: "synthetic", trackid: "synthetic-track", startms: "0",
        stopms: "60000", duration: "60000", volume: "0.4", fadeout: "0",
      });
      cell.innerHTML = '<span class="title">Synthetic song</span><span class="meta">Synthetic artist</span>';
      document.getElementById("grid").appendChild(cell);
      document.getElementById("empty-state").classList.add("hidden");
    }
    setNowPlaying(cell);
  }, fromDatabase);
}

test("baseball pixels stay centered at favicon sizes and multiple rotation angles", async ({ page }) => {
  const measurements = await page.evaluate(async () => {
    const image = new Image();
    image.src = document.querySelector('link[rel~="icon"]').href;
    await image.decode();
    const rows = [];
    for (const size of [16, 32]) {
      for (const angle of [0, 45, 90, 135, 180, 270]) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size * 3;
        const ctx = canvas.getContext("2d");
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(angle * Math.PI / 180);
        ctx.drawImage(image, -size / 2, -size / 2, size, size);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            if (pixels[(y * canvas.width + x) * 4 + 3] < 32) continue;
            left = Math.min(left, x); right = Math.max(right, x);
            top = Math.min(top, y); bottom = Math.max(bottom, y);
          }
        }
        rows.push({ size, angle, left, right, top, bottom, expectedCenter: (canvas.width - 1) / 2 });
      }
    }
    return rows;
  });
  for (const row of measurements) {
    expect(row.right - row.left + 1).toBeGreaterThan(row.size * 0.7);
    expect(row.right - row.left + 1).toBeLessThanOrEqual(row.size + 1);
    expect(row.bottom - row.top + 1).toBeLessThanOrEqual(row.size + 1);
    expect(Math.abs((row.left + row.right) / 2 - row.expectedCenter)).toBeLessThanOrEqual(0.5);
    expect(Math.abs((row.top + row.bottom) / 2 - row.expectedCenter)).toBeLessThanOrEqual(0.5);
  }
});

test("baseball spin stays centered and follows pause, resume, stop and reduced motion", async ({ page }) => {
  await seedPlayback(page);
  const logo = page.locator("#logo-ball");
  const ball = page.locator("#np-bar-dot");
  for (const target of [logo, ball]) {
    await expect(target).toHaveClass(/spinning/);
    expect(await target.evaluate(element => element.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
  }
  const centers = await page.evaluate(() => {
    pauseProgress();
    return [document.getElementById("logo-ball"), document.getElementById("np-bar-dot")].map(element => {
      const animation = element.getAnimations({ subtree: true })[0];
      animation.pause();
      const target = animation.effect.target;
      const duration = animation.effect.getComputedTiming().duration;
      const positions = [0, 45, 90, 135, 180, 270].map(angle => {
        animation.currentTime = duration * angle / 360;
        const rect = target.getBoundingClientRect();
        return [rect.x + rect.width / 2, rect.y + rect.height / 2];
      });
      return { positions, filter: getComputedStyle(target).filter };
    });
  });
  for (const { positions, filter } of centers) {
    expect(filter).toBe("none");
    for (const position of positions) {
      expect(Math.abs(position[0] - positions[0][0])).toBeLessThan(0.1);
      expect(Math.abs(position[1] - positions[0][1])).toBeLessThan(0.1);
    }
  }
  await page.evaluate(() => pausePlayback());
  for (const target of [logo, ball]) await expect(target).not.toHaveClass(/spinning/);
  await page.evaluate(() => resumePlayback());
  for (const target of [logo, ball]) await expect(target).toHaveClass(/spinning/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const target of [logo, ball]) {
    expect(await target.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  }
  await page.evaluate(() => stopPlayback());
  for (const target of [logo, ball]) await expect(target).not.toHaveClass(/spinning/);
});

test("transport Retry is readable and keyboard-operable in every enabled state", async ({ page }) => {
  await page.evaluate(() => {
    window.retryCalls = 0;
    reportTransportFailure("Start", new Error("Synthetic playback failure."), () => { window.retryCalls++; });
  });
  const retry = page.locator("#transport-status").getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  for (const state of ["normal", "hover", "focus", "pressed"]) {
    if (state === "hover") await retry.hover();
    if (state === "focus") {
      await page.mouse.move(0, 0);
      await retry.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(retry).toBeFocused();
    }
    if (state === "pressed") {
      await retry.hover();
      await page.mouse.down();
    }
    try {
      const contrast = await buttonContrast(retry);
      expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
      expect(contrast.opacity).toBe("1");
    } finally {
      if (state === "pressed") await page.mouse.up();
    }
  }
  expect(await page.evaluate(() => window.retryCalls)).toBe(1);
  await page.mouse.move(0, 0);
  await retry.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();
  const focus = await retry.evaluate(element => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
  });
  expect(focus.outlineStyle).not.toBe("none");
  expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.retryCalls)).toBe(2);
  await page.setViewportSize({ width: 320, height: 568 });
  await retry.scrollIntoViewIfNeeded();
  const rect = await retry.boundingBox();
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(320);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.y + rect.height).toBeLessThanOrEqual(568);
});

test("Settings alone widens to 680px and enabled logout text has sufficient contrast", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator("#btn-settings").click();
  const settings = page.locator("#modal .modal-card");
  expect((await settings.boundingBox()).width).toBeCloseTo(680, 0);
  const logout = page.locator("#btn-logout-spotify");
  await expect(logout).toBeEnabled();
  for (const state of ["normal", "hover", "focus"]) {
    if (state === "hover") await logout.hover();
    if (state === "focus") await logout.focus();
    const contrast = await buttonContrast(logout);
    expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
    expect(contrast.opacity).toBe("1");
  }
  if (process.env.DJDAD_CAPTURE_PREVIEWS === "1") {
    await page.screenshot({ path: testInfo.outputPath("settings-preview.png") });
  }
  await logout.click();
  await expect(page.locator("#logout-modal")).toBeVisible();
  expect((await page.locator("#logout-modal .modal-card").boundingBox()).width).toBeLessThanOrEqual(560);
  await page.locator("#btn-logout-cancel").click();
});

for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 800]]) {
  test(`Settings stays usable at ${width}x${height} with enlarged text`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.locator("#btn-settings").click();
    await page.evaluate(() => {
      const sheet = document.styleSheets[0];
      sheet.insertRule("#modal, #modal label, #modal p, #modal button, #modal input, #modal select, #modal code { font-size: 24px !important; }", sheet.cssRules.length);
    });
    const card = page.locator("#modal .modal-card");
    const box = await card.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    const overflow = await card.evaluate(element => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    for (const id of ["btn-logout-spotify", "in-db-file", "btn-close-modal"]) {
      const control = page.locator(`#${id}`);
      await control.scrollIntoViewIfNeeded();
      const rect = await control.boundingBox();
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height + 1);
    }
    await page.locator("#btn-close-modal").click();
    await expect(page.locator("#modal")).toBeHidden();
    await expect(page.locator("#btn-settings")).toBeFocused();
  });
}

test("footer and context menu share native delete/undo icons without immediate deletion", async ({ page }, testInfo) => {
  await seedPlayback(page, true);
  const tile = page.locator("#grid .cell").first();
  const footer = page.locator("#np-delete");
  const icon = footer.locator(".emoji-icon");
  await expect(footer).toHaveAccessibleName(/Mark.*deletion/i);
  await expect(icon).toHaveText("\u{1F5D1}\uFE0F");
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  expect(await icon.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/Emoji/);
  await footer.click();
  await expect(footer).toHaveAccessibleName(/Undo.*deletion/i);
  await expect(icon).toHaveText("\u21A9\uFE0F");
  expect(await page.evaluate(id => pending.deletes.includes(id), ids.firstPlayback)).toBe(true);
  expect(await page.evaluate(id => queryAll("SELECT COUNT(*) AS n FROM Playback WHERE playbackUUIDRaw=?", [id])[0].n, ids.firstPlayback)).toBe(1);
  await tile.click({ button: "right" });
  const undo = page.locator("#ctx-menu").getByRole("button", { name: /Undo.*deletion/i });
  await expect(undo.locator(".emoji-icon")).toHaveText("\u21A9\uFE0F");
  await undo.click();
  await expect(icon).toHaveText("\u{1F5D1}\uFE0F");
  expect(await page.evaluate(() => pending.deletes.length)).toBe(0);
  await tile.click({ button: "right" });
  const mark = page.locator("#ctx-menu").getByRole("button", { name: /Mark.*deletion/i });
  await expect(mark.locator(".emoji-icon")).toHaveText("\u{1F5D1}\uFE0F");
  page.once("dialog", dialog => dialog.dismiss());
  await mark.click();
  expect(await page.evaluate(() => pending.deletes.length)).toBe(0);
  await expect(icon).toHaveText("\u{1F5D1}\uFE0F");
  await tile.click({ button: "right" });
  if (process.env.DJDAD_CAPTURE_PREVIEWS === "1") {
    await page.screenshot({ path: testInfo.outputPath("delete-preview.png") });
  }
  page.once("dialog", dialog => dialog.accept());
  await mark.click();
  expect(await page.evaluate(id => pending.deletes.includes(id), ids.firstPlayback)).toBe(true);
  await expect(icon).toHaveText("\u21A9\uFE0F");
  await footer.click();
  expect(await page.evaluate(() => pending.deletes.length)).toBe(0);
  expect(await page.evaluate(id => queryAll("SELECT COUNT(*) AS n FROM Playback WHERE playbackUUIDRaw=?", [id])[0].n, ids.firstPlayback)).toBe(1);
});
