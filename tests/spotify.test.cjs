const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, deferred } = require("./helpers/app.cjs");

const track = { type: "track", id: "synthetic-track", name: "Synthetic track", duration_ms: 123456, artists: [] };

test("search uses the Development Mode maximum and clearing input invalidates stale results", async t => {
  const app = createApp();
  t.after(app.close);
  const request = deferred();
  let path;
  app.window.testApi = value => { path = value; return request.promise; };
  app.run("addSongApiMarket = window.testApi; addSearchState.term = 'test'");
  const search = app.run("runAddSearch(true)");
  assert.match(path, /limit=10(?:&|$)/);
  app.run("onAddSearchInput('')");
  request.resolve({ tracks: { items: [track], total: 1 } });
  await search;
  assert.equal(app.window.document.querySelectorAll("#add-search-results .search-row").length, 0);
});

test("a page with no playable tracks still exposes the next page", async t => {
  const app = createApp();
  t.after(app.close);
  app.window.testApi = async () => ({ tracks: { items: [{ ...track, is_playable: false }], total: 2 } });
  app.run("addSongApiMarket = window.testApi; addSearchState.term = 'test'");
  await app.run("runAddSearch(true)");
  assert.ok(app.window.document.querySelector("#add-search-results .load-more"));
});

test("returning from a playlist rejects the old track response", async t => {
  const app = createApp();
  t.after(app.close);
  const request = deferred();
  app.window.testApi = () => request.promise;
  app.run("addSongApiMarket = window.testApi; plTracksState.id = 'synthetic-playlist'");
  const load = app.run("loadPlaylistTracks(true)");
  app.run("showPlaylistList()");
  request.resolve({ items: [{ item: track }], total: 1 });
  await load;
  assert.equal(app.window.document.querySelectorAll("#add-playlist-results .search-row").length, 0);
});

test("playlist count uses current items field and results are native buttons", async t => {
  const app = createApp();
  t.after(app.close);
  app.window.testApi = async () => ({ items: [{ id: "synthetic-playlist", name: "Synthetic list", items: { total: 2 } }], total: 1 });
  app.run("addSongApi = window.testApi");
  await app.run("loadPlaylists(true)");
  const row = app.window.document.querySelector("#add-playlist-results .search-row");
  assert.equal(row.tagName, "BUTTON");
  assert.match(row.textContent, /2 items/);
});

test("quota exhaustion is not retried or treated as a market error", async t => {
  const app = createApp();
  t.after(app.close);
  let calls = 0;
  app.window.testApi = async () => {
    calls++;
    const error = new Error("Synthetic quota error");
    error.status = 429;
    error.reason = "QUOTA_EXCEEDED";
    error.retryAfterMs = 0;
    throw error;
  };
  app.run("api = window.testApi");
  await assert.rejects(app.run("addSongApiMarket('/search?q=test')"), /quota/);
  assert.equal(calls, 1);
});

test("rate limits use Retry-After and bounded retries", async t => {
  const app = createApp();
  t.after(app.close);
  let calls = 0;
  const delays = [];
  app.window.setTimeout = (callback, ms) => { delays.push(ms); return setTimeout(callback, 0); };
  app.window.testApi = async () => {
    calls++;
    if (calls === 1) {
      const error = new Error("Synthetic rate limit");
      error.status = 429;
      error.retryAfterMs = 2300;
      throw error;
    }
    return { items: [] };
  };
  app.run("api = window.testApi");
  await app.run("addSongApi('/search?q=test')");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2300]);
});
