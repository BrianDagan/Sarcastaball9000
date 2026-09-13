const { test, expect } = require("@playwright/test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

test.beforeEach(async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL).origin;
  expect(origin).toBe("http://127.0.0.1:4187");
  page.publicationErrors = [];
  page.on("pageerror", error => page.publicationErrors.push(error.message));
  await context.route("**/*", route => new URL(route.request().url()).origin === origin
    ? route.continue()
    : route.abort("blockedbyclient"));
  await page.goto("/");
  await expect(page.locator("#empty-state")).toBeVisible();
  await page.locator("#btn-settings").click();
  await expect(page.locator("#modal")).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(page.publicationErrors).toEqual([]);
});

test("About credits the creator and exposes safe source and served license links", async ({ page }) => {
  const about = page.getByRole("region", { name: "About", exact: true });
  await expect(about).toContainText("Created by Brian Dagan");
  await expect(about).toContainText("planned, not yet verified as published");
  await expect(page.locator("#modal")).toContainText("Sports Audio DJ");
  await expect(page.locator("#modal")).toContainText("Only explicitly confirmed logout may clear all app data.");
  const links = [
    ["Source on GitHub", "https://github.com/briandagan/Sarcastaball9000"],
    ["MIT license", "LICENSE.txt"],
    ["Third-party notices", "THIRD_PARTY_NOTICES.md"],
  ];
  for (const [name, href] of links) {
    const link = about.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /(?:^|\s)noopener(?:\s|$)/);
    await expect(link).toHaveAttribute("rel", /(?:^|\s)noreferrer(?:\s|$)/);
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
  }
  const legal = await page.evaluate(async () => {
    const entries = await Promise.all(["LICENSE.txt", "THIRD_PARTY_NOTICES.md"].map(async filename => {
      const response = await fetch(filename);
      return { status: response.status, text: await response.text() };
    }));
    return entries;
  });
  expect(legal.map(entry => entry.status)).toEqual([200, 200]);
  expect(legal[0].text).toBe(readFileSync(path.join(__dirname, "..", "..", "LICENSE"), "utf8"));
  expect(legal[0].text).toContain("Copyright (c) 2026 Brian Dagan");
  expect(legal[1].text).toContain("vendor/LICENSE.sqljs.txt");

  const source = about.getByRole("link", { name: "Source on GitHub", exact: true });
  await source.evaluate(element => {
    element.addEventListener("click", event => {
      event.preventDefault();
      element.dataset.syntheticActivation = "true";
    }, { once: true });
  });
  await source.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(source).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(source).toHaveAttribute("data-synthetic-activation", "true");
});

test("publication links do not weaken crawler, CSP or referrer protections", async ({ page }) => {
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.spotify.com https://accounts.spotify.com; base-uri 'none'; form-action 'none'",
  );
});

async function linkPresentation(link) {
  return link.evaluate(element => {
    const style = getComputedStyle(element);
    const background = getComputedStyle(element.closest(".modal-card")).backgroundColor;
    const luminance = color => color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number).map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const levels = [luminance(style.color), luminance(background)].sort((a, b) => a - b);
    return {
      ratio: (levels[1] + 0.05) / (levels[0] + 0.05),
      decoration: style.textDecorationLine,
      outline: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      focusVisible: element.matches(":focus-visible"),
    };
  });
}

test("Setup links have readable text, underlines and keyboard focus in every enabled state", async ({ page }) => {
  for (const link of await page.locator("#modal .hint a[href]").all()) {
    await link.evaluate(element => {
      element.addEventListener("click", event => event.preventDefault());
    });
    for (const state of ["normal", "hover", "focus", "pressed"]) {
      if (state === "normal") {
        await page.mouse.move(0, 0);
        await link.evaluate(element => element.blur());
        await link.scrollIntoViewIfNeeded();
      }
      if (state === "hover") await link.hover();
      if (state === "focus") {
        await page.mouse.move(0, 0);
        await link.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(link).toBeFocused();
      }
      if (state === "pressed") {
        await link.hover();
        await page.mouse.down();
      }
      try {
        const presentation = await linkPresentation(link);
        expect(presentation.ratio).toBeGreaterThanOrEqual(4.5);
        expect(presentation.decoration).toContain("underline");
        if (state === "focus") {
          expect(presentation.focusVisible).toBe(true);
          expect(presentation.outline).not.toBe("none");
          expect(presentation.outlineWidth).toBeGreaterThanOrEqual(2);
        }
      } finally {
        if (state === "pressed") await page.mouse.up();
      }
    }
  }
});

for (const [width, height] of [[320, 568], [844, 390]]) {
  test(`About links fit at ${width}x${height} with enlarged text`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      const sheet = document.styleSheets[0];
      sheet.insertRule("#modal .hint { font-size: 24px; }", sheet.cssRules.length);
    });
    const card = page.locator("#modal .modal-card");
    expect(await card.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const about = page.getByRole("region", { name: "About", exact: true });
    for (const link of await about.getByRole("link").all()) {
      await link.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(link).toBeFocused();
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeInViewport();
      const bounds = await link.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    }
  });
}
