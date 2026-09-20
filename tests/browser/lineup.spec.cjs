const { test, expect } = require("@playwright/test");
const { getSql, lineupFixture, ids } = require("../helpers/database.cjs");

test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });

const playerId = index => index === 0 ? ids.firstPlayback :
  `00000000-0000-4000-8000-${String(1000 + index).padStart(12, "0")}`;
const playerIds = count => Array.from({ length: count }, (_, index) => playerId(index));
const playerName = index => `Synthetic player ${index + 1}`;
const row = (page, uuid) => page.locator(`#grid .lineup-row[data-pbuuid="${uuid}"]`);
const cell = (page, uuid) => page.locator(`#grid .cell[data-pbuuid="${uuid}"]`);
const handle = (page, uuid) => row(page, uuid).locator(".lineup-handle");
const tab = (page, uuid) => page.locator(`#tabs .tab[data-groupuuid="${uuid}"]`);
const menu = page => page.locator("#ctx-menu");
const layoutOption = (page, layout) => menu(page).getByRole("button", {
  name: layout === "lineup" ? /^Lineup(?:\s+✓)?$/ : /^Standard(?:\s+✓)?$/,
});

async function lineupBytes(count = 4) {
  return Buffer.from(lineupFixture(await getSql(), count));
}

async function installRecorder(page) {
  await page.evaluate(() => {
    window.lineupTest = {
      calls: [], downloads: [], unexpected: [], failPlay: false,
      device: {
        id: "synthetic-lineup-device", name: "Synthetic speaker",
        is_active: true, is_restricted: false, supports_volume: false,
      },
      state: {
        item: { id: "synthetic-track-0", duration_ms: 123456 },
        is_playing: false, progress_ms: 0, repeat_state: "off", actions: { disallows: {} },
      },
    };
    triggerDownload = (bytes, filename) => {
      window.lineupTest.downloads.push({ filename, bytes: Array.from(bytes) });
    };
    api = async (path, options = {}, current = () => true) => {
      if (!current()) return null;
      const backend = window.lineupTest;
      const url = new URL(path, location.origin);
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : null;
      backend.calls.push({ path: url.pathname, method, body });
      if (method === "GET" && url.pathname === "/me/player/devices") {
        return { devices: [structuredClone(backend.device)] };
      }
      if (method === "GET" && url.pathname === "/me/player") {
        return { ...structuredClone(backend.state), device: structuredClone(backend.device) };
      }
      if (method === "GET" && url.pathname.startsWith("/tracks/")) {
        return { id: url.pathname.split("/").at(-1), is_playable: true, duration_ms: 93750 };
      }
      if (method === "PUT" && url.pathname === "/me/player/play") {
        if (backend.failPlay) throw new Error("Synthetic playback failure");
        const trackId = body?.uris?.[0]?.replace("spotify:track:", "") || backend.state.item.id;
        backend.state.item = { id: trackId, duration_ms: trackId === IDLE_SILENCE_TRACK ? 93750 : 123456 };
        backend.state.is_playing = true;
        if (body?.position_ms !== undefined) backend.state.progress_ms = body.position_ms;
        return null;
      }
      if (method === "PUT" && url.pathname === "/me/player/pause") {
        backend.state.is_playing = false;
        return null;
      }
      if (method === "PUT" && url.pathname === "/me/player/volume") return null;
      if (method === "PUT" && url.pathname === "/me/player/seek") {
        backend.state.progress_ms = Number(url.searchParams.get("position_ms"));
        return null;
      }
      backend.unexpected.push(`${method} ${url.pathname}`);
      throw new Error("Unexpected synthetic Spotify operation");
    };
    activeDeviceId = window.lineupTest.device.id;
    activeDeviceCapabilities = window.lineupTest.device;
    setTrackPlayed(false);
  });
}

test.beforeEach(async ({ page, baseURL }) => {
  page.lineupErrors = [];
  page.lineupExternalRequests = [];
  page.on("pageerror", error => page.lineupErrors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    page.lineupExternalRequests.push(new URL(route.request().url()).hostname);
    return route.abort("blockedbyclient");
  });
  await page.goto("/");
  await expect(page.locator("#empty-state")).toBeVisible();
  await installRecorder(page);
});

test.afterEach(async ({ page }) => {
  expect(page.lineupErrors).toEqual([]);
  expect(page.lineupExternalRequests).toEqual([]);
  expect(await page.evaluate(() => window.lineupTest?.unexpected || [])).toEqual([]);
});

async function loadLibrary(page, { count = 4, layout = "lineup" } = {}) {
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic-lineup.sqlite", mimeType: "application/octet-stream", buffer: await lineupBytes(count),
  });
  await expect(page.locator("#grid .cell")).toHaveCount(count);
  await page.evaluate(() => databaseQueue);
  if (layout === "lineup") {
    expect(await page.evaluate(uuid => setTabLayout(uuid, "lineup"), ids.firstGroup)).toBe(true);
  }
  await expect(page.locator("#grid")).toHaveAttribute("data-layout", layout);
  await page.clock.install();
}

async function chooseLayout(page, uuid, layout) {
  await tab(page, uuid).click({ button: "right" });
  await layoutOption(page, layout).click();
  await expect(tab(page, uuid)).toHaveAttribute("data-layout", layout);
}

async function expectOrder(page, order, groupUUID = ids.firstGroup) {
  await expect.poll(() => page.locator("#grid .cell").evaluateAll(cells => cells.map(item => item.dataset.pbuuid))).toEqual(order);
  const saved = await page.evaluate(uuid =>
    queryAll("SELECT playbackUUIDRaw AS uuid, orderIndex FROM Playback WHERE playbackGroupUUIDRaw=? ORDER BY orderIndex", [uuid]),
  groupUUID);
  expect(saved.map(item => item.uuid)).toEqual(order);
  expect(saved.map(item => item.orderIndex)).toEqual(order.map((_, index) => index));
  if (await page.locator("#grid").getAttribute("data-layout") === "lineup") {
    await expect(page.locator(".lineup-position")).toHaveText(order.map((_, index) => String(index + 1)));
  }
}

async function databaseSnapshot(page) {
  return page.evaluate(async () => {
    await databaseQueue;
    const digest = async bytes => bytes ? Array.from(new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    ), value => value.toString(16).padStart(2, "0")).join("") : null;
    const cached = await idbGet(IDB_KEY);
    return {
      identity: databaseIdentity, revision: getWorkingDatabaseRevision(),
      bytes: await digest(db.export()), pending: structuredClone(pending),
      baseline: await digest(baselineBytes), baselineActive,
      cached: {
        identity: cached.identity, version: cached.version, bytes: await digest(cached.bytes),
        pending: cached.pending, baseline: await digest(cached.baseline), baselineActive: cached.baselineActive,
      },
      downloads: window.lineupTest.downloads.map(item => item.filename),
    };
  });
}

async function calls(page) {
  await page.evaluate(() => transportQueue);
  return page.evaluate(() => window.lineupTest.calls);
}

async function center(locator) {
  await locator.scrollIntoViewIfNeeded();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

async function startMouseDrag(page, uuid = ids.firstPlayback, targetUUID = playerId(2), part = ".cell") {
  const from = await center(handle(page, uuid));
  const bounds = await row(page, targetUUID).boundingBox();
  const target = await row(page, targetUUID).locator(part).boundingBox();
  const to = { x: target.x + target.width / 2, y: bounds.y + bounds.height - 5 };
  await page.evaluate(() => {
    document.addEventListener("pointerdown", event => { window.lineupTest.pointerId = event.pointerId; }, { once: true });
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await expect(row(page, uuid)).toHaveClass(/lineup-dragging/);
  expect(await handle(page, uuid).evaluate(element => element.hasPointerCapture(window.lineupTest.pointerId))).toBe(true);
  return { from, to };
}

async function startTouch(page, locator) {
  const point = await center(locator);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
  return { cdp, point };
}

async function touchHold(page, locator) {
  const { cdp } = await startTouch(page, locator);
  try {
    await page.clock.fastForward(550);
    await expect(menu(page)).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.clock.fastForward(350);
    await expect(menu(page)).toBeVisible();
  } finally {
    await cdp.detach();
  }
}

async function flushTap(page) {
  await page.clock.fastForward(300);
  await page.evaluate(() => transportQueue);
}

async function pauseWithIdleSilence(page) {
  await page.evaluate(() => {
    window.lineupTest.device.name = "Synthetic iPad";
    localStorage.setItem(LS_AUTH, JSON.stringify({ clientId: "synthetic-lineup-client", refreshToken: "synthetic-lineup-refresh" }));
  });
  await cell(page, ids.firstPlayback).click();
  await flushTap(page);
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, false), ids.firstPlayback)).toBe(true);
  await page.locator("#np-pause").click();
  await page.evaluate(() => transportQueue);
  expect(await page.evaluate(() => !!idlePlayback && nowPlaying?.paused)).toBe(true);
}

test("native tab hold keeps its menu open and configures an inactive tab without activating it", async ({ page }) => {
  await loadLibrary(page, { layout: "standard" });
  const before = await databaseSnapshot(page);
  await expect(page.locator(".lineup-row")).toHaveCount(0);
  await touchHold(page, tab(page, ids.secondGroup));
  await expect(layoutOption(page, "standard")).toHaveAttribute("aria-pressed", "true");
  await expect(layoutOption(page, "lineup")).toHaveAttribute("aria-pressed", "false");
  await expect(tab(page, ids.firstGroup)).toHaveClass(/active/);
  await layoutOption(page, "lineup").tap();
  await expect(tab(page, ids.secondGroup)).toHaveAttribute("data-layout", "lineup");
  await expect(tab(page, ids.firstGroup)).toHaveClass(/active/);
  await expect(page.locator("#grid")).toHaveAttribute("data-layout", "standard");

  await tab(page, ids.firstGroup).focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await layoutOption(page, "lineup").click();
  await expect(page.locator(".lineup-row")).toHaveCount(4);
  await tab(page, ids.firstGroup).click({ button: "right" });
  await expect(layoutOption(page, "lineup")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(tab(page, ids.firstGroup)).toBeFocused();
  expect(await databaseSnapshot(page)).toEqual(before);
  expect(await calls(page)).toEqual([]);
});

test("mouse reorder previews only an insertion marker, commits once, and reaches Standard and exported SQLite", async ({ page }) => {
  await loadLibrary(page);
  const original = playerIds(4);
  const before = await databaseSnapshot(page);
  await startMouseDrag(page, original[0], original[2], ".lineup-attendance");
  await expect(page.locator(".lineup-drop-before, .lineup-drop-after")).toHaveCount(1);
  await expectOrder(page, original);
  expect(await databaseSnapshot(page)).toEqual(before);
  await page.mouse.up();
  await flushTap(page);
  const reordered = [original[1], original[2], original[0], original[3]];
  await expectOrder(page, reordered);
  await expect(handle(page, original[0])).toBeFocused();
  await expect(menu(page)).toBeHidden();
  await expect(page.locator(".lineup-present:checked")).toHaveCount(4);
  await expect(page.locator("#lineup-announcement")).toContainText("position 3 of 4");
  expect(await page.evaluate(() => pending.tabOps)).toBe(1);
  expect(await page.evaluate(() => window.lineupTest.downloads.map(item => item.filename)))
    .toEqual(["DJDad-pre-edit.sqlite.backup"]);
  expect(await calls(page)).toEqual([]);

  await chooseLayout(page, ids.firstGroup, "standard");
  await expectOrder(page, reordered);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#btn-save").click();
  await expect(page.locator("#save-badge")).toHaveText("0");
  const bytes = await page.evaluate(() => window.lineupTest.downloads.find(item => item.filename === "Sarcastaball9000.sqlite").bytes);
  const SQL = await getSql();
  const exported = new SQL.Database(new Uint8Array(bytes));
  try {
    expect(exported.exec(`SELECT playbackUUIDRaw FROM Playback WHERE playbackGroupUUIDRaw='${ids.firstGroup}' ORDER BY orderIndex`)[0].values.flat())
      .toEqual(reordered);
    expect(exported.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat())
      .toEqual(["AppSettings", "Playback", "PlaybackGroup", "Sound"]);
    expect(exported.exec(`SELECT stopAtSubSec FROM Playback WHERE playbackUUIDRaw='${ids.firstPlayback}'`)[0].values[0][0]).toBe(0.456);
  } finally {
    exported.close();
  }
});

test("native touch handle reorder changes exact order without a release playing, toggling attendance, or opening a menu", async ({ page }) => {
  await loadLibrary(page);
  const original = playerIds(4);
  const { cdp } = await startTouch(page, handle(page, original[3]));
  try {
    const target = await row(page, original[0]).boundingBox();
    const button = await cell(page, original[0]).boundingBox();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x: button.x + button.width / 2, y: target.y + 5, id: 1 }],
    });
    await expect(row(page, original[3])).toHaveClass(/lineup-dragging/);
    await expect(row(page, original[0])).toHaveClass(/lineup-drop-before/);
    await expectOrder(page, original);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  await flushTap(page);
  await expectOrder(page, [original[3], ...original.slice(0, 3)]);
  await expect(handle(page, original[3])).toBeFocused();
  await expect(page.locator(".lineup-present:checked")).toHaveCount(4);
  await expect(menu(page)).toBeHidden();
  expect(await calls(page)).toEqual([]);
  expect(await page.evaluate(() => pending.tabOps)).toBe(1);
});

test("subthreshold handle movement opens the native move menu without dirtying the database", async ({ page }) => {
  await loadLibrary(page);
  const before = await databaseSnapshot(page);
  const point = await center(handle(page, ids.firstPlayback));
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 4, point.y + 3);
  await expect(page.locator(".lineup-dragging")).toHaveCount(0);
  await page.mouse.up();
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("button", { name: "Move Up", exact: true })).toBeDisabled();
  await expect(menu(page).getByRole("button", { name: "Move Down", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(handle(page, ids.firstPlayback)).toBeFocused();
  expect(await databaseSnapshot(page)).toEqual(before);
  expect(await calls(page)).toEqual([]);
});

test("an activated same-position drag is a clean no-op, not a handle click", async ({ page }) => {
  await loadLibrary(page);
  const before = await databaseSnapshot(page);
  const point = await center(handle(page, ids.firstPlayback));
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 10, point.y);
  await expect(row(page, ids.firstPlayback)).toHaveClass(/lineup-dragging/);
  await page.mouse.up();
  await flushTap(page);
  await expectOrder(page, playerIds(4));
  await expect(menu(page)).toBeHidden();
  expect(await databaseSnapshot(page)).toEqual(before);
  expect(await calls(page)).toEqual([]);
});

test("Escape, lost capture, blur, pagehide and hidden visibility cancel native mouse drags without edits", async ({ page }) => {
  await loadLibrary(page);
  const before = await databaseSnapshot(page);
  for (const reason of ["Escape", "lostcapture", "blur", "pagehide", "hidden"]) {
    await test.step(reason, async () => {
      await startMouseDrag(page);
      if (reason === "Escape") await page.keyboard.press("Escape");
      else if (reason === "lostcapture") {
        await handle(page, ids.firstPlayback).evaluate(element => element.releasePointerCapture(window.lineupTest.pointerId));
        await page.mouse.move(400, 350);
      } else if (reason === "hidden") {
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
        });
      } else {
        await page.evaluate(type => window.dispatchEvent(new Event(type)), reason);
      }
      await expect(page.locator(".lineup-dragging, .lineup-drop-before, .lineup-drop-after")).toHaveCount(0);
      await page.mouse.up();
      await flushTap(page);
      if (reason === "hidden") await page.evaluate(() => { delete document.visibilityState; });
      await expectOrder(page, playerIds(4));
      await expect(menu(page)).toBeHidden();
      await expect(page.locator(".lineup-present:checked")).toHaveCount(4);
      expect(await databaseSnapshot(page)).toEqual(before);
      expect(await calls(page)).toEqual([]);
    });
  }
});

for (const interruption of ["touchCancel", "additional finger"]) {
  test(`a native ${interruption} cancels handle dragging without edits or release activation`, async ({ page }) => {
    await loadLibrary(page);
    const before = await databaseSnapshot(page);
    const { cdp, point } = await startTouch(page, handle(page, ids.firstPlayback));
    try {
      const moved = { x: point.x, y: point.y + 180, id: 1 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [moved] });
      await expect(row(page, ids.firstPlayback)).toHaveClass(/lineup-dragging/);
      if (interruption === "touchCancel") {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      } else {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart", touchPoints: [moved, { x: point.x + 180, y: point.y + 160, id: 2 }],
        });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
    } finally {
      await cdp.detach();
    }
    await flushTap(page);
    await expect(page.locator(".lineup-dragging, .lineup-drop-before, .lineup-drop-after")).toHaveCount(0);
    await expectOrder(page, playerIds(4));
    await expect(menu(page)).toBeHidden();
    expect(await databaseSnapshot(page)).toEqual(before);
    expect(await calls(page)).toEqual([]);
  });
}

for (const interruption of ["tab", "layout", "revision", "library"]) {
  test(`changing the ${interruption} during a native drag cannot commit its old order`, async ({ page }) => {
    await loadLibrary(page);
    const before = await databaseSnapshot(page);
    await startMouseDrag(page);
    let expected = before;
    if (interruption === "tab") {
      await tab(page, ids.secondGroup).focus();
      await page.keyboard.press("Enter");
    } else if (interruption === "layout") {
      expect(await page.evaluate(uuid => setTabLayout(uuid, "standard"), ids.firstGroup)).toBe(true);
    } else if (interruption === "revision") {
      await page.evaluate(uuid => setCellColor(uuid, 2), playerId(1));
      expected = await databaseSnapshot(page);
      await page.mouse.move(500, 400);
      await page.clock.runFor(32);
    } else {
      await page.locator("#in-db-file").setInputFiles({
        name: "replacement-lineup.sqlite", mimeType: "application/octet-stream", buffer: await lineupBytes(),
      });
      await expect(page.locator("#grid")).toHaveAttribute("data-layout", "standard");
      expected = await databaseSnapshot(page);
      expect(expected.identity).not.toBe(before.identity);
    }
    await expect(page.locator(".lineup-dragging, .lineup-drop-before, .lineup-drop-after")).toHaveCount(0);
    await page.mouse.up();
    await flushTap(page);
    if (interruption === "tab") await tab(page, ids.firstGroup).click();
    await expectOrder(page, playerIds(4));
    await expect(menu(page)).toBeHidden();
    expect(await databaseSnapshot(page)).toEqual(expected);
    expect(await calls(page)).toEqual([]);
  });
}

test("edge scrolling advances a long lineup while the DOM stays in place until pointer release", async ({ page }) => {
  await loadLibrary(page, { count: 20 });
  const original = playerIds(20);
  const from = await center(handle(page, original[0]));
  const bounds = await page.locator("#grid-container").boundingBox();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, bounds.y + bounds.height - 5, { steps: 5 });
  await expect(row(page, original[0])).toHaveClass(/lineup-dragging/);
  await page.clock.runFor(1500);
  expect(await page.locator("#grid-container").evaluate(element => element.scrollTop)).toBeGreaterThan(300);
  await expectOrder(page, original);
  const insertion = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".lineup-row")).filter(element => !element.classList.contains("lineup-dragging"));
    const before = rows.findIndex(element => element.classList.contains("lineup-drop-before"));
    return before < 0 ? rows.length : before;
  });
  expect(insertion).toBeGreaterThan(4);
  await page.mouse.up();
  await flushTap(page);
  const reordered = original.slice(1);
  reordered.splice(insertion, 0, original[0]);
  await expectOrder(page, reordered);
  await expect(handle(page, original[0])).toBeFocused();
  expect(await calls(page)).toEqual([]);
  expect(await page.evaluate(() => pending.tabOps)).toBe(1);
});

test("row bodies retain native touch scrolling and pinch instead of becoming drag handles", async ({ page }) => {
  await loadLibrary(page, { count: 20 });
  const before = await databaseSnapshot(page);
  expect(await handle(page, ids.firstPlayback).evaluate(element => getComputedStyle(element).touchAction)).toBe("none");
  expect(await cell(page, ids.firstPlayback).evaluate(element => getComputedStyle(element).touchAction)).toBe("manipulation");
  const { cdp, point } = await startTouch(page, cell(page, playerId(3)));
  try {
    for (let distance = 30; distance <= 210; distance += 30) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: point.x, y: point.y - distance, id: 1 }],
      });
      await page.clock.runFor(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.locator("#grid-container").evaluate(element => element.scrollTop)).toBeGreaterThan(50);
    const scale = await page.evaluate(() => visualViewport.scale);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x: 400, y: 350, id: 1 }, { x: 500, y: 350, id: 2 }],
    });
    for (let distance = 10; distance <= 80; distance += 10) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: 400 - distance, y: 350, id: 1 }, { x: 500 + distance, y: 350, id: 2 }],
      });
      await page.clock.runFor(32);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.evaluate(() => visualViewport.scale)).toBeGreaterThan(scale);
  } finally {
    await cdp.detach();
  }
  await flushTap(page);
  await expect(page.locator(".lineup-dragging")).toHaveCount(0);
  await expect(menu(page)).toBeHidden();
  await expectOrder(page, playerIds(20));
  expect(await databaseSnapshot(page)).toEqual(before);
  expect(await calls(page)).toEqual([]);
});

test("keyboard row navigation, handle arrows and Move buttons preserve truthful focus and boundary no-ops", async ({ page }) => {
  await loadLibrary(page);
  await expect(page.locator("#grid")).toHaveAttribute("role", "list");
  await expect(row(page, ids.firstPlayback)).toHaveAttribute("role", "listitem");
  await expect(handle(page, ids.firstPlayback)).toHaveAccessibleName("Reorder Synthetic player 1");
  await expect(handle(page, ids.firstPlayback)).toHaveAttribute("aria-describedby", "lineup-reorder-help");
  await expect(page.locator("#lineup-announcement")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#lineup-status")).toBeHidden();
  expect(await row(page, ids.firstPlayback).evaluate(element => Array.from(element.children).map(child => child.tagName)))
    .toEqual(["BUTTON", "SPAN", "BUTTON", "LABEL"]);
  await cell(page, ids.firstPlayback).focus();
  await page.keyboard.press("ArrowDown");
  await expect(cell(page, playerId(1))).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(cell(page, playerId(1))).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(cell(page, playerId(2))).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(cell(page, playerId(1))).toBeFocused();

  await handle(page, ids.firstPlayback).focus();
  const before = await databaseSnapshot(page);
  await page.keyboard.press("ArrowUp");
  expect(await databaseSnapshot(page)).toEqual(before);
  await page.keyboard.press("ArrowDown");
  await expectOrder(page, [playerId(1), ids.firstPlayback, playerId(2), playerId(3)]);
  await expect(handle(page, ids.firstPlayback)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu(page).getByRole("button", { name: "Move Up", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(handle(page, ids.firstPlayback)).toBeFocused();
  await handle(page, ids.firstPlayback).click();
  await menu(page).getByRole("button", { name: "Move Down", exact: true }).click();
  await expectOrder(page, [playerId(1), playerId(2), ids.firstPlayback, playerId(3)]);
  await expect(handle(page, ids.firstPlayback)).toBeFocused();
  await expect(page.locator("#lineup-announcement")).toContainText("position 3 of 4");
  expect(await calls(page)).toEqual([]);
});

test("attendance retains exact position, number, scroll and focus; Standard ignores but retains the flags", async ({ page }) => {
  const count = 14, index = count - 1;
  await loadLibrary(page, { count });
  const uuid = playerId(index);
  const before = await databaseSnapshot(page);
  const checkbox = row(page, uuid).getByRole("checkbox", { name: `${playerName(index)}: present for this game`, exact: true });
  await checkbox.scrollIntoViewIfNeeded();
  await checkbox.focus();
  const scroll = await page.locator("#grid-container").evaluate(element => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await checkbox.click();
  await expect(row(page, uuid)).toHaveClass(/is-absent/);
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeFocused();
  await expect(row(page, uuid).locator(".lineup-position")).toHaveText(String(index + 1));
  await expect(row(page, uuid).locator(".lineup-attendance")).toHaveText("Absent");
  await expect(cell(page, uuid)).toHaveAttribute("aria-disabled", "true");
  await expect(handle(page, uuid)).toBeEnabled();
  expect(await page.locator("#grid-container").evaluate(element => element.scrollTop)).toBeCloseTo(scroll, 0);
  await expectOrder(page, playerIds(count));
  expect(await databaseSnapshot(page)).toEqual(before);
  await cell(page, uuid).focus();
  expect(await page.evaluate(group => setTabLayout(group, "standard"), ids.firstGroup)).toBe(true);
  await expect(cell(page, uuid)).toHaveAttribute("aria-disabled", "false");
  await expect(cell(page, uuid)).toBeFocused();
  await expect(cell(page, uuid)).toBeInViewport();
  await expect(page.locator(".lineup-row")).toHaveCount(0);
  expect(await page.evaluate(id => readLineupPreferences().absent[id], uuid)).toBe(true);
  expect(await page.evaluate(group => setTabLayout(group, "lineup"), ids.firstGroup)).toBe(true);
  await expect(row(page, uuid)).toHaveClass(/is-absent/);
  await expect(cell(page, uuid)).toBeFocused();
  await expect(cell(page, uuid)).toBeInViewport();
  await expect(row(page, uuid).locator(".lineup-position")).toHaveText(String(index + 1));
  expect(await databaseSnapshot(page)).toEqual(before);
  expect(await calls(page)).toEqual([]);
});

test("present single/double/triple taps work while absent taps, Enter, hotkeys and Space cannot start transport", async ({ page }) => {
  await loadLibrary(page);
  await cell(page, ids.firstPlayback).click({ button: "right" });
  page.once("dialog", dialog => dialog.accept("A"));
  await menu(page).getByRole("button", { name: /Set hotkey/ }).click();
  await expect(cell(page, ids.firstPlayback)).toHaveAttribute("data-hotkey", "A");
  await page.evaluate(() => {
    appSettings.doubleTapStartRaw = appSettings.doubleTapPlayingRaw = "Stop";
    appSettings.tripleTapStartRaw = appSettings.tripleTapPlayingRaw = "Pause";
  });
  await cell(page, ids.firstPlayback).tap();
  await flushTap(page);
  await expect(cell(page, ids.firstPlayback)).toHaveClass(/playing/);
  for (let index = 0; index < 3; index++) {
    await cell(page, ids.firstPlayback).tap();
    await page.clock.fastForward(50);
  }
  await flushTap(page);
  expect(await page.evaluate(() => nowPlaying.paused)).toBe(true);
  for (let index = 0; index < 2; index++) {
    await cell(page, ids.firstPlayback).tap();
    await page.clock.fastForward(50);
  }
  await flushTap(page);
  expect(await page.evaluate(() => nowPlaying)).toBeNull();
  expect((await calls(page)).map(call => call.path)).toEqual(["/me/player/play", "/me/player/pause", "/me/player/pause"]);
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, false), ids.firstPlayback)).toBe(true);
  const before = await calls(page);
  for (const count of [1, 2, 3]) {
    for (let index = 0; index < count; index++) {
      await cell(page, ids.firstPlayback).tap({ force: true });
      await page.clock.fastForward(50);
    }
    await flushTap(page);
  }
  await cell(page, ids.firstPlayback).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("a");
  await page.keyboard.press("Space");
  await flushTap(page);
  expect(await calls(page)).toEqual(before);
  expect(await page.evaluate(() => nowPlaying)).toBeNull();
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, true), ids.firstPlayback)).toBe(true);
  await cell(page, playerId(1)).focus();
  await page.keyboard.press("a");
  await expect(cell(page, ids.firstPlayback)).toHaveClass(/playing/);
});

test("marking a playing row absent keeps progress alive; off-tab resume is blocked until its owning layout allows it", async ({ page }) => {
  await loadLibrary(page);
  await cell(page, ids.firstPlayback).click();
  await flushTap(page);
  await page.clock.runFor(600);
  const before = await page.evaluate(() => ({
    uuid: nowPlaying.uuid, baseTime: progress.baseTime, offset: progress.startOffsetMs,
    position: currentPositionMs(), generation: transportGeneration,
    stopTimer: stopDeadlineTimer, calls: window.lineupTest.calls.length,
  }));
  await row(page, ids.firstPlayback).locator(".lineup-present").click();
  await expect(row(page, ids.firstPlayback)).toHaveClass(/is-absent/);
  await expect(cell(page, ids.firstPlayback)).toHaveClass(/playing/);
  await expect(page.locator("#np-pause")).toBeEnabled();
  const after = await page.evaluate(() => ({
    uuid: nowPlaying.uuid, paused: nowPlaying.paused, baseTime: progress.baseTime,
    offset: progress.startOffsetMs, position: currentPositionMs(),
    generation: transportGeneration, stopTimer: stopDeadlineTimer, calls: window.lineupTest.calls.length,
  }));
  expect(after).toMatchObject({
    uuid: before.uuid, paused: false, baseTime: before.baseTime, offset: before.offset,
    generation: before.generation, stopTimer: before.stopTimer, calls: before.calls,
  });
  expect(after.position).toBeGreaterThanOrEqual(before.position);
  await handle(page, ids.firstPlayback).focus();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, ids.firstPlayback).locator(".lineup-position")).toHaveText("2");
  await expect(cell(page, ids.firstPlayback)).toHaveClass(/playing/);
  expect(await page.evaluate(() => progress.baseTime)).toBe(before.baseTime);
  expect(await page.evaluate(() => currentPositionMs())).toBeGreaterThanOrEqual(after.position);
  await cell(page, ids.firstPlayback).tap({ force: true });
  await flushTap(page);
  expect((await calls(page)).length).toBe(before.calls);
  await page.locator("#np-pause").click();
  await expect(page.locator("#np-pause")).toBeDisabled();
  expect(await page.evaluate(() => nowPlaying.paused && progress.paused)).toBe(true);
  const pausedCalls = await calls(page);
  await tab(page, ids.secondGroup).click();
  await cell(page, ids.secondPlayback).focus();
  await page.keyboard.press("Space");
  await page.evaluate(() => resumePlayback());
  expect(await calls(page)).toEqual(pausedCalls);
  await expect(page.locator("#np-pause")).toBeDisabled();
  await chooseLayout(page, ids.firstGroup, "standard");
  await expect(tab(page, ids.secondGroup)).toHaveClass(/active/);
  await expect(page.locator("#np-pause")).toBeEnabled();
  await page.locator("#np-pause").click();
  expect(await page.evaluate(() => nowPlaying.paused)).toBe(false);
  await chooseLayout(page, ids.firstGroup, "lineup");
  await page.locator("#np-pause").click();
  await expect(page.locator("#np-pause")).toBeDisabled();
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, true), ids.firstPlayback)).toBe(true);
  await expect(page.locator("#np-pause")).toBeEnabled();
  await page.locator("#np-pause").click();
  expect(await page.evaluate(() => nowPlaying.paused)).toBe(false);
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, false), ids.firstPlayback)).toBe(true);
  await page.locator("#np-stop").click();
  await expect(page.locator("#nowplaying")).toBeHidden();
  expect((await calls(page)).at(-1).path).toBe("/me/player/pause");
});

test("Start and Resume retry buttons cannot bypass a newly absent player", async ({ page }) => {
  await loadLibrary(page);
  await page.evaluate(() => { window.lineupTest.failPlay = true; });
  await cell(page, ids.firstPlayback).click();
  await flushTap(page);
  await expect(page.locator("#transport-status")).toContainText("Start was not confirmed");
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, false), ids.firstPlayback)).toBe(true);
  await page.evaluate(() => { window.lineupTest.failPlay = false; });
  const startCalls = await calls(page);
  await page.locator("#transport-status").getByRole("button", { name: "Retry", exact: true }).click();
  expect(await calls(page)).toEqual(startCalls);
  expect(await page.evaluate(() => nowPlaying)).toBeNull();
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, true), ids.firstPlayback)).toBe(true);
  await page.locator("#transport-status").getByRole("button", { name: "Retry", exact: true }).click();
  await expect(cell(page, ids.firstPlayback)).toHaveClass(/playing/);
  await page.locator("#np-pause").click();
  await page.evaluate(() => { window.lineupTest.failPlay = true; });
  await page.locator("#np-pause").click();
  await expect(page.locator("#transport-status")).toContainText("Resume was not confirmed");
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, false), ids.firstPlayback)).toBe(true);
  await page.evaluate(() => { window.lineupTest.failPlay = false; });
  const resumeCalls = await calls(page);
  await page.locator("#transport-status").getByRole("button", { name: "Retry", exact: true }).click();
  expect(await calls(page)).toEqual(resumeCalls);
  expect(await page.evaluate(() => nowPlaying.paused)).toBe(true);
});

test("an absent playing row still reaches its end cue without iPad volume commands", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperties(navigator, {
      userAgent: { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15", configurable: true },
      platform: { value: "MacIntel", configurable: true },
      maxTouchPoints: { value: 5, configurable: true },
    });
    window.lineupTest.device.supports_volume = true;
  });
  await loadLibrary(page);
  await cell(page, ids.firstPlayback).click();
  await flushTap(page);
  await page.evaluate(() => {
    pending.stops[nowPlaying.uuid] = currentPositionMs() + 1500;
    renderProgress();
  });
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, false), ids.firstPlayback)).toBe(true);
  await expect(page.locator("#vol-rail")).toBeHidden();
  await page.clock.runFor(1700);
  await page.evaluate(() => transportQueue);
  await expect(page.locator("#nowplaying")).toBeHidden();
  expect((await calls(page)).map(call => call.path)).toEqual(["/me/player/play", "/me/player/pause"]);
});

test("paused absent players preserve iPad idle silence but cannot resume the song", async ({ page }) => {
  await loadLibrary(page);
  await pauseWithIdleSilence(page);
  const state = await page.evaluate(() => ({
    paused: nowPlaying?.paused, uuid: nowPlaying?.uuid, idle: !!idlePlayback,
    ownedSong: idleResume?.uuid,
    silenceRequests: window.lineupTest.calls.filter(call => call.body?.uris?.includes(`spotify:track:${IDLE_SILENCE_TRACK}`)).length,
  }));
  expect(state).toEqual({ paused: true, uuid: ids.firstPlayback, idle: true, ownedSong: ids.firstPlayback, silenceRequests: 1 });
  await expect(page.locator("#np-pause")).toBeDisabled();
  const before = await calls(page);
  await cell(page, ids.firstPlayback).focus();
  await page.keyboard.press("Space");
  expect(await calls(page)).toEqual(before);
  await page.locator("#np-stop").click();
  await page.evaluate(() => transportQueue);
  await expect(page.locator("#nowplaying")).toBeHidden();
  expect(await page.evaluate(() => !!idlePlayback)).toBe(true);
  expect((await calls(page)).filter(call => /\/(?:volume|repeat|queue|shuffle)$/.test(call.path))).toEqual([]);
});

test("paused absent playhead and cue gestures never seek or replace owned idle silence", async ({ page }) => {
  await loadLibrary(page);
  await pauseWithIdleSilence(page);
  const before = await calls(page);
  const pausedPosition = await page.evaluate(() => currentPositionMs());
  await page.locator("#np-bar-dot").focus();
  await page.keyboard.press("ArrowRight");
  const { cdp } = await startTouch(page, page.locator("#np-bar-dot"));
  try {
    const bar = await page.locator("#np-bar").boundingBox();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x: bar.x + bar.width * 0.4, y: bar.y + bar.height / 2, id: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  expect(await calls(page)).toEqual(before);
  expect(await page.evaluate(() => currentPositionMs())).toBe(pausedPosition);

  const from = await center(page.locator("#np-bar-caret"));
  const bar = await page.locator("#np-bar").boundingBox();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width * 0.2, from.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(uuid => pending.starts[uuid], ids.firstPlayback)).toBeGreaterThan(10000);
  expect(await calls(page)).toEqual(before);
  await page.mouse.click(bar.x + bar.width * 0.75, bar.y + bar.height / 2, { button: "right" });
  await expect.poll(() => page.evaluate(uuid => pending.stops[uuid], ids.firstPlayback)).toBeGreaterThan(80000);
  expect(await calls(page)).toEqual(before);
  await page.locator("#np-bar-caret").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#np-cue-fine-slider")).toBeVisible();
  await page.locator("#np-cue-fine-slider").press("ArrowRight");
  await page.clock.runFor(250);
  expect(await calls(page)).toEqual(before);
  expect(await page.evaluate(() => ({
    paused: nowPlaying.paused, uuid: nowPlaying.uuid, position: currentPositionMs(),
    idle: !!idlePlayback, ownedSong: idleResume?.uuid,
  }))).toEqual({
    paused: true, uuid: ids.firstPlayback, position: pausedPosition, idle: true, ownedSong: ids.firstPlayback,
  });
});

test("a blocked fine-cue preview can retry the same clamped cue after attendance changes", async ({ page }) => {
  await loadLibrary(page);
  await pauseWithIdleSilence(page);
  await page.evaluate(() => showCueFine(0, "start"));
  const slider = page.locator("#np-cue-fine-slider");
  const before = await calls(page);
  await slider.press("ArrowLeft");
  await page.clock.runFor(250);
  expect(await calls(page)).toEqual(before);
  await expect(slider).toHaveValue("-50");
  await expect(slider).toHaveAttribute("aria-valuetext", /\+0\.00s.*0:00\.00/);
  await row(page, ids.firstPlayback).locator(".lineup-present").click();
  await expect(row(page, ids.firstPlayback).locator(".lineup-present")).toBeChecked();
  await slider.press("ArrowLeft");
  await page.clock.runFor(250);
  await page.evaluate(() => transportQueue);
  await expect(slider).toHaveValue("-100");
  await expect(slider).toHaveAttribute("aria-valuetext", /\+0\.00s.*0:00\.00/);
  expect((await calls(page)).slice(before.length).map(call => call.path)).toEqual(["/me/player/play", "/me/player/seek"]);
  expect(await page.evaluate(() => nowPlaying.uuid === idleResume?.uuid)).toBe(false);
  expect(await page.evaluate(() => nowPlaying.paused)).toBe(false);
  expect(await page.evaluate(() => idlePlayback)).toBeNull();
});

test("absent rows retain full right-click, keyboard and native hold menus; copied tracks start present", async ({ page }) => {
  await loadLibrary(page);
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, false), ids.firstPlayback)).toBe(true);
  await cell(page, ids.firstPlayback).click({ button: "right", force: true });
  const actions = await menu(page).locator(".ctx-item").allTextContents();
  expect(actions.length).toBeGreaterThan(5);
  for (const name of [/Copy song/, /Rename song/, /Set hotkey/, /Mark for deletion/]) {
    await expect(menu(page).getByRole("button", { name })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(cell(page, ids.firstPlayback)).toBeFocused();
  await page.keyboard.press("Shift+F10");
  expect(await menu(page).locator(".ctx-item").allTextContents()).toEqual(actions);
  await page.keyboard.press("Escape");
  await touchHold(page, cell(page, ids.firstPlayback));
  expect(await menu(page).locator(".ctx-item").allTextContents()).toEqual(actions);
  expect(await calls(page)).toEqual([]);
  page.once("dialog", dialog => dialog.accept("Synthetic copied player"));
  await menu(page).getByRole("button", { name: /Copy song/ }).tap();
  await expect(page.locator(".lineup-row")).toHaveCount(5);
  const copied = page.locator(".lineup-row").filter({ has: page.locator(".title", { hasText: "Synthetic copied player" }) });
  await expect(copied.locator(".lineup-present")).toBeChecked();
  await expect(copied.locator(".cell")).toHaveAttribute("aria-disabled", "false");
  await expect(row(page, ids.firstPlayback)).toHaveClass(/is-absent/);
  await expect(row(page, ids.firstPlayback).locator(".lineup-position")).toHaveText("1");
  expect(await calls(page)).toEqual([]);
});

test("tab rename and reorder preserve UUID preferences; confirmed everyone-present affects only that tab", async ({ page }) => {
  await loadLibrary(page);
  expect(await page.evaluate(uuid => setTabLayout(uuid, "lineup"), ids.secondGroup)).toBe(true);
  for (const uuid of [ids.firstPlayback, playerId(1), ids.secondPlayback]) {
    expect(await page.evaluate(id => setPlayerPresent(id, false), uuid)).toBe(true);
  }
  await page.evaluate(uuid => setCellPlayedFlag(uuid, true), ids.firstPlayback);
  await tab(page, ids.firstGroup).click({ button: "right" });
  page.once("dialog", dialog => dialog.accept("Synthetic renamed lineup"));
  await menu(page).getByRole("button", { name: "Rename…", exact: true }).click();
  await expect(tab(page, ids.firstGroup)).toHaveText("Synthetic renamed lineup");
  await tab(page, ids.firstGroup).click({ button: "right" });
  await menu(page).getByRole("button", { name: "Move Right", exact: true }).click();
  expect(await page.locator("#tabs .tab").evaluateAll(items => items.map(item => item.dataset.groupuuid)))
    .toEqual([ids.secondGroup, ids.firstGroup]);
  await expect(tab(page, ids.firstGroup)).toHaveClass(/active/);
  await expect(row(page, ids.firstPlayback)).toHaveClass(/is-absent/);
  const before = await databaseSnapshot(page);
  const preferences = await page.evaluate(() => readLineupPreferences());
  await tab(page, ids.firstGroup).click({ button: "right" });
  page.once("dialog", dialog => dialog.dismiss());
  await menu(page).getByRole("button", { name: "Mark everyone present", exact: true }).click();
  expect(await page.evaluate(() => readLineupPreferences())).toEqual(preferences);
  await tab(page, ids.firstGroup).click({ button: "right" });
  page.once("dialog", dialog => dialog.accept());
  await menu(page).getByRole("button", { name: "Mark everyone present", exact: true }).click();
  await expect(page.locator(".lineup-present:checked")).toHaveCount(4);
  await expect(cell(page, ids.firstPlayback)).toHaveClass(/played/);
  await expectOrder(page, playerIds(4));
  expect(await databaseSnapshot(page)).toEqual(before);
  await tab(page, ids.secondGroup).click();
  await expect(row(page, ids.secondPlayback)).toHaveClass(/is-absent/);
  await expect(row(page, ids.secondPlayback).locator(".lineup-present")).not.toBeChecked();
  expect(await calls(page)).toEqual([]);
});

test("reload keeps scoped preferences; rejected and canceled imports preserve them; successful same-file import resets defaults", async ({ page }) => {
  await loadLibrary(page);
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, false), ids.firstPlayback)).toBe(true);
  const original = await page.evaluate(() => ({ identity: databaseIdentity, key: lineupStorageKey(), preferences: readLineupPreferences() }));
  await page.reload();
  await expect(page.locator(".lineup-row")).toHaveCount(4);
  await expect(row(page, ids.firstPlayback)).toHaveClass(/is-absent/);
  expect(await page.evaluate(() => ({ identity: databaseIdentity, key: lineupStorageKey(), preferences: readLineupPreferences() }))).toEqual(original);
  await installRecorder(page);
  const before = await databaseSnapshot(page);
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic-invalid.txt", mimeType: "application/octet-stream", buffer: Buffer.from("not a database"),
  });
  await expect(page.locator("#db-status")).toContainText("Import did not complete");
  expect(await databaseSnapshot(page)).toEqual(before);
  expect(await page.evaluate(() => readLineupPreferences())).toEqual(original.preferences);
  await page.evaluate(uuid => setCellColor(uuid, 2), ids.firstPlayback);
  const withEdit = await databaseSnapshot(page);
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic-lineup.sqlite", mimeType: "application/octet-stream", buffer: await lineupBytes(),
  });
  await expect.poll(() => page.evaluate(() => databaseImporting)).toBe(false);
  expect(await databaseSnapshot(page)).toEqual(withEdit);
  expect(await page.evaluate(() => readLineupPreferences())).toEqual(original.preferences);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#in-db-file").setInputFiles({
    name: "synthetic-lineup.sqlite", mimeType: "application/octet-stream", buffer: await lineupBytes(),
  });
  await expect(page.locator("#grid")).toHaveAttribute("data-layout", "standard");
  expect(await page.evaluate(() => databaseIdentity)).not.toBe(original.identity);
  expect(await page.evaluate(() => lineupStorageKey())).not.toBe(original.key);
  expect(await page.evaluate(() => readLineupPreferences())).toEqual({ format: 1, layouts: {}, absent: {} });
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), original.key)).toEqual(original.preferences);
  expect(await page.evaluate(uuid => setTabLayout(uuid, "lineup"), ids.firstGroup)).toBe(true);
  await expect(page.locator(".lineup-present:checked")).toHaveCount(4);
  expect(await calls(page)).toEqual([]);
});

test("unreadable browser preferences fail closed and expose a recoverable settings alert without erasure", async ({ page }) => {
  await loadLibrary(page);
  expect(await page.evaluate(uuid => setPlayerPresent(uuid, false), ids.firstPlayback)).toBe(true);
  const before = await databaseSnapshot(page);
  const valid = await page.evaluate(() => localStorage.getItem(lineupStorageKey()));
  await page.evaluate(() => {
    localStorage.setItem(lineupStorageKey(), "synthetic-invalid-json");
    refreshLineupView();
  });
  await expect(page.locator("#lineup-status")).toBeVisible();
  await expect(page.locator("#lineup-status")).toHaveAttribute("role", "alert");
  await expect(page.locator("#lineup-status").getByRole("button", { name: "Retry loading settings", exact: true })).toBeVisible();
  await expect(cell(page, playerId(1))).toHaveAttribute("aria-disabled", "true");
  await cell(page, playerId(1)).focus();
  await page.keyboard.press("Enter");
  expect(await calls(page)).toEqual([]);
  expect(await databaseSnapshot(page)).toEqual(before);
  expect(await page.evaluate(() => localStorage.getItem(lineupStorageKey()))).toBe("synthetic-invalid-json");
  await page.evaluate(raw => localStorage.setItem(lineupStorageKey(), raw), valid);
  await page.locator("#lineup-status").getByRole("button", { name: "Retry loading settings", exact: true }).click();
  await expect(page.locator("#lineup-status")).toBeHidden();
  await expect(row(page, ids.firstPlayback)).toHaveClass(/is-absent/);
  await expect(cell(page, playerId(1))).toHaveAttribute("aria-disabled", "false");
});

for (const [width, height] of [[320, 568], [844, 390], [1024, 400]]) {
  test(`Lineup controls fit ${width}x${height} with enlarged text and accessible target sizes`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await loadLibrary(page, { count: 8 });
    await cell(page, ids.firstPlayback).click();
    await flushTap(page);
    for (const enlarged of [false, true]) {
      if (enlarged) {
        await page.evaluate(() => {
          const sheet = document.styleSheets[0];
          sheet.insertRule("body, button, input, .lineup-attendance { font-size: 24px !important; }", sheet.cssRules.length);
        });
      }
      const dimensions = await page.evaluate(() => {
        const grid = document.getElementById("grid");
        const scroller = document.getElementById("grid-container");
        return {
          viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
          grid: grid.clientWidth, gridScroll: grid.scrollWidth, availableHeight: scroller.clientHeight,
        };
      });
      expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
      expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
      expect(dimensions.gridScroll).toBeLessThanOrEqual(dimensions.grid + 1);
      expect(dimensions.availableHeight).toBeGreaterThanOrEqual(44);
      for (const part of [".lineup-handle", ".cell", ".lineup-attendance"]) {
        const control = row(page, ids.firstPlayback).locator(part);
        await control.scrollIntoViewIfNeeded();
        const bounds = await control.boundingBox();
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      }
      const hiddenHelp = await page.locator("#lineup-reorder-help").boundingBox();
      expect(hiddenHelp.width).toBeLessThanOrEqual(1);
      expect(hiddenHelp.height).toBeLessThanOrEqual(1);
    }
    expect(await page.locator('meta[name="viewport"]').getAttribute("content")).not.toContain("user-scalable=no");
  });
}
