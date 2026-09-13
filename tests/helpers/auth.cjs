const { deferred } = require("./app.cjs");

function captureNavigation(app) {
  app.navigations = [];
  app.window.testNavigate = url => app.navigations.push(url);
  app.run("navigateToSpotify = window.testNavigate");
}

async function startLogin(app, clientId = "synthetic-client") {
  if (!app.navigations) captureNavigation(app);
  await app.run(`beginSpotifyLogin(${JSON.stringify(clientId)})`);
  const raw = app.window.sessionStorage.getItem("s9000.pkce");
  const pkce = JSON.parse(raw);
  return { raw, pkce, key: "s9000.login." + pkce.state };
}

function callback(app, attempt, query = "code=synthetic-code") {
  app.window.history.replaceState({}, "", `?${query}&state=${encodeURIComponent(attempt.pkce.state)}`);
  return app.run("handleAuthRedirect()");
}

function tokenResponse() {
  return new Response(JSON.stringify({
    access_token: "synthetic-access",
    refresh_token: "synthetic-rotated",
    expires_in: 3600,
  }));
}

async function holdAuthLock(app) {
  const entered = deferred();
  const release = deferred();
  const done = app.window.navigator.locks.request(app.run("AUTH_LOCK_NAME"), () => {
    entered.resolve();
    return release.promise;
  });
  await entered.promise;
  return { release: release.resolve, done };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("Synthetic lifecycle checkpoint was not reached");
}

async function settlePeers(origin, ...apps) {
  origin.flushEvents();
  await new Promise(resolve => setImmediate(resolve));
  await Promise.all(apps.map(app => app.run("Promise.all([...peerEraseTasks.values()])")));
}

module.exports = { captureNavigation, startLogin, callback, tokenResponse, holdAuthLock, waitFor, settlePeers };
