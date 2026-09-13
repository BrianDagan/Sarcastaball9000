const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, deferred } = require("./helpers/app.cjs");

function fullscreenApp(t, prefixed = false) {
  const app = createApp();
  t.after(app.close);
  const document = app.window.document;
  const elementKey = prefixed ? "webkitFullscreenElement" : "fullscreenElement";
  document[prefixed ? "webkitFullscreenEnabled" : "fullscreenEnabled"] = true;
  document[elementKey] = null;
  const event = prefixed ? "webkitfullscreenchange" : "fullscreenchange";
  document.documentElement[prefixed ? "webkitRequestFullscreen" : "requestFullscreen"] = () => {
    document[elementKey] = document.documentElement;
    document.dispatchEvent(new app.window.Event(event));
    return prefixed ? undefined : Promise.resolve();
  };
  document[prefixed ? "webkitExitFullscreen" : "exitFullscreen"] = () => {
    document[elementKey] = null;
    document.dispatchEvent(new app.window.Event(event));
    return prefixed ? undefined : Promise.resolve();
  };
  app.run("wireFullscreenControls()");
  return app;
}

for (const prefixed of [false, true]) {
  test(`${prefixed ? "WebKit" : "standard"} fullscreen follows actual enter/exit state`, async t => {
    const app = fullscreenApp(t, prefixed);
    const button = app.window.document.getElementById("btn-fullscreen");
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(await app.run("toggleFullscreen()"), true);
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(button.getAttribute("aria-label"), "Exit full screen");
    assert.equal(await app.run("toggleFullscreen()"), true);
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(button.getAttribute("aria-label"), "Enter full screen");
  });
}

test("a pending fullscreen request is not reported as active or duplicated", async t => {
  const app = fullscreenApp(t);
  const request = deferred();
  let calls = 0;
  app.window.document.documentElement.requestFullscreen = () => { calls++; return request.promise; };
  const entering = app.run("toggleFullscreen()");
  const button = app.window.document.getElementById("btn-fullscreen");
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(await app.run("toggleFullscreen()"), false);
  app.window.document.fullscreenElement = app.window.document.documentElement;
  app.window.document.dispatchEvent(new app.window.Event("fullscreenchange"));
  request.resolve();
  assert.equal(await entering, true);
  assert.equal(calls, 1);
  assert.equal(button.disabled, false);
});

test("fullscreen rejection reports failure without changing playback or stored data", async t => {
  const app = fullscreenApp(t);
  app.window.localStorage.setItem("s9000.volume", "35");
  app.window.document.documentElement.requestFullscreen = () => Promise.reject(new Error("Synthetic permission failure"));
  assert.equal(await app.run("toggleFullscreen()"), false);
  const button = app.window.document.getElementById("btn-fullscreen");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.disabled, false);
  assert.match(app.window.document.getElementById("toast").textContent, /Full screen was not confirmed/);
  assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
  assert.equal(app.run("nowPlaying"), null);
});

test("a WebKit fullscreen error ends a pending non-Promise request", async t => {
  const app = fullscreenApp(t, true);
  app.window.document.documentElement.webkitRequestFullscreen = () => {};
  const attempt = app.run("toggleFullscreen()");
  app.window.document.dispatchEvent(new app.window.Event("webkitfullscreenerror"));
  assert.equal(await attempt, false);
  assert.equal(app.run("fullscreenRequest"), null);
  assert.equal(app.window.document.getElementById("btn-fullscreen").disabled, false);
});

test("a silent fullscreen request times out without claiming success", async t => {
  const app = fullscreenApp(t, true);
  let timeout;
  app.window.setTimeout = callback => { timeout = callback; return 1; };
  app.window.clearTimeout = () => {};
  app.window.document.documentElement.webkitRequestFullscreen = () => {};
  const attempt = app.run("toggleFullscreen()");
  timeout();
  assert.equal(await attempt, false);
  assert.equal(app.window.document.getElementById("btn-fullscreen").getAttribute("aria-pressed"), "false");
  assert.equal(app.window.document.getElementById("btn-fullscreen").disabled, false);
});

for (const [browser, ua] of [
  ["safari", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1"],
  ["chrome", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/140.0 Mobile Safari/604.1"],
  ["edge", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) EdgiOS/140.0 Mobile Safari/604.1"],
  ["firefox", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) FxiOS/140.0 Mobile Safari/604.1"],
]) {
  test(`unsupported fullscreen opens help on the detected ${browser} tab`, async t => {
    const app = createApp();
    t.after(app.close);
    Object.defineProperty(app.window.navigator, "userAgent", { value: ua, configurable: true });
    app.run("wireFullscreenControls()");
    assert.equal(await app.run("toggleFullscreen()"), false);
    const document = app.window.document;
    assert.equal(document.getElementById("fullscreen-help-modal").classList.contains("hidden"), false);
    const tab = document.getElementById(`fullscreen-tab-${browser}`);
    assert.equal(tab.getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, tab);
    assert.equal(document.getElementById("fullscreen-guide-panel").getAttribute("aria-labelledby"), tab.id);
    assert.match(document.getElementById("fullscreen-guide-steps").textContent, /Home Screen|Home screen/);
  });
}
