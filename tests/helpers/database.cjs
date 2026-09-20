const fs = require("node:fs");
const path = require("node:path");
const { createApp, root } = require("./app.cjs");
const initSqlJs = require(path.join(root, "docs", "vendor", "sql-wasm.js"));

const ids = {
  firstGroup: "00000000-0000-4000-8000-000000000001",
  secondGroup: "00000000-0000-4000-8000-000000000002",
  firstPlayback: "00000000-0000-4000-8000-000000000010",
  secondPlayback: "00000000-0000-4000-8000-000000000011",
};
let sqlPromise;
function getSql() {
  sqlPromise ||= initSqlJs({ wasmBinary: fs.readFileSync(path.join(root, "docs", "vendor", "sql-wasm.wasm")) });
  return sqlPromise;
}

function fixture(SQL, title = "Synthetic track") {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE PlaybackGroup (
      playbackGroupUUIDRaw TEXT PRIMARY KEY, groupName TEXT, orderIndex REAL,
      isVisibleRaw INTEGER, isGoProGroupRaw INTEGER, hotKey TEXT,
      createdTimestamp1970 REAL, updatedTimestamp1970 REAL
    );
    CREATE TABLE Playback (
      playbackUUIDRaw TEXT PRIMARY KEY, playbackGroupUUIDRaw TEXT, sourceUUIDRaw TEXT,
      orderIndex REAL, displayTitle TEXT, altTitle TEXT, volume REAL, loopCount INTEGER,
      willPlayOverRaw INTEGER, willPlayNextSoundRaw INTEGER,
      startAtSeconds REAL, startAtSubSec REAL, stopAtSeconds REAL, stopAtSubSec REAL,
      fadeInSeconds REAL, fadeOutSeconds REAL, hasBeenPlayedRaw INTEGER,
      songCellColorRaw INTEGER, hotKey TEXT,
      createdTimestamp1970 REAL, updatedTimestamp1970 REAL
    );
    CREATE TABLE Sound (
      soundUUIDRaw TEXT PRIMARY KEY, soundTypeRaw INTEGER, title TEXT, artist TEXT,
      albumTitle TEXT, playbackDuration REAL, fileTypeRaw TEXT, fileURLPath TEXT,
      persistentID INTEGER, playbackStoreID TEXT, trackID TEXT, localTrackURI TEXT,
      createdTimestamp1970 REAL, updatedTimestamp1970 REAL, persistentIDRaw TEXT
    );
    CREATE TABLE AppSettings (
      volume REAL, fadeInSec REAL, fadeOutSec REAL, singleTapStartRaw TEXT
    );
    INSERT INTO AppSettings VALUES (0.7, 0, 2, 'Start');
  `);
  for (let index = 0; index < 2; index++) {
    const group = index ? ids.secondGroup : ids.firstGroup;
    const playback = index ? ids.secondPlayback : ids.firstPlayback;
    const sound = `00000000-0000-4000-8000-00000000002${index}`;
    db.run("INSERT INTO PlaybackGroup VALUES (?,?,?,?,?,?,?,?)", [group, `Synthetic tab ${index}`, index, 1, 0, "", 0, 0]);
    db.run("INSERT INTO Sound VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [sound, 2, title, "Synthetic artist", "Synthetic album", 123.456, "public.audio", "file:///", 0, "", `synthetic-track-${index}`, "", 0, 0, "0"]);
    db.run("INSERT INTO Playback VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [playback, group, sound, 0, title, "", -1, 0, 0, 0, 0, 0, 123, 0.456, -1, -1, 0, -1, "", 0, 0]);
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

function lineupFixture(SQL, count = 5) {
  const db = new SQL.Database(fixture(SQL));
  try {
    const playback = db.exec(`SELECT * FROM Playback WHERE playbackUUIDRaw='${ids.firstPlayback}'`)[0];
    const sound = db.exec("SELECT * FROM Sound WHERE trackID='synthetic-track-0'")[0];
    const originalPlayback = Object.fromEntries(playback.columns.map((key, i) => [key, playback.values[0][i]]));
    const originalSound = Object.fromEntries(sound.columns.map((key, i) => [key, sound.values[0][i]]));
    db.run("UPDATE Playback SET displayTitle=? WHERE playbackUUIDRaw=?", ["Synthetic player 1", ids.firstPlayback]);
    for (let index = 1; index < count; index++) {
      const source = { ...originalSound,
        soundUUIDRaw: `00000000-0000-4000-8000-${String(2000 + index).padStart(12, "0")}`,
        title: `Synthetic song ${index + 1}`, trackID: `synthetic-lineup-track-${index}`,
      };
      const row = { ...originalPlayback,
        playbackUUIDRaw: `00000000-0000-4000-8000-${String(1000 + index).padStart(12, "0")}`,
        sourceUUIDRaw: source.soundUUIDRaw, orderIndex: index, displayTitle: `Synthetic player ${index + 1}`,
      };
      db.run(`INSERT INTO Sound VALUES (${sound.columns.map(() => "?").join(",")})`, sound.columns.map(key => source[key]));
      db.run(`INSERT INTO Playback VALUES (${playback.columns.map(() => "?").join(",")})`, playback.columns.map(key => row[key]));
    }
    return db.export();
  } finally { db.close(); }
}

async function databaseApp(t, { load = true, indexedDB, origin } = {}) {
  const app = createApp({ origin });
  t.after(async () => {
    await app.run("databaseQueue");
    app.run("clearDatabaseState()");
    app.close();
  });
  const SQL = await getSql();
  app.SQL = SQL;
  app.downloads = [];
  app.window.testSQL = SQL;
  app.window.testDownload = bytes => app.downloads.push(new Uint8Array(bytes));
  if (indexedDB) app.window.indexedDB = indexedDB;
  app.run("SQL = window.testSQL; triggerDownload = window.testDownload");
  if (load) {
    app.window.fixture = fixture(SQL);
    await app.run("loadDbFromBytes(window.fixture)");
  }
  app.rows = sql => app.run(`queryAll(${JSON.stringify(sql)})`);
  return app;
}

function scalar(SQL, bytes, sql) {
  const db = new SQL.Database(bytes);
  try { return db.exec(sql)[0].values[0][0]; }
  finally { db.close(); }
}

module.exports = { ids, getSql, fixture, lineupFixture, databaseApp, scalar };
