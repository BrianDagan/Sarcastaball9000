const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { getSql, fixture, ids, databaseApp } = require("./helpers/database.cjs");

test("the installed pair and full runtime licenses match the reviewed bytes", () => {
  const expected = {
    "sql-wasm.js": "f1c84000dbc856c9d87f4f3aabc4d3654bd436165db4be3da13751db3a9c20d7",
    "sql-wasm.wasm": "2539b74ab967497223088846f66b3a017e841abc764c582559ed7fb3d2b062ec",
    "LICENSE.emscripten.txt": "620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86",
    "COPYRIGHT.musl.txt": "f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af",
    "LICENSE.compiler-rt.txt": "1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d",
    "LICENSE.libcxx.txt": "539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b",
    "LICENSE.libcxxabi.txt": "e2b35be49f7284a45b7baca8fc7b3ab7440e7902392b2528a457816b5bb2a15c",
  };
  for (const [name, digest] of Object.entries(expected)) {
    const bytes = fs.readFileSync(path.resolve(__dirname, "..", "docs", "vendor", name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, name);
  }
});

test("the shipped runtime contains the reviewed patched SQLite source and expected features", async () => {
  const SQL = await getSql();
  const database = new SQL.Database();
  try {
    const identity = database.exec("SELECT sqlite_version(), sqlite_source_id()")[0].values[0];
    assert.equal(identity[0], "3.53.4");
    assert.equal(identity[1], "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc");
    const options = database.exec("PRAGMA compile_options")[0].values.map(row => row[0]);
    assert.ok(options.includes("ENABLE_FTS3"));
    assert.ok(options.includes("ENABLE_NORMALIZE"));
    assert.ok(options.includes("OMIT_LOAD_EXTENSION"));
    assert.ok(options.includes("THREADSAFE=0"));
    assert.ok(!options.includes("ENABLE_FTS5"));
    assert.equal(database.exec("SELECT concat_ws('-', 'one', 'two', 'three')")[0].values[0][0], "one-two-three");
    database.run("CREATE VIRTUAL TABLE synthetic_search USING fts3(value)");
    database.run("INSERT INTO synthetic_search VALUES (?)", ["synthetic search text"]);
    assert.equal(database.exec("SELECT COUNT(*) FROM synthetic_search WHERE synthetic_search MATCH 'synthetic'")[0].values[0][0], 1);
  } finally { database.close(); }
});

test("runtime exports retain numeric values, storage classes, blobs and unknown native fields", async () => {
  const SQL = await getSql();
  let database = new SQL.Database();
  const precise = 1.0000000000000002;
  const timestamp = 1700000000.1234562;
  try {
    database.run("CREATE TABLE native_values (precise REAL, timestamp_value REAL, label TEXT, opaque BLOB, ordinal INTEGER, missing TEXT)");
    database.run("INSERT INTO native_values VALUES (?,?,?,?,?,?)", [
      precise, timestamp, "Synthetic native metadata", new Uint8Array([0, 1, 127, 255]), 2147483648, null,
    ]);
    for (let roundTrip = 0; roundTrip < 3; roundTrip++) {
      const bytes = database.export();
      database.close();
      database = new SQL.Database(bytes);
      const row = database.exec("SELECT precise, timestamp_value, label, opaque, ordinal, missing, typeof(precise), typeof(ordinal), typeof(opaque) FROM native_values")[0].values[0];
      assert.equal(row[0], precise);
      assert.equal(row[1], timestamp);
      assert.equal(row[2], "Synthetic native metadata");
      assert.deepEqual([...row[3]], [0, 1, 127, 255]);
      assert.equal(row[4], 2147483648);
      assert.equal(row[5], null);
      assert.deepEqual(row.slice(6), ["real", "integer", "blob"]);
    }
  } finally { database.close(); }
});

test("application import and pending export preserve extra schema and fractional cues", async t => {
  const app = await databaseApp(t, { load: false });
  const native = new app.SQL.Database(fixture(app.SQL));
  try {
    native.run(`
      ALTER TABLE Sound ADD COLUMN native_extra TEXT;
      ALTER TABLE Sound ADD COLUMN native_upper TEXT GENERATED ALWAYS AS (upper(title)) VIRTUAL;
      UPDATE Sound SET native_extra='Synthetic preserved value';
      CREATE TABLE native_audit (entry TEXT);
      CREATE TRIGGER native_color_audit AFTER UPDATE OF songCellColorRaw ON Playback
        BEGIN INSERT INTO native_audit VALUES ('color changed'); END;
      CREATE VIEW native_names AS SELECT playbackUUIDRaw, displayTitle FROM Playback;
      CREATE INDEX native_title_index ON Playback(lower(displayTitle));
    `);
    app.window.nativeBytes = native.export();
  } finally { native.close(); }
  await app.run("loadDbFromBytes(window.nativeBytes)");
  app.run(`setCellColor('${ids.firstPlayback}', 2)`);
  const exported = await app.run("exportWorkingDatabase()");
  const restored = new app.SQL.Database(exported);
  try {
    const row = restored.exec("SELECT native_extra, native_upper, playbackDuration FROM Sound LIMIT 1")[0].values[0];
    assert.deepEqual(row, ["Synthetic preserved value", "SYNTHETIC TRACK", 123.456]);
    const cue = restored.exec(`SELECT stopAtSeconds, stopAtSubSec, volume FROM Playback WHERE playbackUUIDRaw='${ids.firstPlayback}'`)[0].values[0];
    assert.equal(Math.round((cue[0] + cue[1]) * 1000), 123456);
    assert.equal(cue[2], -1);
    assert.equal(restored.exec("SELECT COUNT(*) FROM native_audit")[0].values[0][0], 1);
    assert.equal(restored.exec("SELECT COUNT(*) FROM native_names")[0].values[0][0], 2);
    assert.equal(restored.exec("SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('native_color_audit','native_names','native_title_index')")[0].values[0][0], 3);
  } finally { restored.close(); }
});
