const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, createOrigin } = require("./helpers/app.cjs");

const runtimeFiles = [
  "/index.html",
  "/app.js",
  "/styles.css",
  "/assets/baseball.svg",
  "/vendor/sql-wasm.js",
  "/vendor/sql-wasm.wasm",
];

test("force refresh retrieves every runtime file and preserves browser storage", async t => {
  const origin = createOrigin();
  const app = createApp({ origin });
  t.after(app.close);
  app.window.localStorage.setItem("s9000.auth", JSON.stringify({
    clientId: "synthetic-client",
    refreshToken: "synthetic-refresh",
  }));
  app.window.localStorage.setItem("s9000.volume", "35");
  app.window.localStorage.setItem("unrelated-app-key", "keep");
  app.window.refreshRequests = [];
  app.window.refreshNavigation = null;
  app.window.fetch = async (url, options) => {
    app.window.refreshRequests.push({
      url: String(url),
      cache: options?.cache,
      credentials: options?.credentials,
    });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  app.window.testRefreshNavigation = url => { app.window.refreshNavigation = url; };
  app.run("navigateToAppRefresh = window.testRefreshNavigation");

  assert.equal(await app.run("forceRefreshApp()"), true);
  assert.deepEqual(
    app.window.refreshRequests.map(request => new URL(request.url).pathname).sort(),
    runtimeFiles.slice().sort(),
  );
  assert.ok(app.window.refreshRequests.every(request =>
    request.cache === "reload" && request.credentials === "same-origin"));
  const destination = new URL(app.window.refreshNavigation);
  assert.equal(destination.pathname, "/");
  assert.match(destination.searchParams.get("_s9000_refresh"), /^\d+$/);
  assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
  assert.equal(app.window.localStorage.getItem("unrelated-app-key"), "keep");
  assert.equal(JSON.parse(app.window.localStorage.getItem("s9000.auth")).refreshToken, "synthetic-refresh");
  assert.match(app.window.document.getElementById("app-refresh-status").textContent, /Reopening Sarcastaball/);
});

test("failed refresh stays on the current page without clearing data", async t => {
  const origin = createOrigin();
  const app = createApp({ origin });
  t.after(app.close);
  app.window.localStorage.setItem("s9000.volume", "35");
  app.window.refreshNavigation = null;
  app.window.fetch = async url => ({
    ok: !String(url).endsWith("/app.js"),
    status: 503,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  app.window.testRefreshNavigation = url => { app.window.refreshNavigation = url; };
  app.run("navigateToAppRefresh = window.testRefreshNavigation");

  assert.equal(await app.run("forceRefreshApp()"), false);
  assert.equal(app.window.refreshNavigation, null);
  assert.equal(app.window.localStorage.getItem("s9000.volume"), "35");
  assert.equal(app.window.document.getElementById("btn-force-refresh-app").disabled, false);
  assert.match(app.window.document.getElementById("app-refresh-status").textContent, /not cleared/);
});

test("refresh marker is removed without disturbing other URL state", t => {
  const app = createApp({ url: "http://127.0.0.1:8000/?mode=test&_s9000_refresh=123#section" });
  t.after(app.close);
  assert.equal(app.run("clearAppRefreshMarker()"), true);
  assert.equal(app.window.location.search, "?mode=test");
  assert.equal(app.window.location.hash, "#section");
  assert.equal(app.run("clearAppRefreshMarker()"), false);
});
