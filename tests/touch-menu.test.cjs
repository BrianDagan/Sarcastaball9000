const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("./helpers/app.cjs");

function touchScene(t) {
  const app = createApp();
  t.after(app.close);
  let now = 0, sequence = 0;
  const timers = new Map();
  app.window.setTimeout = (callback, delay = 0) => {
    const id = ++sequence;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  app.window.clearTimeout = id => timers.delete(id);
  const advance = milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = end;
  };
  const cell = app.window.document.createElement("button");
  cell.className = "cell";
  cell.innerHTML = "<span class='title'>Synthetic song</span>";
  app.window.document.getElementById("grid").appendChild(cell);
  app.window.testCell = cell;
  app.run(`
    window.activations = 0; window.doubleActions = 0; window.tripleActions = 0; window.menuOpens = 0; window.menuActions = 0;
    smartSingleTap = () => { window.activations++; };
    TAP_ACTIONS.Stop = () => { window.doubleActions++; };
    TAP_ACTIONS.Pause = () => { window.tripleActions++; };
    appSettings = { doubleTapStartRaw: "Stop", tripleTapStartRaw: "Pause" };
    showCellContextMenu = () => {
      window.menuOpens++;
      const menu = document.getElementById("ctx-menu");
      const item = document.createElement("button");
      item.className = "ctx-item";
      item.textContent = "Synthetic edit";
      item.onclick = () => { window.menuActions++; };
      menu.replaceChildren(item);
      menu.classList.remove("hidden");
    };
    bindTaps(window.testCell);
  `);
  const pointer = (type, target = cell, options = {}) => {
    const event = new app.window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: 40, clientY: 40, button: 0,
      detail: type === "click" ? 1 : 0, ...options,
    });
    Object.defineProperties(event, {
      pointerId: { value: options.pointerId ?? 1 },
      pointerType: { value: options.pointerType ?? "touch" },
      isPrimary: { value: options.isPrimary ?? true },
    });
    target.dispatchEvent(event);
    return event;
  };
  const tap = () => { pointer("pointerdown"); advance(50); pointer("pointerup"); pointer("click"); };
  return { app, cell, pointer, advance, tap };
}

test("a stationary touch opens once at 500ms and its release cannot play or select a menu action", t => {
  const { app, cell, pointer, advance } = touchScene(t);
  pointer("pointerdown", cell.querySelector(".title"));
  advance(499);
  assert.equal(app.window.menuOpens, 0);
  advance(1);
  assert.equal(app.window.menuOpens, 1);
  pointer("contextmenu");
  assert.equal(app.window.menuOpens, 1);
  advance(3000);
  pointer("pointerup");
  const item = app.window.document.querySelector("#ctx-menu button");
  assert.equal(pointer("click", item).defaultPrevented, true);
  advance(500);
  assert.equal(app.window.activations, 0);
  assert.equal(app.window.menuActions, 0);
  pointer("pointerdown", item);
  pointer("pointerup", item);
  pointer("click", item);
  assert.equal(app.window.menuActions, 1);
});

for (const canceledBy of ["move", "pointercancel", "pointerleave", "second pointer", "blur", "pagehide", "hidden", "removed"]) {
  test(`${canceledBy} cancels a touch hold without triggering playback`, t => {
    const { app, cell, pointer, advance } = touchScene(t);
    pointer("pointerdown");
    advance(100);
    if (canceledBy === "move") pointer("pointermove", cell, { clientX: 60 });
    else if (canceledBy === "second pointer") pointer("pointerdown", app.window.document.body, { pointerId: 2, isPrimary: false });
    else if (["blur", "pagehide"].includes(canceledBy)) app.window.dispatchEvent(new app.window.Event(canceledBy));
    else if (canceledBy === "hidden") {
      Object.defineProperty(app.window.document, "visibilityState", { value: "hidden", configurable: true });
      app.window.document.dispatchEvent(new app.window.Event("visibilitychange"));
    } else if (canceledBy === "removed") cell.remove();
    else pointer(canceledBy);
    advance(500);
    pointer("pointerup", app.window.document);
    pointer("click", cell.isConnected ? cell : app.window.document.body);
    advance(500);
    assert.equal(app.window.menuOpens, 0);
    assert.equal(app.window.activations, 0);
  });
}

for (const taps of [1, 2, 3]) {
  test(`${taps} short touch tap(s) retain the configured transport behavior`, t => {
    const { app, tap, advance } = touchScene(t);
    for (let i = 0; i < taps; i++) { tap(); advance(50); }
    advance(500);
    assert.equal(app.window.menuOpens, 0);
    assert.equal(app.window.activations, taps === 1 ? 1 : 0);
    assert.equal(app.window.doubleActions, taps === 2 ? 1 : 0);
    assert.equal(app.window.tripleActions, taps === 3 ? 1 : 0);
  });
}

test("holding after a quick tap cancels the pending tap rather than starting a song under the menu", t => {
  const { app, tap, pointer, advance } = touchScene(t);
  tap();
  advance(100);
  pointer("pointerdown");
  advance(500);
  pointer("pointerup");
  pointer("click");
  advance(500);
  assert.equal(app.window.menuOpens, 1);
  assert.equal(app.window.activations, 0);
  assert.equal(app.window.doubleActions, 0);
});

test("a fresh tap still works when the browser omitted a click after the hold", t => {
  const { app, pointer, advance, tap } = touchScene(t);
  pointer("pointerdown");
  advance(500);
  pointer("pointerup");
  tap();
  advance(500);
  assert.equal(app.window.menuOpens, 1);
  assert.equal(app.window.activations, 1);
});

test("mouse holds do not invoke touch menus and right-click cancels a pending play", t => {
  const { app, pointer, advance } = touchScene(t);
  pointer("pointerdown", undefined, { pointerType: "mouse" });
  advance(700);
  assert.equal(app.window.menuOpens, 0);
  pointer("pointerup", undefined, { pointerType: "mouse" });
  pointer("click", undefined, { pointerType: "mouse" });
  pointer("contextmenu", undefined, { pointerType: "mouse", button: 2 });
  advance(500);
  assert.equal(app.window.menuOpens, 1);
  assert.equal(app.window.activations, 0);
});

test("pen holds can open the same track menu", t => {
  const { app, pointer, advance } = touchScene(t);
  pointer("pointerdown", undefined, { pointerType: "pen" });
  advance(500);
  pointer("pointerup", undefined, { pointerType: "pen" });
  pointer("click", undefined, { pointerType: "pen" });
  advance(500);
  assert.equal(app.window.menuOpens, 1);
  assert.equal(app.window.activations, 0);
});

test("clearing database state releases the remembered menu focus target", t => {
  const { app } = touchScene(t);
  app.run("contextMenuReturnFocus = window.testCell; clearDatabaseState()");
  assert.equal(app.run("contextMenuReturnFocus"), null);
});
