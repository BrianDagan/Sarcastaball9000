/*
 * Sarcastaball 9000 (S9000) — main web app
 * ----------------------------------------
 * This file is the entire "brain" of the Sarcastaball 9000 web app. It runs
 * inside the browser; there is no server-side code. In plain terms it:
 *   1. Loads a SQLite database file (in the format produced by a compatible iOS
 *      app) and shows its tabs of song "buttons" as a grid.
 *   2. Talks to Spotify over the internet to actually play a chosen song on a
 *      chosen device when you tap a button.
 *   3. Lets you tweak things (colours, start times, deletions, moves) and save
 *      those changes back out to a fresh database file.
 *
 * New here? Jump to the very bottom of this file, to the block that starts with
 * `window.addEventListener("DOMContentLoaded", ...)`. That is the "run this when
 * the page opens" section, and it wires everything together.
 *
 * Security & privacy (what a reviewer should know):
 *   - There is NO backend. This file, index.html, styles.css and the bundled
 *     sql.js library in vendor/ are the whole app; nothing else is loaded.
 *   - Runtime requests use same-origin assets and Spotify's authorization/API
 *     hosts. There are no analytics or tracker integrations.
 *   - Login uses Spotify's Authorization Code + PKCE flow. There is no client
 *     secret. Your Spotify refresh token is kept only in this browser's
 *     localStorage and is sent only to Spotify's token endpoint.
 *   - Your song database never leaves your device: you load it from a local
 *     file and download your edits back as a new file. It is cached only in
 *     this browser (IndexedDB) for convenience.
 *   - Database/API text is rendered with textContent / DOM nodes; innerHTML is
 *     reserved for constant markup. Variable SQL values use bound parameters.
 */
"use strict";

// ----- Clickjacking guard -----
// A meta-tag CSP can't set `frame-ancestors`, so if this page is ever loaded
// inside an <iframe> (e.g. a malicious site trying UI-redress/clickjacking),
// break out to the top window; if that's blocked cross-origin, hide the UI so
// nothing can be clicked through.
if (window.top !== window.self) {
  try { window.top.location = window.self.location.href; }
  catch { document.documentElement.style.display = "none"; }
}

// ----- Constants -----
// Spotify's web addresses for (a) getting a fresh access token and
// (b) sending playback commands.
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const API = "https://api.spotify.com/v1";

// Scopes the app needs: read the user's playlists, and read/control playback.
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-modify-playback-state",
  "user-read-playback-state",
  "user-read-currently-playing",
].join(" ");

// The "LS_" values are the names of slots in the browser's localStorage — a
// tiny key/value store that survives page reloads. Each slot remembers one
// setting between visits. The "s9000." prefix just keeps our slots from
// colliding with any other web app served from the same address.
const LS_AUTH = "s9000.auth";        // saved Spotify login: {clientId, refreshToken}
const LS_PKCE = "s9000.pkce";        // transient login binding + verifier; sessionStorage only
const LS_ERASE = "s9000.erase";
const LS_LOGIN_PREFIX = "s9000.login.";
const AUTH_LOCK_NAME = "s9000.auth-lifecycle";
const LOGIN_VERSION = 1;
const LOGIN_TTL_MS = 10 * 60 * 1000; // Only unfinished login attempts expire; saved sign-ins do not.
const LS_DEVICE = "s9000.deviceId";  // which Spotify device we last controlled
const LS_DEVICE_NAME = "s9000.deviceName";  // friendly name of that device, for the pill
const LS_TAB = "s9000.activeTab";    // which tab was open last time
const LS_VOLUME = "s9000.volume";    // default playback volume (0-100)
const LS_FADE_IN = "s9000.fadeInSec";   // default fade-in duration in seconds
const LS_FADE_OUT = "s9000.fadeOutSec"; // default fade-out duration in seconds (also used at a song's end cue)
const LS_PENDING = "s9000.pending";  // unsaved edits: {colors: {pbUUID: color}, deletes: [pbUUID]}
const LS_TRACK_PLAYED = "s9000.trackPlayed";  // "1"/"0": whether playing a song marks it as played
const LS_IPAD_KEEPALIVE = "s9000.ipadKeepAlive";

// IndexedDB is a larger browser storage area. We use it to stash a copy of the
// loaded SQLite database so you don't have to re-pick the file on every visit.
// IDB_NAME is the database's name, IDB_STORE is the "table" inside it, and
// IDB_KEY is the row we keep the database bytes under.
const IDB_NAME = "s9000";
const IDB_STORE = "files";
const IDB_KEY = "db";

// ----- State -----
let SQL = null;            // sql.js module
let db = null;             // sql.js Database
let groups = [];           // [{uuid,name,...}]
let activeTabIdx = 0;
let accessToken = null;
let accessTokenExpiresAt = 0;
let activeDeviceId = null;
let activeDeviceCapabilities = null;
let appSettings = null;
// Global "Track Played" switch. When on, starting a song marks it as played
// (which grays the tile out). Loaded from localStorage at boot; defaults to on.
let trackPlayedOn = true;
let nowPlaying = null;     // {playbackUUID, ...}
let wakeLock = null;       // Screen Wake Lock sentinel (keeps the display awake during a game)
let fadeTimer = null;
// Bumped whenever a fade is cancelled/superseded so any volume PUT still in
// flight when that happens knows not to schedule the next step.
let fadeGen = 0;
let progress = null;       // {startOffsetMs, durationMs, baseTime, elapsedAtPause, paused}
let progressRaf = null;
// The colour palette. Each entry maps a raw number stored in the database's
// songCellColorRaw column to a human-friendly colour name. (These match the
// source database format's fixed 11-colour palette.)
const S9000_COLORS = [
  { raw: 0,  name: "Red" },
  { raw: 1,  name: "Orange" },
  { raw: 2,  name: "Gold" },
  { raw: 3,  name: "Green" },
  { raw: 4,  name: "Light Blue" },
  { raw: 5,  name: "Medium Blue" },
  { raw: 6,  name: "Dark Blue" },
  { raw: 7,  name: "Purple" },
  { raw: 8,  name: "Violet" },
  { raw: 9,  name: "Pink" },
  { raw: 10, name: "Gray" },
];
// Number-key shortcut order: 0 = app default, 1..9 = these 9 colors (Light Blue + Dark Blue dropped).
const KEYBOARD_COLOR_RAWS = [0, 1, 2, 3, 5, 7, 8, 9, 10];
const LS_DEFAULT_COLOR = "s9000.defaultColor";  // colour to use for cells set to "app default" (-1)
const DEFAULT_COLOR_FALLBACK = 10;             // Gray (red is annoying)

function getDefaultColor() {
  const v = localStorage.getItem(LS_DEFAULT_COLOR);
  const n = v === null ? DEFAULT_COLOR_FALLBACK : parseInt(v, 10);
  return Number.isFinite(n) ? n : DEFAULT_COLOR_FALLBACK;
}
function setDefaultColor(raw) {
  localStorage.setItem(LS_DEFAULT_COLOR, String(raw));
  applyDefaultColor();
}
function applyDefaultColor() {
  const raw = getDefaultColor();
  const cssVar = getComputedStyle(document.documentElement).getPropertyValue(`--c${raw}`).trim();
  if (cssVar) document.documentElement.style.setProperty("--c-default", cssVar);
}

let pending = { colors: {}, deletes: [], moves: {}, starts: {}, stops: {}, volumes: {}, hotkeys: {}, tabOps: 0, backedUp: false };
let databaseEpoch = 0;
let databaseIdentity = null;
let databaseInstalledAt = 0;
let workingRevision = 0;
let cacheVersion = null;
let databaseQueue = Promise.resolve();
let databaseImporting = false;
let importSequence = 0;
let saveInProgress = false;
let baselineBytes = null;
let baselineActive = false;
let legacyPending = null;
const databaseConnections = new Set();
const databaseWrites = new Set();

function emptyPending() {
  return { colors: {}, deletes: [], moves: {}, starts: {}, stops: {}, volumes: {}, hotkeys: {}, tabOps: 0, backedUp: false };
}

function reportDatabaseError(message) {
  const status = document.getElementById("db-status");
  status.textContent = message;
  status.className = "status err";
  showToast(message);
}

function getWorkingDatabaseRevision() { return `${databaseIdentity}:${workingRevision}`; }

function queueDatabaseTask(operation, epoch = databaseEpoch) {
  const task = databaseQueue.then(() => {
    if (epoch !== databaseEpoch || browserCleanupActive()) throw new Error("Database operation canceled.");
    return operation();
  });
  databaseQueue = task.then(() => {}, () => {});
  return task;
}

async function invalidateDatabaseWork() {
  databaseEpoch++;
  importSequence++;
  for (const tx of databaseWrites) {
    try { tx.abort(); } catch (error) {
      if (error.name !== "InvalidStateError") throw error;
    }
  }
  for (const connection of databaseConnections) connection.close();
  await databaseQueue;
}

function clearDatabaseState() {
  if (db) db.close();
  db = null;
  groups = [];
  appSettings = null;
  activeTabIdx = 0;
  pending = emptyPending();
  legacyPending = baselineBytes = databaseIdentity = cacheVersion = null;
  databaseInstalledAt = 0;
  baselineActive = false;
  databaseImporting = saveInProgress = false;
  focusedCell = null;
  contextMenuReturnFocus = null;
  workingRevision++;
}

function pickDatabaseFile() {
  const input = document.getElementById("in-db-file");
  input.value = "";
  input.click();
}

async function handleDatabaseFile(file) {
  if (!file) return false;
  const sequence = ++importSequence;
  const epoch = databaseEpoch;
  try {
    const bytes = await file.arrayBuffer();
    if (sequence !== importSequence || epoch !== databaseEpoch || erasingBrowser) return false;
    return await loadDbFromBytes(bytes, sequence);
  } catch (error) {
    if (epoch === databaseEpoch && !erasingBrowser) reportDatabaseError(`Import did not complete. ${error.message}`);
    return false;
  }
}
let focusedCell = null;    // currently keyboard-focused cell DOM element
let barFocused = null;     // 'dot' | 'caret' | null — which bar marker has keyboard focus
let dragTarget = null;     // 'dot' | 'caret' | null — which bar marker is currently being dragged

// --- Fine cue-nudge slider state (see "Fine cue-nudge slider" section below) ---
let cueFineBaseMs = 0;      // the absolute cue point (ms) that the slider's centre (0) maps to
let cueFineHideTimer = null;// handle for the slider's "auto-hide after a few idle seconds" timer
let cueFineGen = 0;         // bumped every time the playing track changes, so a late slider action can tell it's now stale
let cueFineMode = "start";  // which cue the fine slider is editing: "start" or "stop"
let cueFineLastSeek = null; // last "mode:target" we actually seeked to, so the input+change pair doesn't re-seek the same spot twice

// ----- Tap actions (from AppSettings.singleTapStartRaw etc.) -----
// Possible values per the DB sample: "Start", "Stop", "Pause", "Fade In", "Fade Out", "Open Group", "No Action"
const TAP_ACTIONS = {
  "Start": startPlayback,
  "Stop": stopPlayback,
  "Pause": pausePlayback,
  "Fade In": fadeIn,
  "Fade Out": fadeOut,
  "Open Group": () => {},   // unused for now (only on triple-tap of group? n/a)
  "No Action": () => {},
};

// =====================================================================
// IndexedDB helpers (cache the DB binary so we don't re-pick every load)
// =====================================================================
function idbOpen() {
  const epoch = databaseEpoch;
  return new Promise((res, rej) => {
    if (browserCleanupActive()) { rej(new Error("Browser cleanup is in progress.")); return; }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (epoch !== databaseEpoch || browserCleanupActive()) { req.transaction.abort(); return; }
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => {
      const connection = req.result;
      if (epoch !== databaseEpoch || browserCleanupActive()) {
        connection.close();
        rej(new Error("Database operation canceled."));
        return;
      }
      databaseConnections.add(connection);
      connection.onversionchange = () => connection.close();
      res(connection);
    };
    req.onerror = () => rej(req.error);
    req.onblocked = () => reportDatabaseError("Database access is blocked. Close older DJDad tabs and retry.");
  });
}
async function idbPut(key, val, expectedVersion) {
  const epoch = databaseEpoch;
  const conn = await idbOpen();
  return new Promise((res, rej) => {
    const tx = conn.transaction(IDB_STORE, "readwrite");
    databaseWrites.add(tx);
    let conflict = false;
    const close = () => { databaseWrites.delete(tx); databaseConnections.delete(conn); conn.close(); };
    tx.oncomplete = () => { close(); res(); };
    tx.onabort = tx.onerror = () => {
      close();
      rej(new Error(conflict ? "Another tab changed recovery data. Export this tab's work before reloading." : "Recovery could not be saved. Keep this tab open and export your work."));
    };
    const store = tx.objectStore(IDB_STORE);
    const request = store.get(key);
    request.onsuccess = () => {
      if (epoch !== databaseEpoch || browserCleanupActive()) { tx.abort(); return; }
      if (expectedVersion !== undefined && (request.result?.version ?? null) !== expectedVersion) {
        conflict = true; tx.abort(); return;
      }
      store.put(val, key);
    };
  });
}
async function idbGet(key) {
  const conn = await idbOpen();
  return new Promise((res, rej) => {
    const tx = conn.transaction(IDB_STORE, "readonly");
    const r = tx.objectStore(IDB_STORE).get(key);
    let result = null;
    r.onsuccess = () => { result = r.result || null; };
    const close = () => { databaseConnections.delete(conn); conn.close(); };
    tx.oncomplete = () => { close(); res(result); };
    tx.onabort = tx.onerror = () => { close(); rej(new Error("Recovery could not be read. Your cached data was not erased.")); };
  });
}

// =====================================================================
// SQLite (sql.js) load
// =====================================================================
async function initSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs({ locateFile: f => `vendor/${f}` });
  return SQL;
}

const DATABASE_COLUMNS = {
  PlaybackGroup: ["playbackGroupUUIDRaw", "groupName", "orderIndex", "isVisibleRaw", "isGoProGroupRaw", "hotKey", "createdTimestamp1970", "updatedTimestamp1970"],
  Playback: ["playbackUUIDRaw", "playbackGroupUUIDRaw", "sourceUUIDRaw", "orderIndex", "displayTitle", "altTitle", "volume", "loopCount", "willPlayOverRaw", "willPlayNextSoundRaw", "startAtSeconds", "startAtSubSec", "stopAtSeconds", "stopAtSubSec", "fadeInSeconds", "fadeOutSeconds", "hasBeenPlayedRaw", "songCellColorRaw", "hotKey", "createdTimestamp1970", "updatedTimestamp1970"],
  Sound: ["soundUUIDRaw", "soundTypeRaw", "title", "artist", "albumTitle", "playbackDuration", "fileTypeRaw", "fileURLPath", "persistentID", "playbackStoreID", "trackID", "localTrackURI", "createdTimestamp1970", "updatedTimestamp1970", "persistentIDRaw"],
  AppSettings: [],
};

function queryDatabase(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally { statement.free(); }
}

function validateDatabase(database) {
  const check = database.exec("PRAGMA quick_check");
  if (check[0]?.values[0]?.[0] !== "ok") throw new Error("The selected SQLite database failed its integrity check.");
  for (const [table, fields] of Object.entries(DATABASE_COLUMNS)) {
    if (!queryDatabase(database, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]).length) {
      throw new Error(`This database is not compatible: required table ${table} is missing.`);
    }
    const columns = new Set(queryDatabase(database, `PRAGMA table_info("${table}")`).map(column => column.name));
    if (fields.some(field => !columns.has(field))) throw new Error(`This database is not compatible: ${table} columns are missing.`);
  }
}

async function openDatabaseCandidate(bytes) {
  await initSql();
  let candidate;
  try {
    candidate = new SQL.Database(new Uint8Array(bytes));
    validateDatabase(candidate);
    return candidate;
  } catch (error) {
    candidate?.close();
    throw new Error("The selected file is corrupt or has an incompatible database schema. Existing data was not replaced.");
  }
}

function normalizePending(value) {
  const result = emptyPending();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved edits are invalid; the original recovery data has been preserved.");
  for (const field of ["colors", "moves", "starts", "stops", "volumes", "hotkeys"]) {
    const map = value[field] ?? {};
    if (typeof map !== "object" || Array.isArray(map)) throw new Error("Saved edit maps are invalid.");
    for (const [key, item] of Object.entries(map)) {
      const valid = key.length > 0 && (
        (field === "colors" && Number.isInteger(item)) ||
        (field === "moves" && typeof item === "string" && item.length > 0) ||
        (["starts", "stops"].includes(field) && Number.isFinite(item) && item >= 0) ||
        (field === "volumes" && Number.isFinite(item) && (item === -1 || (item >= 0 && item <= 1))) ||
        (field === "hotkeys" && typeof item === "string" && /^[a-z]?$/i.test(item))
      );
      if (!valid) throw new Error("Saved edit values are invalid; recovery data has been preserved.");
    }
    result[field] = Object.fromEntries(Object.entries(map));
  }
  const deletes = value.deletes ?? [];
  if (!Array.isArray(deletes) || deletes.some(key => typeof key !== "string" || !key.length)) throw new Error("Saved deletions are invalid.");
  result.deletes = [...deletes];
  result.tabOps = value.tabOps ?? 0;
  if (!Number.isSafeInteger(result.tabOps) || result.tabOps < 0) throw new Error("Saved edit count is invalid.");
  result.backedUp = !!value.backedUp;
  return result;
}

function recoveryRecord(bytes = db.export(), edits = pending, identity = databaseIdentity, baseline = baselineBytes, active = baselineActive) {
  return {
    format: 1, version: crypto.randomUUID(), identity,
    bytes: new Uint8Array(bytes), pending: structuredClone(edits),
    baseline: baseline ? new Uint8Array(baseline) : null,
    baselineActive: active,
  };
}

function persistRecoveryRecord(record, epoch = databaseEpoch) {
  return queueDatabaseTask(async () => {
    await idbPut(IDB_KEY, record, cacheVersion);
    if (epoch !== databaseEpoch) throw new Error("Database operation canceled.");
    cacheVersion = record.version;
  }, epoch);
}

function installDatabase(candidate, identity, edits, baseline, active = false) {
  invalidateTransportWork();
  invalidateSearchWork();
  hideCellContextMenu();
  db?.close();
  db = candidate;
  databaseIdentity = identity;
  databaseInstalledAt = Date.now();
  pending = edits;
  baselineBytes = baseline ? new Uint8Array(baseline) : null;
  baselineActive = active;
  workingRevision++;
  refreshGroupsFromDB();
  appSettings = queryAll("SELECT * FROM AppSettings LIMIT 1")[0] || {};
  const savedTab = parseInt(localStorage.getItem(LS_TAB) || "0", 10);
  activeTabIdx = (savedTab >= 0 && savedTab < groups.length) ? savedTab : 0;
  renderTabs();
  renderGrid();
  updateSaveBadge();
  document.getElementById("empty-state").classList.add("hidden");
  document.getElementById("db-status").textContent =
    `Loaded: ${groups.length} tabs, ${queryAll("SELECT COUNT(*) c FROM Playback")[0].c} buttons`;
  document.getElementById("db-status").className = "status ok";
  requestWakeLock();
  idleBlocked = false;
  scheduleIdleCheck();
}

async function loadDbFromBytes(bytes, requestSequence = ++importSequence) {
  const epoch = databaseEpoch;
  if (erasingBrowser || saveInProgress) throw new Error("Wait for the current save or cleanup before importing.");
  databaseImporting = true;
  let candidate;
  try {
    candidate = await openDatabaseCandidate(bytes);
    if (epoch !== databaseEpoch || requestSequence !== importSequence) throw new Error("Database import was superseded.");
    if ((pendingCount() > 0 || localStorage.getItem(LS_PENDING)) &&
        !confirm("Replace the browser's current database and unsaved edits with this validated file? Export your work first if you need to keep it.")) return false;
    const identity = crypto.randomUUID();
    const record = recoveryRecord(candidate.export(), emptyPending(), identity, null, false);
    await persistRecoveryRecord(record, epoch);
    if (epoch !== databaseEpoch || browserCleanupActive()) throw new Error("Database import was superseded.");
    installDatabase(candidate, identity, emptyPending(), null);
    candidate = null;
    localStorage.removeItem(LS_PENDING);
    legacyPending = null;
    return true;
  } finally {
    candidate?.close();
    if (requestSequence === importSequence) {
      databaseImporting = false;
      scheduleIdleCheck();
    }
  }
}

async function restoreCachedDatabase() {
  const epoch = databaseEpoch;
  const sequence = importSequence;
  const cached = await idbGet(IDB_KEY);
  if (epoch !== databaseEpoch || sequence !== importSequence || erasingBrowser) return;
  if (!cached) {
    document.getElementById("empty-state").classList.remove("hidden");
    if (legacyPending) reportDatabaseError("Saved edits have no associated cached database. They were preserved; do not replace them without exporting your original work.");
    return;
  }
  const modern = cached.format === 1;
  const candidate = await openDatabaseCandidate(modern ? cached.bytes : cached);
  try {
    if (epoch !== databaseEpoch || sequence !== importSequence || browserCleanupActive()) return;
    const edits = normalizePending(modern ? cached.pending : (legacyPending || emptyPending()));
    const identity = modern ? cached.identity : crypto.randomUUID();
    if (typeof identity !== "string") throw new Error("The recovery database identity is invalid.");
    if (modern && typeof cached.version !== "string") throw new Error("The recovery version is invalid.");
    cacheVersion = modern ? cached.version : null;
    installDatabase(candidate, identity, edits, modern ? cached.baseline : null, modern && !!cached.baselineActive);
    if (!modern) {
      await persistRecoveryRecord(recoveryRecord(), epoch);
      if (epoch === databaseEpoch) { localStorage.removeItem(LS_PENDING); legacyPending = null; }
    }
  } finally { if (candidate !== db) candidate.close(); }
}

function prepareDatabaseEdit() {
  if (!db || browserCleanupActive() || databaseImporting) {
    showToast("Wait until a database is loaded and any import or cleanup has finished.");
    return false;
  }
  if (!baselineActive) {
    baselineBytes = new Uint8Array(db.export());
    baselineActive = true;
    try {
      triggerDownload(baselineBytes, "DJDad-pre-edit.sqlite.backup");
      pending.backedUp = true;
    } catch {
      reportDatabaseError("The backup download could not be started. The pre-edit snapshot is retained in browser recovery; export it before relying on it.");
    }
  }
  return true;
}

function mutateDatabase(operation) {
  if (!prepareDatabaseEdit()) return false;
  db.run("BEGIN");
  try { operation(); db.run("COMMIT"); return true; }
  catch {
    db.run("ROLLBACK");
    reportDatabaseError("The database change failed and was rolled back. Your previous data is retained.");
    return false;
  }
}

// =====================================================================
// Screen Wake Lock
// While a song database is loaded we ask the browser to keep the display
// awake (so an operator standing at the field doesn't have the laptop dim or
// the phone lock between songs). This uses the standard Screen Wake Lock API
// and silently does nothing on browsers that don't support it. The lock is
// automatically released by the browser when the tab is hidden, so we also
// re-acquire it whenever the tab becomes visible again.
// =====================================================================
let requestingWakeLock = false;
async function requestWakeLock() {
  if (!("wakeLock" in navigator) || !db || erasingBrowser || wakeLock ||
      requestingWakeLock || document.visibilityState !== "visible") return;
  const epoch = databaseEpoch;
  requestingWakeLock = true;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    if (epoch !== databaseEpoch || !db || erasingBrowser || document.visibilityState !== "visible") {
      await sentinel.release();
      return;
    }
    wakeLock = sentinel;
    // If the OS drops THIS lock (e.g. tab hidden), forget it — but only if it's
    // still the current one, so a newer lock isn't cleared by an old release.
    sentinel.addEventListener("release", () => {
      if (wakeLock === sentinel) wakeLock = null;
    });
  } catch {
    wakeLock = null;
    if (epoch === databaseEpoch && db && !erasingBrowser) showToast("Screen wake lock unavailable; the display may sleep.");
  } finally { requestingWakeLock = false; }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && db && !wakeLock) {
    requestWakeLock();
  }
});

function queryAll(sql, params = []) {
  if (!db) return [];
  return queryDatabase(db, sql, params);
}

// =====================================================================
// Render
// =====================================================================
function renderTabs() {
  const tabs = document.getElementById("tabs");
  tabs.innerHTML = "";
  groups.forEach((g, i) => {
    const b = document.createElement("button");
    b.className = "tab" + (i === activeTabIdx ? " active" : "");
    b.textContent = g.name;
    b.dataset.tabIdx = String(i);
    b.onclick = () => {
      activeTabIdx = i;
      localStorage.setItem(LS_TAB, String(i));
      renderTabs();
      renderGrid();
    };
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showTabContextMenu(i, e.clientX, e.clientY);
    });
    bindLongPress(b, (x, y) => showTabContextMenu(i, x, y));
    tabs.appendChild(b);
  });
  // + button to add a new tab
  const add = document.createElement("button");
  add.id = "btn-add-tab";
  add.className = "tab-add";
  add.title = "Add tab";
  add.textContent = "+";
  add.onclick = tabAdd;
  tabs.appendChild(add);
  // The set of tabs just changed, so recompute which scroll arrows/fades to show.
  // requestAnimationFrame waits until the browser has laid the new buttons out,
  // otherwise scrollWidth/clientWidth would still report the old sizes.
  requestAnimationFrame(updateTabOverflow);
}

// =====================================================================
// Tab strip overflow: scroll arrows, edge fade, and mouse drag-scroll
// =====================================================================
// True for a brief moment right after a drag finishes, so the click that the
// browser fires at the end of a drag doesn't get mistaken for a tab tap.
let tabsJustDragged = false;

// Show/hide the ‹ › arrows and fade the strip's edges depending on whether
// there are more tabs hidden to the left and/or right of the visible area.
function updateTabOverflow() {
  const tabs  = document.getElementById("tabs");
  const left  = document.getElementById("tab-scroll-left");
  const right = document.getElementById("tab-scroll-right");
  if (!tabs) return;
  const maxScroll   = tabs.scrollWidth - tabs.clientWidth;
  const overflowing = maxScroll > 1;                 // are some tabs off-screen?
  const atStart     = tabs.scrollLeft <= 1;          // nothing hidden to the left
  const atEnd       = tabs.scrollLeft >= maxScroll - 1; // nothing hidden to the right
  const fadeL = overflowing && !atStart;
  const fadeR = overflowing && !atEnd;
  if (left)  left.classList.toggle("hidden", !fadeL);
  if (right) right.classList.toggle("hidden", !fadeR);
  // Build a left-to-right mask: fully opaque (#000) in the middle, fading to
  // transparent at whichever edge still has more tabs beyond it.
  const lStop = fadeL ? "transparent 0, #000 28px" : "#000 0, #000 28px";
  const rStop = fadeR ? "#000 calc(100% - 28px), transparent 100%"
                      : "#000 calc(100% - 28px), #000 100%";
  const mask = `linear-gradient(to right, ${lStop}, ${rStop})`;
  tabs.style.webkitMaskImage = mask;
  tabs.style.maskImage = mask;
}

// Wire up the arrow buttons, drag-scrolling, and the listeners that keep the
// overflow state fresh. Called once at startup.
function setupTabScroller() {
  const tabs  = document.getElementById("tabs");
  const left  = document.getElementById("tab-scroll-left");
  const right = document.getElementById("tab-scroll-right");
  if (!tabs) return;
  if (left)  left.onclick  = () => tabs.scrollBy({ left: -tabs.clientWidth * 0.7, behavior: "smooth" });
  if (right) right.onclick = () => tabs.scrollBy({ left:  tabs.clientWidth * 0.7, behavior: "smooth" });
  tabs.addEventListener("scroll", updateTabOverflow, { passive: true });
  window.addEventListener("resize", updateTabOverflow);
  setupTabDragScroll(tabs);
  updateTabOverflow();
}

// Click-and-drag horizontal scrolling for MOUSE users. Touch devices already
// get native momentum scrolling from overflow-x:auto, and adding JS dragging
// there would fight with the long-press menu, so we only handle the mouse.
function setupTabDragScroll(tabs) {
  let down = false, moved = false, startX = 0, startScroll = 0, pid = null;
  tabs.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") return;
    tabsJustDragged = false;
    down = true; moved = false;
    startX = e.clientX; startScroll = tabs.scrollLeft; pid = e.pointerId;
  });
  tabs.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > 6) {
      moved = true;
      tabs.classList.add("dragging");
      try { tabs.setPointerCapture(pid); } catch (_) {}
    }
    if (moved) { tabs.scrollLeft = startScroll - dx; e.preventDefault(); }
  });
  const end = () => {
    if (down && moved) tabsJustDragged = true; // suppress the trailing click
    down = false; moved = false;
    tabs.classList.remove("dragging");
  };
  tabs.addEventListener("pointerup", end);
  tabs.addEventListener("pointercancel", end);
  // If a drag happened, swallow the click so we don't switch tabs by accident.
  tabs.addEventListener("click", (e) => {
    if (tabsJustDragged) { e.stopPropagation(); e.preventDefault(); tabsJustDragged = false; }
  }, true);
}

// =====================================================================
// Long-press detection (for touch/iOS) — fires after 500ms of stationary press
// =====================================================================
function bindLongPress(el, handler, { onStart, onCancel, suppressClick = false } = {}) {
  let timer = null;
  let pointerId = null;
  let fired = false;
  let releaseGuard = null;
  let startX = 0, startY = 0;
  const guardReleaseClick = id => {
    releaseGuard?.();
    let expiry = null;
    const clear = () => {
      clearTimeout(expiry);
      document.removeEventListener("click", swallow, true);
      document.removeEventListener("pointerdown", nextPress, true);
      document.removeEventListener("pointerup", released, true);
      document.removeEventListener("pointercancel", released, true);
      window.removeEventListener("pagehide", clear);
      if (releaseGuard === clear) releaseGuard = null;
    };
    const swallow = event => {
      if (event.detail === 0 && !event.pointerType) return;
      if (event.pointerId > 0 && event.pointerId !== id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clear();
    };
    const nextPress = event => { if (event.isPrimary !== false) clear(); };
    const released = event => {
      if (event.pointerId !== id) return;
      clearTimeout(expiry);
      expiry = setTimeout(clear, 1000);
    };
    releaseGuard = clear;
    // The menu can appear beneath the finger, so guard the document rather
    // than only the tile. A fresh pointerdown still permits the next real tap.
    document.addEventListener("click", swallow, true);
    document.addEventListener("pointerdown", nextPress, true);
    document.addEventListener("pointerup", released, true);
    document.addEventListener("pointercancel", released, true);
    window.addEventListener("pagehide", clear);
  };
  const finish = canceled => {
    if (pointerId === null) return;
    const id = pointerId;
    clearTimeout(timer);
    timer = null;
    pointerId = null;
    document.removeEventListener("pointermove", moved, true);
    document.removeEventListener("pointerup", ended, true);
    document.removeEventListener("pointercancel", ended, true);
    document.removeEventListener("pointerdown", additionalPointer, true);
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("blur", interrupted);
    window.removeEventListener("pagehide", interrupted);
    if (canceled) {
      if (suppressClick && !releaseGuard) guardReleaseClick(id);
      onCancel?.();
    }
  };
  const fire = () => {
    if (pointerId === null || fired) return;
    if (!el.isConnected || document.visibilityState === "hidden") { finish(true); return; }
    clearTimeout(timer);
    timer = null;
    fired = true;
    if (suppressClick) guardReleaseClick(pointerId);
    handler(startX, startY);
  };
  const moved = event => {
    if (event.pointerId !== pointerId) return;
    if (Math.abs(event.clientX - startX) > 8 || Math.abs(event.clientY - startY) > 8) finish(true);
  };
  const ended = event => {
    if (event.pointerId === pointerId) finish(event.type === "pointercancel");
  };
  const additionalPointer = event => {
    if (event.pointerType !== "mouse" && event.pointerId !== pointerId) finish(true);
  };
  const interrupted = () => finish(true);
  const visibilityChanged = () => { if (document.visibilityState === "hidden") finish(true); };
  el.addEventListener("pointerdown", e => {
    if (!["touch", "pen"].includes(e.pointerType) || e.button !== 0 || e.isPrimary === false) return;
    finish(true);
    pointerId = e.pointerId;
    fired = false;
    startX = e.clientX; startY = e.clientY;
    onStart?.();
    document.addEventListener("pointermove", moved, true);
    document.addEventListener("pointerup", ended, true);
    document.addEventListener("pointercancel", ended, true);
    document.addEventListener("pointerdown", additionalPointer, true);
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("blur", interrupted);
    window.addEventListener("pagehide", interrupted);
    timer = setTimeout(fire, 500);
  });
  el.addEventListener("pointerleave", event => {
    if (event.pointerId === pointerId && !fired) finish(true);
  });
  return {
    handleContextMenu() {
      if (pointerId === null && !releaseGuard) return false;
      fire();
      return true;
    },
  };
}

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  const g = groups[activeTabIdx];
  if (!g) return;
  const rows = queryAll(`
    SELECT
      p.playbackUUIDRaw    AS pbUUID,
      p.displayTitle       AS title,
      p.altTitle           AS alt,
      p.startAtSeconds     AS startSec,
      p.startAtSubSec      AS startSubSec,
      p.stopAtSeconds      AS stopSec,
      p.stopAtSubSec       AS stopSubSec,
      p.fadeInSeconds      AS fadeIn,
      p.fadeOutSeconds     AS fadeOut,
      p.volume             AS pbVolume,
      p.songCellColorRaw   AS color,
      p.hasBeenPlayedRaw   AS played,
      p.hotKey             AS hotKey,
      s.title              AS sTitle,
      s.artist             AS sArtist,
      s.trackID            AS trackID,
      s.playbackDuration   AS duration
    FROM Playback p
    LEFT JOIN Sound s ON s.soundUUIDRaw = p.sourceUUIDRaw
    WHERE p.playbackGroupUUIDRaw = ?
    ORDER BY p.orderIndex
  `, [g.uuid]);

  rows.forEach(r => {
    const cell = document.createElement("button");
    cell.className = "cell";
    cell.dataset.color = String(r.color);
    cell.dataset.pbuuid = r.pbUUID;
    cell.dataset.trackid = r.trackID || "";
    cell.dataset.startms = String(Math.round((r.startSec || 0) * 1000 + (r.startSubSec || 0) * 1000));
    cell.dataset.stopms  = String(Math.round((r.stopSec || 0) * 1000 + (r.stopSubSec || 0) * 1000));
    cell.dataset.fadein  = String(r.fadeIn ?? -1);
    cell.dataset.fadeout = String(r.fadeOut ?? -1);
    cell.dataset.volume  = String(r.pbVolume ?? -1);
    cell.dataset.duration = String(Math.round((r.duration || 0) * 1000));
    cell.dataset.hotkey  = (r.hotKey || "").toString().toUpperCase();

    const titleDiv = document.createElement("div");
    titleDiv.className = "title";
    titleDiv.textContent = r.title || r.sTitle || "(untitled)";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (r.sTitle && r.sArtist) ? `${r.sTitle} — ${r.sArtist}` : (r.sArtist || "");

    const start = document.createElement("div");
    start.className = "start";
    start.textContent = fmtTime(r.startSec || 0);

    // Small badge in the corner showing the assigned keyboard hotkey (if any).
    const hk = document.createElement("div");
    hk.className = "hotkey-badge";

    const dot = document.createElement("div");
    dot.className = "edited-dot";

    cell.appendChild(start);
    cell.appendChild(titleDiv);
    cell.appendChild(meta);
    cell.appendChild(hk);
    cell.appendChild(dot);

    applyPendingToCell(cell);
    // Gray out tiles that have already been played (flag set in the database).
    if (r.played) cell.classList.add("played");

    bindTaps(cell);
    grid.appendChild(cell);
  });

  // Restore or initialize keyboard focus on this tab's first cell
  const firstCell = grid.querySelector(".cell");
  if (firstCell) setFocusedCell(firstCell, false);
}

// =====================================================================
// Keyboard navigation
// =====================================================================
function setFocusedCell(cell, moveDomFocus = true) {
  if (focusedCell && focusedCell !== cell) focusedCell.classList.remove("focused");
  focusedCell = cell || null;
  if (focusedCell) {
    focusedCell.classList.add("focused");
    if (moveDomFocus) focusedCell.focus({ preventScroll: true });
    focusedCell.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    // moving grid focus drops bar focus so arrow keys go back to cell nav
    if (barFocused) {
      barFocused = null;
      document.getElementById("np-bar-dot")?.classList.remove("focused");
      document.getElementById("np-bar-caret")?.classList.remove("focused");
      document.getElementById("np-bar-stop")?.classList.remove("focused");
    }
  }
}

function getGridLayout() {
  const grid = document.getElementById("grid");
  const cells = Array.from(grid.querySelectorAll(".cell"));
  if (cells.length === 0) return null;
  const firstTop = cells[0].offsetTop;
  let cols = cells.findIndex(c => c.offsetTop > firstTop);
  if (cols === -1) cols = cells.length;
  return { cells, cols };
}

function moveFocus(dx, dy) {
  const layout = getGridLayout();
  if (!layout) return;
  const { cells, cols } = layout;
  let i = focusedCell ? cells.indexOf(focusedCell) : -1;
  if (i === -1) { setFocusedCell(cells[0]); return; }
  const r = Math.floor(i / cols), c = i % cols;
  let nr = r + dy, nc = c + dx;
  if (nc < 0) nc = 0;
  if (nc >= cols) nc = cols - 1;
  if (nr < 0) nr = 0;
  let target = nr * cols + nc;
  if (target >= cells.length) target = cells.length - 1;
  if (target < 0) target = 0;
  setFocusedCell(cells[target]);
}

function applyPendingToCell(cell) {
  const id = cell.dataset.pbuuid;
  let edited = false;
  if (pending.colors[id] !== undefined) {
    cell.dataset.color = String(pending.colors[id]);
    edited = true;
  }
  if (pending.starts[id] !== undefined) {
    cell.dataset.startms = String(pending.starts[id]);
    const startEl = cell.querySelector(".start");
    if (startEl) startEl.textContent = fmtTime(pending.starts[id] / 1000);
    edited = true;
  }
  if (pending.volumes[id] !== undefined) {
    cell.dataset.volume = String(pending.volumes[id]);
    edited = true;
  }
  if (pending.stops[id] !== undefined) {
    cell.dataset.stopms = String(pending.stops[id]);
    edited = true;
  }
  if (pending.hotkeys[id] !== undefined) {
    cell.dataset.hotkey = String(pending.hotkeys[id]).toUpperCase();
    edited = true;
  }
  // Reflect the current hotkey assignment in the corner badge.
  const hkEl = cell.querySelector(".hotkey-badge");
  if (hkEl) hkEl.textContent = cell.dataset.hotkey || "";
  cell.classList.toggle("pending-edit", edited);
  cell.classList.toggle("pending-delete", pending.deletes.includes(id));
  if (pending.moves[id]) {
    cell.classList.add("pending-move");
    const target = groups.find(g => g.uuid === pending.moves[id]);
    cell.dataset.movetarget = target ? target.name : "";
  } else {
    cell.classList.remove("pending-move");
    delete cell.dataset.movetarget;
  }
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// =====================================================================
// Tap handling — implements single/double/triple tap actions
// Single-tap rules (overrides AppSettings to match user's expectation):
//   - Tap currently-playing cell → pause/resume toggle (no seek)
//   - Tap different cell → stop current, start new from configured start
//   - Tap when nothing playing → start
// Double/triple tap fall back to AppSettings actions.
// =====================================================================
function bindTaps(cell) {
  let tapCount = 0;
  let timer = null;
  const clearTapSequence = () => {
    clearTimeout(timer);
    timer = null;
    tapCount = 0;
  };
  const openMenu = (x, y) => {
    clearTapSequence();
    setFocusedCell(cell);
    showCellContextMenu(cell, x, y);
    document.querySelector("#ctx-menu .ctx-item:not(:disabled)")?.focus({ preventScroll: true });
  };
  const touchMenu = bindLongPress(cell, openMenu, {
    // Defer an earlier tap while the next touch may become a hold, but retain
    // its count so ordinary double/triple taps still use their configured action.
    onStart: () => { clearTimeout(timer); timer = null; },
    onCancel: clearTapSequence,
    suppressClick: true,
  });
  cell.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!touchMenu.handleContextMenu()) openMenu(e.clientX, e.clientY);
  });
  const TAP_WINDOW = 280;
  cell.addEventListener("click", (e) => {
    e.preventDefault();
    cancelIdleCheck();
    setFocusedCell(cell);
    tapCount++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const n = tapCount;
      tapCount = 0;
      if (!cell.isConnected) return;
      if (n === 1) {
        smartSingleTap(cell);
      } else {
        const action = (
          n === 2 ? appSettings.doubleTapStartRaw :
                    appSettings.tripleTapStartRaw
        ) || "Start";
        const usePlayingMap = !!nowPlaying;
        const eff = usePlayingMap ? (
          n === 2 ? appSettings.doubleTapPlayingRaw :
                    appSettings.tripleTapPlayingRaw
        ) || action : action;
        const fn = TAP_ACTIONS[eff] || TAP_ACTIONS["Start"];
        Promise.resolve(fn(cell)).catch(handlePlaybackError);
      }
    }, TAP_WINDOW);
  });
}

async function smartSingleTap(cell) {
  try {
    if (nowPlaying && nowPlaying.uuid === cell.dataset.pbuuid) {
      // Same cell: toggle pause/resume
      if (nowPlaying.paused) {
        await resumePlayback();
      } else {
        await pausePlayback();
      }
    } else {
      // Different (or nothing) playing: stop & start new
      await startPlayback(cell);
    }
  } catch (e) {
    handlePlaybackError(e);
  }
}

// Turn a failed Spotify call into a friendly, recoverable experience instead of
// a silent dead button. The two things that actually go wrong at a live game are
// (1) the chosen device went to sleep / closed Spotify, and (2) the login token
// stopped working. For (1) we forget the dead device and pop the device picker
// so the operator can pick a live one; for (2) we open Settings to re-auth.
// Anything else just shows a brief banner with the message.
function handlePlaybackError(e) {
  const msg = (e && e.message) ? e.message : String(e);
  console.error("Playback error:", msg);
  const lower = msg.toLowerCase();
  // Only treat genuinely device-related failures as "device gone" — match the
  // wording Spotify uses ("No active device", "Device not found") rather than
  // every 404, which could be unrelated (e.g. a track/market issue).
  const deviceGone =
    lower.includes("no active") ||
    lower.includes("no_active_device") ||
    lower.includes("device not found") ||
    lower.includes("device");
  const authGone = lower.includes("spotify 401") || lower.includes("not authenticated") || lower.includes("refresh failed");

  if (authGone) {
    showToast("Spotify login expired — please reconnect.");
    showModal(true);
    return;
  }
  if (deviceGone) {
    // Forget the dead device so the next play re-resolves a live one.
    activeDeviceId = null;
    localStorage.removeItem(LS_DEVICE);
    localStorage.removeItem(LS_DEVICE_NAME);
    setDevicePill(null);
    showToast("That Spotify device isn't available — pick another.");
    openDevicePicker();
    return;
  }
  showToast("Couldn't play: " + msg);
}

// Brief, auto-dismissing banner for transient messages (errors, device changes).
let toastTimer = null;
function showToast(message) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}

// =====================================================================
// Spotify auth (Authorization Code + PKCE; no client secret)
// =====================================================================
function getAuth() {
  try {
    const value = JSON.parse(localStorage.getItem(LS_AUTH) || "null");
    if (value === null) return null;
    if (typeof value.clientId !== "string" || typeof value.refreshToken !== "string") {
      throw new Error("Invalid saved sign-in");
    }
    return value;
  } catch {
    const status = document.getElementById("auth-status");
    if (status) {
      status.textContent = "Saved sign-in could not be read. Reconnect in Setup; your library and settings have not been reset.";
      status.className = "status err";
    }
    return null;
  }
}
function setAuth(o) {
  const raw = JSON.stringify(o);
  authStorage(() => localStorage.setItem(LS_AUTH, raw));
  return raw;
}
let authGeneration = 0;
let accessTokenAuth = null;
let refreshPromise = null;
let refreshAuth = null;
let authController = new AbortController();
let loginIntent = 0;
let loginController = new AbortController();
let locallyStartedLogin = null;
let erasingBrowser = false;
let explicitErasing = false;
let activePeerErases = 0;
const peerEraseTasks = new Map();

function authStorage(operation) {
  try { return operation(); }
  catch { throw new Error("Browser storage is unavailable. Keep your data and retry after checking browser permissions."); }
}

function requireAuthLocks() {
  if (typeof navigator.locks?.request !== "function") {
    throw new Error("Safe Spotify sign-in and logout require Web Locks. Use a supported browser; your saved data has not been reset.");
  }
}

function withAuthLock(operation, ifAvailable = false) {
  requireAuthLocks();
  return navigator.locks.request(AUTH_LOCK_NAME, { mode: "exclusive", ifAvailable }, lock => {
    if (!lock) throw new Error("Sign-in or browser cleanup is busy. Wait for it to finish, then try again.");
    return operation();
  });
}

function browserCleanupActive() {
  if (erasingBrowser) return true;
  try { return localStorage.getItem(LS_ERASE) !== null; }
  catch { return true; }
}

function invalidateLoginWork() {
  loginIntent++;
  loginController.abort();
  loginController = new AbortController();
  locallyStartedLogin = null;
}

function invalidateAuthWork() {
  authGeneration++;
  authController.abort();
  authController = new AbortController();
  refreshPromise = null;
  refreshAuth = null;
  accessToken = null;
  accessTokenExpiresAt = 0;
  accessTokenAuth = null;
}

function assertAuthGeneration(generation) {
  if (generation !== authGeneration || erasingBrowser) {
    throw new Error("Sign-in changed; the previous request was canceled.");
  }
}

function parseLogin(raw) {
  try { return JSON.parse(raw); }
  catch { return null; }
}

function validLoginBinding(binding) {
  return binding?.version === LOGIN_VERSION &&
    typeof binding.state === "string" && /^[A-Za-z0-9_-]{32}$/.test(binding.state) &&
    typeof binding.transaction === "string" && /^[A-Za-z0-9_-]{32}$/.test(binding.transaction) &&
    typeof binding.clientId === "string" && binding.clientId.trim().length > 0 &&
    binding.redirectUri === redirectUri() &&
    Number.isSafeInteger(binding.expiresAt) && binding.expiresAt > Date.now() &&
    binding.expiresAt <= Date.now() + LOGIN_TTL_MS;
}

function sameLoginBinding(first, second) {
  return !!first && !!second && ["version", "state", "transaction", "clientId", "redirectUri", "expiresAt"]
    .every(key => first[key] === second[key]);
}

function loginRegistration(pkce) {
  return authStorage(() => parseLogin(localStorage.getItem(LS_LOGIN_PREFIX + pkce.state)));
}

function matchingLoginRegistration(pkce, registration, claim = null) {
  const keys = ["version", "state", "transaction", "clientId", "redirectUri", "expiresAt", "phase", "claim"];
  return validLoginBinding(pkce) && sameLoginBinding(pkce, registration) &&
    Object.keys(registration).length === keys.length && keys.every(key => Object.hasOwn(registration, key)) &&
    registration.phase === (claim === null ? "pending" : "claimed") && registration.claim === claim;
}

function assertLoginIntent(intent, raw) {
  if (intent !== loginIntent || erasingBrowser || authStorage(() => localStorage.getItem(LS_ERASE)) !== null ||
      authStorage(() => sessionStorage.getItem(LS_PKCE)) !== raw) {
    throw new Error("This login attempt was canceled or replaced. Start a new sign-in.");
  }
}

// Call only under AUTH_LOCK_NAME. A failed/old callback never owns a newer
// transaction, another tab's claim, or the established saved sign-in.
function discardLoginAttempt(pkce, raw, claim = null) {
  const registration = pkce?.state ? loginRegistration(pkce) : null;
  const matches = sameLoginBinding(registration, pkce);
  const ownsRegistration = matches && registration.phase === (claim === null ? "pending" : "claimed") &&
    registration.claim === claim;
  if (ownsRegistration) authStorage(() => localStorage.removeItem(LS_LOGIN_PREFIX + pkce.state));
  const anotherClaim = matches && registration.phase === "claimed" && registration.claim !== claim;
  if (!anotherClaim && authStorage(() => sessionStorage.getItem(LS_PKCE)) === raw) {
    authStorage(() => sessionStorage.removeItem(LS_PKCE));
  }
}

async function reconcilePendingLogin() {
  const raw = authStorage(() => sessionStorage.getItem(LS_PKCE));
  if (!raw) return;
  await withAuthLock(() => {
    const pkce = parseLogin(raw);
    const registration = pkce?.state ? loginRegistration(pkce) : null;
    if (!validLoginBinding(pkce) || !sameLoginBinding(pkce, registration)) discardLoginAttempt(pkce, raw);
  });
}

async function readTokenResponse(response) {
  try { return await response.json(); }
  catch { throw new Error("Spotify returned an unreadable sign-in response."); }
}

class SpotifyError extends Error {
  constructor(status, reason, retryAfterMs) {
    const guidance = {
      400: reason === "INVALID_GRANT" ? "Spotify authorization was rejected. Reconnect in Setup; your library and settings are preserved." : "The request failed. Check Setup and try again.",
      401: "Reconnect to Spotify in Setup.",
      403: "Check the app allowlist, granted permissions and device capabilities.",
      404: "The requested item or playback device is unavailable.",
      429: reason === "QUOTA_EXCEEDED" ? "The app's Spotify quota is exhausted." : "Rate limited; wait before retrying.",
    };
    super(`Spotify ${status}: ${guidance[status] || "The request failed. Try again when the service is available."}`);
    this.name = "SpotifyError";
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

async function spotifyFailure(response) {
  let reason = null;
  try {
    const body = await response.json();
    const candidate = body?.error?.reason;
    if (body?.error === "invalid_grant") reason = "INVALID_GRANT";
    if (["QUOTA_EXCEEDED", "NO_ACTIVE_DEVICE", "RESTRICTION_VIOLATED", "PREMIUM_REQUIRED"].includes(candidate)) {
      reason = candidate;
    }
  } catch {
    // An error response need not be JSON; never display its raw body.
  }
  const header = response.headers?.get("Retry-After");
  const seconds = header === null || header === undefined ? NaN : Number(header);
  const date = header && !Number.isFinite(seconds) ? Date.parse(header) : NaN;
  const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
    : Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  return new SpotifyError(response.status, reason, retryAfterMs);
}

async function spotifyFetch(url, options) {
  const controller = new AbortController();
  const source = options.signal;
  const abort = () => controller.abort();
  if (source?.aborted) controller.abort();
  source?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 15_000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally {
    clearTimeout(timeout);
    source?.removeEventListener("abort", abort);
  }
}

// ---------------------------------------------------------------------
// Spotify "Authorization Code with PKCE" login — runs entirely in the
// browser, no server and no client secret. The flow:
//   1. beginSpotifyLogin(): make a random code_verifier, derive its SHA-256
//      code_challenge, register the attempt under the shared auth lock, keep
//      the verifier tab-local, and redirect to Spotify's consent page.
//   2. Spotify redirects back to this same page with ?code=... ; on load
//      handleAuthRedirect() trades that code (plus the stashed verifier) for an
//      access token + refresh token. Only the refresh token is persisted.
// A random `state` value is sent with the request and checked on return to
// guard against forged/cross-site redirects (CSRF).
// The redirect URI is just this page's own URL, so it works the same on
// localhost and on GitHub Pages — you only have to register that exact URL in
// your Spotify app's dashboard.
// ---------------------------------------------------------------------
function redirectUri() {
  return location.origin + location.pathname;
}
function b64url(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Base64url encodes random bytes without modulo bias.
function randomVerifier(len = 64) {
  const r = crypto.getRandomValues(new Uint8Array(Math.ceil(len * 3 / 4)));
  return b64url(r).slice(0, len);
}
async function challengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(digest);
}
function navigateToSpotify(url) { location.assign(url); }

async function beginSpotifyLogin(clientId) {
  requireAuthLocks();
  if (browserCleanupActive()) throw new Error("Browser cleanup or storage access is busy. Retry sign-in when it is available.");
  if (typeof clientId !== "string" || !clientId.trim()) throw new Error("Enter your Spotify Client ID first.");
  const verifier = randomVerifier();
  const binding = {
    version: LOGIN_VERSION, state: randomVerifier(32), transaction: randomVerifier(32),
    clientId: clientId.trim(), redirectUri: redirectUri(), expiresAt: Date.now() + LOGIN_TTL_MS,
  };
  const pkce = { ...binding, verifier };
  const raw = JSON.stringify(pkce);
  let intent = null;
  try {
    // Never queue a login start through an erase. A busy lock requires a fresh
    // user attempt instead of recreating authority after cleanup has finished.
    await withAuthLock(() => {
      if (browserCleanupActive()) throw new Error("Browser cleanup is in progress. Try signing in again afterward.");
      const previousRaw = authStorage(() => sessionStorage.getItem(LS_PKCE));
      const previous = parseLogin(previousRaw);
      const previousOwner = locallyStartedLogin;
      const key = LS_LOGIN_PREFIX + binding.state;
      if (authStorage(() => localStorage.getItem(key)) !== null) {
        throw new Error("A login registration already exists. Start a new sign-in.");
      }
      const registration = JSON.stringify({ ...binding, phase: "pending", claim: null });
      authStorage(() => localStorage.setItem(key, registration));
      try { authStorage(() => sessionStorage.setItem(LS_PKCE, raw)); }
      catch (error) {
        if (authStorage(() => localStorage.getItem(key)) === registration) authStorage(() => localStorage.removeItem(key));
        throw error;
      }
      invalidateLoginWork();
      intent = loginIntent;
      locallyStartedLogin = binding.transaction;
      // sessionStorage may be copied into a newly opened/duplicated tab. Only
      // replace a prior registration actually started by this document.
      if (previous?.state && previous.transaction === previousOwner && previousRaw !== raw) {
        const prior = loginRegistration(previous);
        if (sameLoginBinding(prior, previous)) {
          authStorage(() => localStorage.removeItem(LS_LOGIN_PREFIX + previous.state));
        }
      }
    }, true);
    const challenge = await challengeFromVerifier(verifier);
    const params = new URLSearchParams({
      response_type: "code", client_id: binding.clientId, redirect_uri: binding.redirectUri,
      scope: SCOPES, code_challenge_method: "S256", code_challenge: challenge, state: binding.state,
    });
    await withAuthLock(() => {
      assertLoginIntent(intent, raw);
      if (!matchingLoginRegistration(pkce, loginRegistration(pkce))) {
        throw new Error("This login attempt expired or was canceled. Start a new sign-in.");
      }
      navigateToSpotify(`${AUTHORIZE_URL}?${params.toString()}`);
    }, true);
  } catch (error) {
    if (intent !== null) {
      try { await withAuthLock(() => discardLoginAttempt(pkce, raw)); }
      catch { /* Unavailable storage/locks must not trigger an unlocked cleanup. */ }
    }
    throw error;
  }
}
// Returns "ok" if we completed a login, "error" if Spotify sent an error back,
// or null if this wasn't an auth redirect at all.
async function handleAuthRedirect() {
  const q = new URLSearchParams(location.search);
  const code = q.get("code");
  const err = q.get("error");
  const state = q.get("state");
  if (!q.has("code") && !q.has("error")) {
    // Returning without a callback must not resurrect a registration erased
    // while this tab was away. Established saved sign-ins need no registration.
    try { await reconcilePendingLogin(); }
    catch (error) { authError = error.message; }
    return null;
  }
  // Strip the auth params from the URL *immediately* (before the token
  // exchange) so the one-time `code` never lingers in the address bar,
  // browser history, or any subresource referrer. We still hold `code`,
  // `state`, and `err` in local variables for the logic below.
  const cleanUrl = redirectUri();
  history.replaceState({}, "", cleanUrl);
  const intent = loginIntent;
  let pkce = null;
  let raw = null;
  let claim = null;
  let ownsAttempt = false;
  try {
    requireAuthLocks();
    raw = authStorage(() => sessionStorage.getItem(LS_PKCE));
    pkce = parseLogin(raw);
    if (q.getAll("state").length !== 1 || !pkce || pkce.state !== state) {
      // A stale callback is not permission to cancel the tab's newer attempt.
      throw new Error("Login state mismatch — please start a new sign-in.");
    }
    ownsAttempt = true;
    if (!validLoginBinding(pkce) || typeof pkce.verifier !== "string" ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(pkce.verifier) ||
        q.getAll("code").length > 1 || q.getAll("error").length > 1 || (q.has("code") && q.has("error"))) {
      throw new Error("Saved login state is invalid or expired. Start a new sign-in.");
    }
    await withAuthLock(() => {
      assertLoginIntent(intent, raw);
      const registration = loginRegistration(pkce);
      if (!matchingLoginRegistration(pkce, registration)) {
        throw new Error("This login attempt expired, was canceled, or has already been used. Start a new sign-in.");
      }
      if (err || !code) throw new Error(err ? "Spotify login was cancelled or denied." : "Spotify did not return a login code.");
      const nextClaim = randomVerifier(32);
      authStorage(() => localStorage.setItem(LS_LOGIN_PREFIX + pkce.state,
        JSON.stringify({ ...registration, phase: "claimed", claim: nextClaim })));
      claim = nextClaim;
    });
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pkce.redirectUri,
      client_id: pkce.clientId,
      code_verifier: pkce.verifier,
    });
    const r = await spotifyFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: loginController.signal,
    });
    if (!r.ok) throw await spotifyFailure(r);
    const j = await readTokenResponse(r);
    if (typeof j?.access_token !== "string" || !j.access_token ||
        typeof j.refresh_token !== "string" || !j.refresh_token || !Number.isFinite(j.expires_in) || j.expires_in <= 0) {
      throw new Error("Spotify returned an incomplete sign-in response.");
    }
    await withAuthLock(() => {
      assertLoginIntent(intent, raw);
      if (!matchingLoginRegistration(pkce, loginRegistration(pkce), claim)) {
        throw new Error("This login attempt expired or was canceled. Start a new sign-in.");
      }
      // Consumption and persistence are synchronous under one shared lock.
      // If either storage operation fails, do not authenticate memory.
      authStorage(() => localStorage.removeItem(LS_LOGIN_PREFIX + pkce.state));
      authStorage(() => sessionStorage.removeItem(LS_PKCE));
      const savedAuth = setAuth({ clientId: pkce.clientId, refreshToken: j.refresh_token });
      if (locallyStartedLogin === pkce.transaction) locallyStartedLogin = null;
      invalidateAuthWork();
      accessToken = j.access_token;
      accessTokenAuth = savedAuth;
      accessTokenExpiresAt = Date.now() + (j.expires_in * 1000);
      authError = null;
    });
    return "ok";
  } catch (e) {
    if (intent === loginIntent) authError = "Couldn't complete login: " + e.message;
    return "error";
  } finally {
    if (ownsAttempt) {
      try { await withAuthLock(() => discardLoginAttempt(pkce, raw, claim)); }
      catch { /* Preserve saved data if protected cleanup is unavailable. */ }
    }
  }
}
let authError = null;

async function getAccessToken() {
  requireAuthLocks();
  if (erasingBrowser || authStorage(() => localStorage.getItem(LS_ERASE)) !== null) {
    throw new Error("Browser cleanup is in progress or incomplete. Wait for cleanup, or reopen Logout to retry it.");
  }
  const savedAuth = authStorage(() => localStorage.getItem(LS_AUTH));
  if ((accessTokenAuth !== null && savedAuth !== accessTokenAuth) ||
      (refreshPromise && savedAuth !== refreshAuth)) invalidateAuthWork();
  if (savedAuth && savedAuth === accessTokenAuth && accessToken && Date.now() < accessTokenExpiresAt - 30_000) return accessToken;
  if (refreshPromise && refreshAuth === savedAuth) return refreshPromise;
  const generation = authGeneration;
  const a = getAuth();
  if (!a || !a.clientId || !a.refreshToken) throw new Error("Not authenticated");
  const task = (async () => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: a.refreshToken,
      client_id: a.clientId,
    });
    const r = await spotifyFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: authController.signal,
    });
    if (!r.ok) throw await spotifyFailure(r);
    const j = await readTokenResponse(r);
    if (typeof j?.access_token !== "string" || !j.access_token || !Number.isFinite(j.expires_in) || j.expires_in <= 0 ||
        (j.refresh_token !== undefined && (typeof j.refresh_token !== "string" || !j.refresh_token))) {
      throw new Error("Spotify returned an incomplete refresh response.");
    }
    return withAuthLock(() => {
      assertAuthGeneration(generation);
      if (authStorage(() => localStorage.getItem(LS_AUTH)) !== savedAuth) {
        throw new Error("Saved sign-in changed. Retry with the current session.");
      }
      if (j.refresh_token) a.refreshToken = j.refresh_token;
      const committedAuth = setAuth(a);
      accessToken = j.access_token;
      accessTokenAuth = committedAuth;
      accessTokenExpiresAt = Date.now() + (j.expires_in * 1000);
      return accessToken;
    });
  })();
  refreshPromise = task;
  refreshAuth = savedAuth;
  try { return await task; }
  finally { if (refreshPromise === task) { refreshPromise = null; refreshAuth = null; } }
}

class VolumeControlUnavailableError extends Error {
  constructor() {
    super("This browser or Spotify device requires physical or Spotify volume controls.");
    this.name = "VolumeControlUnavailableError";
  }
}

function assertPlaybackCapabilities(path, opts) {
  if (path.startsWith("/me/player") && opts.method && opts.method !== "GET") {
    if (path.startsWith("/me/player/volume") && !canControlVolume()) throw new VolumeControlUnavailableError();
    if (path !== "/me/player" && activeDeviceCapabilities?.is_restricted) throw new Error("This Spotify device does not permit playback control.");
  }
}

async function api(path, opts = {}, requestCurrent = null) {
  assertPlaybackCapabilities(path, opts);
  if (requestCurrent && !requestCurrent()) throw new Error("Playback request was superseded.");
  const generation = authGeneration;
  const tok = await getAccessToken();
  assertAuthGeneration(generation);
  if (requestCurrent && !requestCurrent()) throw new Error("Playback request was superseded.");
  assertPlaybackCapabilities(path, opts);
  const savedAuth = localStorage.getItem(LS_AUTH);
  const r = await spotifyFetch(API + path, {
    ...opts,
    headers: {
      "Authorization": "Bearer " + tok,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
    signal: authController.signal,
  });
  assertAuthGeneration(generation);
  if (localStorage.getItem(LS_AUTH) !== savedAuth) throw new Error("Sign-in changed; the previous request was canceled.");
  if (!r.ok) throw await spotifyFailure(r);
  // Playback controls return no result; successful acknowledgements need not be JSON.
  const playbackCommand = opts.method === "PUT" && [
    "/me/player", "/me/player/play", "/me/player/pause", "/me/player/seek", "/me/player/volume",
  ].includes(path.split("?")[0]);
  if (r.status === 204 || playbackCommand) return null;
  const txt = await r.text();
  assertAuthGeneration(generation);
  if (!txt) return null;
  try { return JSON.parse(txt); }
  catch { throw new Error("Spotify returned an unreadable response. Playback state may need refreshing."); }
}

// =====================================================================
// Playback control
// =====================================================================
let transportGeneration = 0;
let transportQueue = Promise.resolve();
let transportPending = false;
let transportIntentKind = null;
let playingSnapshot = null;
let stopDeadlineTimer = null;
let manualStopTimer = null;
let stopDeadlineKey = null;
let reconcileTimer = null;
let volumeSequence = 0;
let volumeFineThrottle = null;
const IDLE_SILENCE_TRACK = "3mkOlbSv5RYadx0JsjTrKq";
const IDLE_CHECK_MS = 30000;
const IDLE_PLAYBACK_CHECK_MS = 15000;
const IDLE_RENEW_BEFORE_MS = 60000;
const IDLE_MIN_DURATION_MS = 30000;
let idlePlayback = null;
let idlePendingDevice = null;
let idleResume = null;
let idleTrack = null;
let idleTimer = null;
let idleNextCheckAt = 0;
let idleGeneration = 0;
let idleCheckPromise = null;
let idleBlocked = false;
let idleFailure = null;
let idleReady = false;
let idlePageActive = true;

function idleEnabled() {
  try { return localStorage.getItem(LS_IPAD_KEEPALIVE) !== "0"; }
  catch {
    idleBlocked = true;
    idleFailure = "Keep-awake settings could not be read. Check browser storage permissions; no app data was reset.";
    return false;
  }
}

function isIdleDevice(device) {
  return typeof device?.id === "string" && device.id.length > 0 &&
    typeof device.name === "string" && /ipad/i.test(device.name) && !device.is_restricted;
}

function idleForeground() {
  return idleEnabled() && idlePageActive && !erasingBrowser && !databaseImporting && !browserCleanupActive() &&
    document.visibilityState === "visible" && !!getAuth()?.refreshToken && !confettiState;
}

function cancelIdleCheck() {
  idleGeneration++;
  clearTimeout(idleTimer);
  idleTimer = null;
  idleNextCheckAt = 0;
}

function clearIdlePlayback(clearResume = false) {
  cancelIdleCheck();
  idlePlayback = null;
  idlePendingDevice = null;
  if (clearResume) idleResume = null;
  updateIdleControls();
}

function updateIdleControls() {
  const enabled = idleEnabled();
  for (const id of ["in-ipad-keepalive", "keepalive-enabled"]) {
    const checkbox = document.getElementById(id);
    if (checkbox) checkbox.checked = enabled;
  }
  const running = enabled && !!idlePlayback && !idleFailure && !idleBlocked;
  const state = !enabled ? "off" : running ? "running" : "on";
  const message = !enabled
    ? (idlePlayback ? "Keep-awake off. The last silence track may still be playing." : "Keep-awake off. Pause and Stop pause Spotify normally.")
    : idleFailure ? "Keep-awake needs attention. See the error message for details."
      : running ? "Keep-awake running. Silence is playing on the selected iPad."
        : "Keep-awake on: waiting for idle Spotify on a selected iPad.";
  const toggle = document.getElementById("keepalive-toggle");
  if (toggle) { toggle.dataset.state = state; toggle.title = message; }
  const emoji = document.getElementById("keepalive-emoji");
  if (emoji) {
    emoji.textContent = enabled ? "\u2615\uFE0F" : "\u{1F634}";
    emoji.classList.toggle("hidden", running);
  }
  const ball = document.getElementById("keepalive-ball");
  ball?.classList.toggle("hidden", !running);
  ball?.classList.toggle("spinning", running);
  const description = document.getElementById("keepalive-state-text");
  if (description && description.textContent !== message) description.textContent = message;
  const status = document.getElementById("ipad-keepalive-status");
  if (!status) return;
  const focusedAction = status.contains(document.activeElement) ? document.activeElement.dataset.idleAction : null;
  const restoreFocus = () => {
    if (!focusedAction) return;
    const control = Array.from(status.querySelectorAll("button")).find(button => button.dataset.idleAction === focusedAction);
    (control || document.getElementById("keepalive-enabled"))?.focus({ preventScroll: true });
  };
  status.replaceChildren();
  status.classList.toggle("hidden", !idleFailure);
  if (!idleFailure) { restoreFocus(); return; }
  const text = document.createElement("span");
  text.textContent = idleFailure;
  status.appendChild(text);
  if (idleFailure && enabled) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.dataset.idleAction = "retry";
    retry.textContent = "Retry";
    retry.onclick = () => {
      idleBlocked = false;
      idleFailure = null;
      void checkIdlePlayback();
    };
    status.appendChild(retry);
  }
  if (enabled) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.dataset.idleAction = "disable";
    stop.textContent = "Disable keep-awake";
    stop.onclick = () => { void setIdleEnabled(false); };
    status.appendChild(stop);
  }
  restoreFocus();
}

function reportIdleFailure(error) {
  idleBlocked = true;
  clearTimeout(idleTimer);
  idleTimer = null;
  idleFailure = `Idle silence was not confirmed. ${error.message} Playback and saved app data have not been reset.`;
  updateIdleControls();
}

function recordIdlePlayback(deviceId, durationMs, progressMs, observedAt) {
  if (!Number.isFinite(durationMs) || durationMs <= IDLE_MIN_DURATION_MS ||
      !Number.isFinite(progressMs) || progressMs < 0) {
    throw new Error("Spotify did not return a usable silence duration and progress.");
  }
  // A poll started before a confirmed restart must not restore the old deadline.
  if (idlePlayback?.deviceId === deviceId && idlePlayback.observedAt > observedAt) return idlePlayback;
  const headroom = Math.min(IDLE_RENEW_BEFORE_MS, durationMs / 4);
  idlePlayback = {
    deviceId, durationMs, observedAt,
    renewAt: observedAt + Math.max(0, durationMs - progressMs) - headroom,
  };
  return idlePlayback;
}

function scheduleIdleCheck(delay = idlePlayback ? IDLE_PLAYBACK_CHECK_MS : IDLE_CHECK_MS) {
  if (!idleReady || idleBlocked || !idleForeground() || (nowPlaying && !nowPlaying.paused)) {
    clearTimeout(idleTimer);
    idleTimer = null;
    idleNextCheckAt = 0;
    if (idleFailure) updateIdleControls();
    return;
  }
  const now = performance.now();
  if (Number.isFinite(idlePlayback?.renewAt)) delay = Math.min(delay, idlePlayback.renewAt - now);
  const due = now + Math.max(1000, delay);
  if (idleTimer && idleNextCheckAt <= due) return;
  clearTimeout(idleTimer);
  idleNextCheckAt = due;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    idleNextCheckAt = 0;
    void checkIdlePlayback();
  }, Math.max(1000, delay));
}

function isSilenceState(state) {
  return state?.item?.id === IDLE_SILENCE_TRACK || state?.item?.linked_from?.id === IDLE_SILENCE_TRACK ||
    (idleTrack && state?.item?.id === idleTrack.id);
}

async function loadIdleTrack(current) {
  if (idleTrack) return idleTrack;
  const track = await api(`/tracks/${IDLE_SILENCE_TRACK}`, {}, current);
  if (!current()) return null;
  if (typeof track?.id !== "string" || !track.id ||
      (track.id !== IDLE_SILENCE_TRACK && track.linked_from?.id !== IDLE_SILENCE_TRACK) ||
      track?.is_playable === false || !Number.isFinite(track?.duration_ms) ||
      track.duration_ms <= IDLE_MIN_DURATION_MS) {
    throw new Error("The selected silence track is unavailable or its duration cannot be verified.");
  }
  idleTrack = { id: track.id, durationMs: track.duration_ms };
  return idleTrack;
}

function idleStatePermitsPlayback(state, device) {
  if (!state || !state.device?.id || typeof state.is_playing !== "boolean") {
    throw new Error("Spotify's current playback state is unavailable. Open Spotify on the selected iPad, then retry.");
  }
  if (state.device.id !== device.id || !isIdleDevice(state.device) ||
      (state.is_playing && !isSilenceState(state))) return false;
  if (state.repeat_state !== "off") {
    throw new Error("Turn Repeat off in Spotify before using idle silence; this app does not change Spotify's repeat setting.");
  }
  return true;
}

async function maintainIdlePlayback(current) {
  if (!idleForeground() || idleBlocked || (nowPlaying && !nowPlaying.paused)) return false;
  const epoch = idleGeneration;
  const selectedId = activeDeviceId || localStorage.getItem(LS_DEVICE);
  const generation = authGeneration;
  const clientId = getAuth()?.clientId;
  const live = () => current() && epoch === idleGeneration && idleForeground() &&
    authGeneration === generation && getAuth()?.clientId === clientId && (!nowPlaying || nowPlaying.paused) &&
    (!selectedId || !activeDeviceId || activeDeviceId === selectedId);
  requireAuthLocks();
  // Serialize independent visible tabs' probes, without holding the auth/erase lock.
  return navigator.locks.request("s9000.idle-playback", { mode: "exclusive", ifAvailable: true }, async lock => {
    if (!lock || !live()) return false;
    const devices = await api("/me/player/devices", {}, live);
    if (!live()) return false;
    const device = (devices?.devices || []).find(item => selectedId ? item.id === selectedId : item.is_active);
    if (!isIdleDevice(device)) {
      if (selectedId && isIdleDevice(activeDeviceCapabilities) && !device) {
        throw new Error("The selected iPad is unavailable. Open Spotify on that device, then retry.");
      }
      idlePlayback = null;
      updateIdleControls();
      return false;
    }
    let observedAt = performance.now();
    let state = await api("/me/player", {}, live);
    if (!live()) return false;
    if (!idleStatePermitsPlayback(state, device)) {
      idlePlayback = null;
      updateIdleControls();
      return false;
    }
    activeDeviceId = device.id;
    activeDeviceCapabilities = device;
    updateVolumeControls();
    const hadMetadata = !!idleTrack;
    const track = await loadIdleTrack(live);
    if (!track || !live()) return false;
    if (!hadMetadata) {
      observedAt = performance.now();
      state = await api("/me/player", {}, live);
      if (!live()) return false;
      if (!idleStatePermitsPlayback(state, device)) return false;
    }
    const duration = isSilenceState(state) && Number.isFinite(state.item?.duration_ms) && state.item.duration_ms > IDLE_MIN_DURATION_MS
      ? state.item.duration_ms : track.durationMs;
    if (isSilenceState(state) && state.is_playing) {
      const observed = recordIdlePlayback(device.id, duration, state.progress_ms, observedAt);
      idleFailure = null;
      updateIdleControls();
      if (performance.now() < observed.renewAt) return true;
    }
    if (nowPlaying?.paused && playingSnapshot && !idleResume) {
      idleResume = { uuid: nowPlaying.uuid, trackId: playingSnapshot.trackid, deviceId: device.id };
    }
    if (!live()) return false;
    const pendingDevice = { deviceId: device.id };
    idlePendingDevice = pendingDevice;
    const requestedAt = performance.now();
    try {
      await api(`/me/player/play?device_id=${encodeURIComponent(device.id)}`, {
        method: "PUT", body: JSON.stringify({ uris: [`spotify:track:${IDLE_SILENCE_TRACK}`], position_ms: 0 }),
      }, live);
    } finally {
      if (idlePendingDevice === pendingDevice) idlePendingDevice = null;
    }
    if (!live()) return false;
    const confirmedAt = performance.now();
    recordIdlePlayback(device.id, track.durationMs, confirmedAt - requestedAt, confirmedAt);
    idleFailure = null;
    updateIdleControls();
    return true;
  });
}

async function tryIdlePlayback(current) {
  const epoch = idleGeneration;
  try { return await maintainIdlePlayback(current); }
  catch (error) {
    if (current() && epoch === idleGeneration && idleForeground()) reportIdleFailure(error);
    return false;
  }
}

function checkIdlePlayback() {
  if (idleCheckPromise) return idleCheckPromise;
  if (!idleForeground() || idleBlocked || transportPending || (nowPlaying && !nowPlaying.paused)) {
    if (idleFailure) updateIdleControls();
    return Promise.resolve(false);
  }
  let applied = false;
  const task = queueTransport("Keep Spotify awake", async current => {
    applied = await tryIdlePlayback(current);
  }, () => { idleBlocked = false; void checkIdlePlayback(); }, false).then(ok => ok && applied);
  idleCheckPromise = task;
  void task.finally(() => {
    if (idleCheckPromise === task) idleCheckPromise = null;
    scheduleIdleCheck();
  });
  return task;
}

async function setIdleEnabled(enabled) {
  try { localStorage.setItem(LS_IPAD_KEEPALIVE, enabled ? "1" : "0"); }
  catch { reportIdleFailure(new Error("The keep-awake setting could not be saved.")); return false; }
  cancelIdleCheck();
  idleBlocked = false;
  idleFailure = null;
  updateIdleControls();
  if (enabled) return checkIdlePlayback();
  const owned = idlePlayback || idlePendingDevice;
  if (!owned) return true;
  return queueTransport("Stop idle silence", async current => {
    const state = await api("/me/player", {}, current);
    if (!current()) return;
    if (state?.device?.id === owned.deviceId && isSilenceState(state) && state.is_playing) {
      await api(`/me/player/pause?device_id=${encodeURIComponent(owned.deviceId)}`, { method: "PUT" }, current);
    }
    if (current()) clearIdlePlayback();
  }, () => setIdleEnabled(false));
}

function wireIdlePlaybackControls() {
  for (const id of ["in-ipad-keepalive", "keepalive-enabled"]) {
    document.getElementById(id).onchange = event => { void setIdleEnabled(event.target.checked); };
  }
  updateIdleControls();
}

function reportTransportFailure(action, error, retry) {
  const status = document.getElementById("transport-status");
  status.replaceChildren();
  const text = document.createElement("span");
  text.textContent = `${action} was not confirmed. ${error.message} Check Spotify before relying on the displayed state.`;
  status.appendChild(text);
  if (retry) {
    const button = document.createElement("button");
    button.textContent = "Retry";
    button.onclick = retry;
    status.appendChild(button);
  }
  status.classList.remove("hidden");
}

function queueTransport(action, operation, retry, intent = true) {
  const generation = intent ? ++transportGeneration : transportGeneration;
  if (intent) {
    transportPending = true;
    transportIntentKind = action;
    cancelFade();
    cancelIdleCheck();
    idleBlocked = false;
    idleFailure = null;
  }
  const current = () => generation === transportGeneration && !erasingBrowser;
  const task = transportQueue.then(async () => {
    if (!current()) return false;
    try {
      await operation(current);
      if (!current()) return false;
      if (intent) document.getElementById("transport-status").classList.add("hidden");
      return true;
    } catch (error) {
      if (current()) {
        if (intent) idleBlocked = true;
        updateIdleControls();
        reportTransportFailure(action, error, retry);
      }
      return false;
    } finally {
      if (current() && intent) { transportPending = false; armStopDeadline(); scheduleIdleCheck(); }
    }
  });
  transportQueue = task.then(() => {});
  return task;
}

function invalidateTransportWork() {
  clearIdlePlayback(true);
  idleTrack = null;
  idleBlocked = true;
  idleFailure = null;
  updateIdleControls();
  transportGeneration++;
  volumeSequence++;
  transportPending = false;
  cancelFade();
  clearTimeout(stopDeadlineTimer);
  clearTimeout(manualStopTimer);
  clearTimeout(reconcileTimer);
  clearTimeout(volRailSettleTimer);
  clearTimeout(cueFineHideTimer);
  stopDeadlineTimer = reconcileTimer = volRailSettleTimer = null;
  stopDeadlineKey = null;
  dragTarget = barFocused = null;
  stopConfetti();
  setNowPlaying(null);
  document.getElementById("np-title").textContent = "";
  document.getElementById("np-sub").textContent = "";
  document.getElementById("transport-status").replaceChildren();
  document.getElementById("transport-status").classList.add("hidden");
}

function armStopDeadline() {
  if (!progress || progress.paused || !nowPlaying || progress.stopAttempted || erasingBrowser) {
    clearTimeout(stopDeadlineTimer); stopDeadlineTimer = null; stopDeadlineKey = null;
    return;
  }
  const stop = effectiveStopMs(nowPlaying.uuid);
  if (!(stop > 0 && stop < progress.durationMs)) {
    clearTimeout(stopDeadlineTimer); stopDeadlineTimer = null; stopDeadlineKey = null;
    return;
  }
  const key = [nowPlaying.uuid, stop, progress.baseTime, progress.startOffsetMs, progress.elapsedAtPause, transportGeneration].join(":");
  if (key === stopDeadlineKey) return;
  clearTimeout(stopDeadlineTimer);
  stopDeadlineKey = key;
  const generation = transportGeneration;
  const currentProgress = progress;
  stopDeadlineTimer = setTimeout(() => {
    if (generation !== transportGeneration || progress !== currentProgress || progress.paused) return;
    progress.stopAttempted = true;
    void stopPlayback();
  }, Math.max(0, stop - currentPositionMs()));
}

function scheduleReconciliation() {
  clearTimeout(reconcileTimer);
  if (nowPlaying && !erasingBrowser) {
    reconcileTimer = setTimeout(async () => {
      if (document.visibilityState !== "hidden") await reconcilePlayback();
      scheduleReconciliation();
    }, 5000);
  }
}

async function reconcilePlayback() {
  if (!nowPlaying || transportPending || erasingBrowser) return false;
  const generation = transportGeneration;
  const observed = progress;
  try {
    const requestedAt = performance.now();
    const state = await api("/me/player");
    if (generation !== transportGeneration || progress !== observed || transportPending || !nowPlaying) return false;
    if (isSilenceState(state) && state.device?.id === idleResume?.deviceId && nowPlaying.paused && idleResume?.uuid === nowPlaying.uuid) {
      if (state.is_playing) {
        const duration = Number.isFinite(state.item?.duration_ms) && state.item.duration_ms > IDLE_MIN_DURATION_MS
          ? state.item.duration_ms : idleTrack?.durationMs;
        recordIdlePlayback(state.device.id, duration, state.progress_ms, requestedAt);
      }
      updateIdleControls();
      scheduleIdleCheck(state.is_playing ? IDLE_PLAYBACK_CHECK_MS : 1000);
      return true;
    }
    if (!state || state.item?.id !== playingSnapshot?.trackid) {
      cancelFade();
      invalidateTransportWork();
      showToast("Spotify playback changed outside this controller. Select a tile to resume cue control.");
      return true;
    }
    activeDeviceCapabilities = state.device || activeDeviceCapabilities;
    if (state.device?.id) activeDeviceId = state.device.id;
    updateVolumeControls();
    nowPlaying.disallows = state.actions?.disallows || {};
    nowPlaying.paused = !state.is_playing;
    document.querySelectorAll(".cell.playing").forEach(cell => cell.classList.toggle("paused", nowPlaying.paused));
    if (progress && Number.isFinite(state.progress_ms)) {
      progress.startOffsetMs = state.progress_ms;
      progress.elapsedAtPause = 0;
      progress.baseTime = performance.now();
      progress.paused = !state.is_playing;
      if (progress.paused) cancelFade();
      armStopDeadline();
      renderProgress();
      if (!progress.paused) scheduleProgressTick();
    }
    updatePauseBtn();
    scheduleIdleCheck();
    return true;
  } catch (error) {
    if (generation === transportGeneration) reportTransportFailure("Playback refresh", error, reconcilePlayback);
    return false;
  }
}

document.addEventListener("visibilitychange", () => {
  cancelIdleCheck();
  if (document.visibilityState === "visible") {
    if (nowPlaying) void reconcilePlayback();
    if (idleReady) {
      idleBlocked = false;
      void checkIdlePlayback();
    }
  }
});
window.addEventListener("pagehide", () => {
  idlePageActive = false;
  cancelIdleCheck();
});
window.addEventListener("pageshow", event => {
  idlePageActive = true;
  if (event.persisted && idleReady && document.visibilityState === "visible") {
    idleBlocked = false;
    void checkIdlePlayback();
  }
});

async function ensureDevice() {
  if (activeDeviceId && activeDeviceCapabilities) {
    updateVolumeControls();
    return activeDeviceId;
  }
  const stored = activeDeviceId || localStorage.getItem(LS_DEVICE);
  const j = await api("/me/player/devices");
  const active = (j.devices || []).find(d => stored ? d.id === stored : d.is_active);
  if (active && !active.is_restricted) {
    activeDeviceId = active.id;
    activeDeviceCapabilities = active;
    updateVolumeControls();
    return active.id;
  }
  throw new Error("No active Spotify device. Open Spotify on your phone first.");
}

function isAppleMobileBrowser() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function canControlVolume() {
  return !isAppleMobileBrowser() && activeDeviceCapabilities?.supports_volume !== false &&
    !activeDeviceCapabilities?.is_restricted;
}

function getDefaultVolumePct() {
  const v = parseInt(localStorage.getItem(LS_VOLUME) || "", 10);
  if (!isNaN(v) && v >= 0 && v <= 100) return v;
  // fall back to DB AppSettings.volume (0..1)
  return Math.round((appSettings?.volume ?? 0.7) * 100);
}

// Default fade-in / fade-out durations (seconds). Web-app override in localStorage
// wins; otherwise we fall back to the value stored in the database's AppSettings.
function getDefaultFadeInSec() {
  const v = parseInt(localStorage.getItem(LS_FADE_IN) || "", 10);
  if (!isNaN(v) && v >= 0) return v;
  return appSettings?.fadeInSec ?? 0;
}
function getDefaultFadeOutSec() {
  const v = parseInt(localStorage.getItem(LS_FADE_OUT) || "", 10);
  if (!isNaN(v) && v >= 0) return v;
  return appSettings?.fadeOutSec ?? 2;
}

// A cell's effective fade-out (seconds): its own value if set (>=0), else the
// default. (Per-track fadeOutSeconds uses -1 to mean "inherit the default.")
function effectiveFadeOutSec(cell) {
  const f = Number(cell?.dataset.fadeout ?? playingSnapshot?.fadeout ?? -1);
  return (!isNaN(f) && f >= 0) ? f : getDefaultFadeOutSec();
}

function setLatency(ms, ok = true) {
  const p = document.getElementById("latency-pill");
  if (ms == null) { p.textContent = "— ms"; p.dataset.state = "none"; return; }
  p.textContent = `${Math.round(ms)} ms`;
  p.dataset.state = !ok ? "error" : (ms < 250 ? "ready" : ms < 600 ? "warn" : "error");
}

async function startPlayback(cell) {
  const trackId = cell.dataset.trackid;
  if (!trackId) { showToast("No Spotify track on this button."); return false; }
  const snapshot = cell.cloneNode(true);
  const startMs = parseInt(cell.dataset.startms || "0", 10);
  const fadeInSec = parseInt(cell.dataset.fadein || "-1", 10);
  const effFadeIn = (fadeInSec >= 0) ? fadeInSec : getDefaultFadeInSec();
  const body = { uris: [`spotify:track:${trackId}`], position_ms: startMs };
  // Per-track volume: a stored value of 0..1 wins; the -1 sentinel (or anything
  // negative/missing) means "use the Settings default".
  const rawVol = parseFloat(cell.dataset.volume);
  const targetVol = (!isNaN(rawVol) && rawVol >= 0) ? Math.round(rawVol * 100) : getDefaultVolumePct();

  return queueTransport("Start", async current => {
    const dev = await ensureDevice();
    if (!current()) return;
    const canVolume = canControlVolume();
    if (canVolume) await sendVolume(effFadeIn > 0 ? 0 : targetVol);
    if (!current()) return;
    const t0 = performance.now();
    try {
      await api(`/me/player/play?device_id=${encodeURIComponent(dev)}`, {
        method: "PUT", body: JSON.stringify(body),
      });
    } catch (error) { setLatency(performance.now() - t0, false); throw error; }
    if (!current()) return;
    setLatency(performance.now() - t0);
    clearIdlePlayback(true);
    setNowPlaying(snapshot);
    document.querySelectorAll(".cell").forEach(tile => {
      if (tile.dataset.pbuuid === snapshot.dataset.pbuuid) tile.classList.add("playing");
    });
    markCellPlayed(snapshot);
    if (canVolume && effFadeIn > 0) doFade(0, targetVol, effFadeIn * 1000);
  }, () => startPlayback(snapshot));
}

// =====================================================================
// "Track Played" — gray out songs once they've been played
// ---------------------------------------------------------------------
// A tile is shown grayed-out whenever its database "has been played" flag is
// set. That flag can already be set when you load the file (history from past
// use), and starting a song sets it too — but only while the global "Track
// Played" switch is on. Turning the switch off lets you replay and tinker with
// cue times without re-flagging anything; songs flagged earlier stay gray.
// Changes are written to the in-memory database and the local cache right away,
// so they survive a reload and ride along the next time you Save — without ever
// nagging you about unsaved changes.
// =====================================================================

// Flip the global switch on/off and remember the choice for next time.
function setTrackPlayed(on) {
  trackPlayedOn = !!on;
  localStorage.setItem(LS_TRACK_PLAYED, trackPlayedOn ? "1" : "0");
  updateTrackPlayedControl();
}

function updateTrackPlayedControl() {
  const cb = document.getElementById("track-played");
  if (cb) cb.checked = trackPlayedOn;
  const icon = document.getElementById("track-played-icon");
  if (icon) icon.textContent = trackPlayedOn ? "\u{1F435}" : "\u{1F648}";
}

// Mark one tile as played (and gray it). No-op when the switch is off or the
// tile is already marked.
function markCellPlayed(cell) {
  if (!trackPlayedOn || !db || !cell) return;
  if (cell.classList.contains("played")) return;
  if (!mutateDatabase(() => db.run("UPDATE Playback SET hasBeenPlayedRaw = 1, updatedTimestamp1970 = ? WHERE playbackUUIDRaw = ?",
    [Date.now() / 1000, cell.dataset.pbuuid]))) return;
  cell.classList.add("played");
  document.querySelectorAll(".cell").forEach(tile => {
    if (tile.dataset.pbuuid === cell.dataset.pbuuid) tile.classList.add("played");
  });
  markTabOpDirty();
}

// Clear the "played" flag for every song on the current tab (after confirming).
// Other tabs are left untouched.
function clearPlayedOnTab() {
  if (!db) return;
  const g = groups[activeTabIdx];
  if (!g) return;
  if (!confirm(`Clear the "played" marks from every song on the "${g.name}" tab?\n\nThis removes the gray-out from all tiles on this tab. Other tabs are not affected.`)) return;
  if (!mutateDatabase(() => db.run("UPDATE Playback SET hasBeenPlayedRaw = 0, updatedTimestamp1970 = ? WHERE playbackGroupUUIDRaw = ?",
    [Date.now() / 1000, g.uuid]))) return;
  markTabOpDirty();
  document.querySelectorAll("#grid .cell.played").forEach(c => c.classList.remove("played"));
}

// Set or clear a single tile's "played" flag from the right-click menu. Unlike
// markCellPlayed (which only fires while the Track Played switch is on), this is
// a deliberate manual action, so it always applies. Written straight to the DB
// and cached like the other played-state changes — no Save nag.
function setCellPlayedFlag(pbUUID, played) {
  if (!db) return;
  if (!mutateDatabase(() => db.run("UPDATE Playback SET hasBeenPlayedRaw = ?, updatedTimestamp1970 = ? WHERE playbackUUIDRaw = ?",
    [played ? 1 : 0, Date.now() / 1000, pbUUID]))) return;
  const cell = document.querySelector(`.cell[data-pbuuid="${pbUUID}"]`);
  if (cell) cell.classList.toggle("played", !!played);
  markTabOpDirty();
}

function setPlaybackPaused(paused) {
  if (nowPlaying) {
    nowPlaying.paused = paused;
    // These flags describe the pre-command state; keep unrelated restrictions.
    delete nowPlaying.disallows?.pausing;
    delete nowPlaying.disallows?.resuming;
  }
  document.querySelectorAll(".cell.playing").forEach(cell => cell.classList.toggle("paused", paused));
  if (paused) pauseProgress();
  else resumeProgress();
  updatePauseBtn();
}

async function pausePlayback() {
  return queueTransport("Pause", async current => {
    if (nowPlaying?.disallows?.pausing) throw new Error("Spotify currently disallows pausing this item.");
    await api("/me/player/pause", { method: "PUT" });
    if (!current()) return;
    setPlaybackPaused(true);
    await tryIdlePlayback(current);
  }, pausePlayback);
}

async function resumePlayback() {
  if (!nowPlaying) return false;
  return queueTransport("Resume", async current => {
    if (nowPlaying?.disallows?.resuming) throw new Error("Spotify currently disallows resuming this item.");
    const dev = await ensureDevice();
    if (!current()) return;
    if (progress?.stopFiring && canControlVolume()) {
      await sendVolume(cellEffectiveVolumePct(nowPlaying.uuid));
    }
    if (!current()) return;
    const restore = idleResume?.uuid === nowPlaying.uuid ? {
      uris: [`spotify:track:${idleResume.trackId}`],
      position_ms: Math.max(0, Math.min(progress?.durationMs || Infinity, Math.round(currentPositionMs()))),
    } : null;
    await api(`/me/player/play?device_id=${encodeURIComponent(dev)}`, {
      method: "PUT", ...(restore ? { body: JSON.stringify(restore) } : {}),
    });
    if (!current() || !nowPlaying) return;
    clearIdlePlayback(true);
    setPlaybackPaused(false);
  }, resumePlayback);
}

function updatePauseBtn() {
  const b = document.getElementById("np-pause");
  if (b) b.textContent = (nowPlaying && nowPlaying.paused) ? "▶" : "⏸";
  setBallSpin(!!(nowPlaying && !nowPlaying.paused));
}

// Spin (or stop) the baseballs — the one beside the logo and the position marker
// on the now-playing bar. They turn only while a song is actively playing; paused
// or stopped leaves them frozen in place.
function setBallSpin(on) {
  document.getElementById("logo-ball")?.classList.toggle("spinning", on);
  document.getElementById("np-bar-dot")?.classList.toggle("spinning", on);
}

async function stopPlayback() {
  return queueTransport("Stop", async current => {
    await api("/me/player/pause", { method: "PUT" });
    if (!current()) return;
    clearIdlePlayback(true);
    setNowPlaying(null);
    await tryIdlePlayback(current);
  }, stopPlayback);
}

async function fadeIn() {
  clearTimeout(manualStopTimer);
  cancelFade();
  const target = getDefaultVolumePct();
  return doFade(0, target, getDefaultFadeInSec() * 1000);
}

async function fadeOut(_cell) {
  cancelFade();
  const dur = getDefaultFadeOutSec() * 1000;
  clearTimeout(manualStopTimer);
  const generation = transportGeneration;
  manualStopTimer = setTimeout(() => {
    if (generation === transportGeneration && !erasingBrowser) void stopPlayback();
  }, dur);
  return doFade(nowPlaying ? cellEffectiveVolumePct(nowPlaying.uuid) : getDefaultVolumePct(), 0, dur);
}

async function sendVolume(percent) {
  if (!canControlVolume()) return false;
  percent = Math.max(0, Math.min(100, Math.round(percent)));
  try {
    await api(`/me/player/volume?volume_percent=${percent}`, { method: "PUT" });
    return true;
  } catch (error) {
    if (error instanceof VolumeControlUnavailableError) return false;
    throw error;
  }
}

async function setVolume(percent) {
  if (!canControlVolume()) return false;
  const sequence = ++volumeSequence;
  let applied = false;
  const confirmed = await queueTransport("Volume", async current => {
    if (sequence !== volumeSequence || !current()) return;
    applied = await sendVolume(percent);
  }, () => setVolume(percent), false);
  return confirmed && applied;
}

function cancelFade() {
  fadeGen++;                                    // invalidate any in-flight step
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
}
// Ramp the Spotify volume from fromPct to toPct over durationMs, then run onDone.
// Implemented as a self-scheduling setTimeout loop (NOT setInterval) so each
// volume PUT must finish before the next is scheduled. setInterval fires on a
// fixed clock regardless of how long each request takes, so on a slow Spotify
// Connect device (volume PUTs often exceed the old 200ms cadence) requests would
// overlap and pile up — heard as a stutter. Awaiting each step keeps at most one
// request in flight, and we skip re-sending a volume the device already has.
function doFade(fromPct, toPct, durationMs, onDone) {
  cancelFade();
  if (!canControlVolume()) return false;
  const gen = fadeGen;
  const started = performance.now();
  let lastSent = null;
  const tick = async () => {
    fadeTimer = null;
    if (gen !== fadeGen || erasingBrowser || !canControlVolume()) return;
    const fraction = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - started) / durationMs);
    const pct = Math.round(fromPct + (toPct - fromPct) * fraction);
    if (pct !== lastSent) {
      lastSent = pct;
      if (!await setVolume(pct)) return;
    }
    if (gen !== fadeGen) return;
    if (fraction >= 1) {
      if (onDone) void onDone();
      return;
    }
    fadeTimer = setTimeout(tick, Math.min(250, Math.max(0, durationMs - (performance.now() - started))));
  };
  fadeTimer = setTimeout(tick, Math.min(250, Math.max(0, durationMs)));
  return true;
}

function setNowPlaying(cell) {
  // The playing track is about to change. Invalidate any in-flight fine-cue
  // action (so it can't seek the wrong track) and put away a stale slider.
  cueFineGen++;
  hideCueFine();
  document.querySelectorAll(".cell.playing").forEach(c => {
    c.classList.remove("playing");
    c.classList.remove("paused");
  });
  const np = document.getElementById("nowplaying");
  if (!cell) {
    nowPlaying = null;
    playingSnapshot = null;
    clearTimeout(stopDeadlineTimer);
    clearTimeout(manualStopTimer);
    clearTimeout(reconcileTimer);
    stopDeadlineKey = null;
    np.classList.add("hidden");
    showVolRail(false);
    setBallSpin(false);
    updateDeleteButtons();
    stopProgress();
    return;
  }
  cell.classList.add("playing");
  playingSnapshot = { ...cell.dataset };
  nowPlaying = { uuid: cell.dataset.pbuuid, paused: false };
  refreshPlayingSnapshot();
  document.getElementById("np-title").textContent = cell.querySelector(".title").textContent;
  document.getElementById("np-sub").textContent = cell.querySelector(".meta").textContent;
  np.classList.remove("hidden");
  updateVolumeControls();
  volRailLastSent = null;   // new song = fresh device volume; don't dedup against the old one
  syncVolRail(cellEffectiveVolumePct(nowPlaying.uuid));
  updatePauseBtn();
  updateSwatchActive();
  updateDeleteButtons();
  startProgress(cell);
  scheduleReconciliation();
}

// =====================================================================
// Local-only playback progress bar (no API polling)
// =====================================================================
function startProgress(cell) {
  stopProgress();
  const startOffsetMs = parseInt(cell.dataset.startms || "0", 10);
  const durationMs    = parseInt(cell.dataset.duration || "0", 10);
  progress = {
    startOffsetMs,
    durationMs,
    baseTime: performance.now(),
    elapsedAtPause: 0,
    paused: false,
    stopFiring: false,   // becomes true once the end-cue fade-out has been armed
    stopAttempted: false,
  };
  document.getElementById("np-progress").classList.remove("hidden");
  document.getElementById("np-time-end").textContent = fmtTime(durationMs / 1000);
  document.getElementById("np-time-cur").textContent = fmtTime(startOffsetMs / 1000);
  scheduleProgressTick();
  armStopDeadline();
}
function pauseProgress() {
  if (!progress || progress.paused) return;
  progress.elapsedAtPause += performance.now() - progress.baseTime;
  progress.paused = true;
  armStopDeadline();
  if (progressRaf) cancelAnimationFrame(progressRaf);
  progressRaf = null;
  renderProgress();
}
function resumeProgress() {
  if (!progress || !progress.paused) return;
  progress.baseTime = performance.now();
  progress.paused = false;
  progress.stopFiring = false;   // allow end-cue enforcement to re-arm after a pause
  progress.stopAttempted = false;
  armStopDeadline();
  scheduleProgressTick();
}
function stopProgress() {
  if (progressRaf) cancelAnimationFrame(progressRaf);
  progressRaf = null;
  progress = null;
  const p = document.getElementById("np-progress");
  if (p) p.classList.add("hidden");
}
function scheduleProgressTick() {
  if (progressRaf) cancelAnimationFrame(progressRaf);
  const tick = () => {
    renderProgress();
    if (progress && !progress.paused && (!progress.durationMs || currentPositionMs() < progress.durationMs)) {
      progressRaf = requestAnimationFrame(tick);
    }
  };
  progressRaf = requestAnimationFrame(tick);
}
function renderProgress() {
  if (!progress) return;
  const elapsed = progress.elapsedAtPause + (progress.paused ? 0 : performance.now() - progress.baseTime);
  const positionMs = progress.startOffsetMs + elapsed;
  const total = progress.durationMs || 0;
  const pct = total > 0 ? Math.max(0, Math.min(100, (positionMs / total) * 100)) : 0;
  // Don't fight a drag in progress
  if (dragTarget !== "dot") {
    document.getElementById("np-bar-fill").style.width = pct + "%";
    document.getElementById("np-bar-dot").style.left = pct + "%";
    document.getElementById("np-time-cur").textContent = fmtTime(positionMs / 1000);
  }
  // "m:ss left" countdown to the effective end of the song. The effective end is
  // the stop cue when one is set earlier than the track's end, otherwise the
  // track's natural duration. It turns amber in the final few seconds so the
  // operator can see a song is about to finish.
  {
    const remEl = document.getElementById("np-remaining");
    if (remEl) {
      const stopMs = nowPlaying ? effectiveStopMs(nowPlaying.uuid) : 0;
      const endMs = (stopMs > 0 && total > 0 && stopMs < total) ? stopMs : total;
      if (endMs > 0) {
        const leftMs = Math.max(0, endMs - positionMs);
        const leftSec = Math.ceil(leftMs / 1000);
        remEl.textContent = `${Math.floor(leftSec / 60)}:${String(leftSec % 60).padStart(2, "0")} left`;
        remEl.classList.toggle("ending", leftMs <= 5000);
      } else {
        remEl.textContent = "";
        remEl.classList.remove("ending");
      }
    }
  }
  if (dragTarget !== "caret") {
    const caretMs = effectiveStartMs();
    const caretPct = total > 0 ? Math.max(0, Math.min(100, (caretMs / total) * 100)) : 0;
    document.getElementById("np-bar-caret").style.left = caretPct + "%";
  }
  // Position the end-cue marker (or hide it when no stop is set / no track).
  if (dragTarget !== "stop") {
    const stopEl = document.getElementById("np-bar-stop");
    if (stopEl) {
      const stopMs = nowPlaying ? effectiveStopMs(nowPlaying.uuid) : 0;
      if (stopMs > 0 && total > 0 && stopMs < total) {
        stopEl.style.display = "block";
        stopEl.style.left = Math.max(0, Math.min(100, (stopMs / total) * 100)) + "%";
      } else {
        stopEl.style.display = "none";
      }
    }
  }
  armStopDeadline();
  for (const [id, value] of [["np-bar-dot", positionMs], ["np-bar-caret", effectiveStartMs()], ["np-bar-stop", effectiveStopMs(nowPlaying?.uuid)]]) {
    const marker = document.getElementById(id);
    marker.setAttribute("aria-valuemin", "0");
    marker.setAttribute("aria-valuemax", String(total));
    marker.setAttribute("aria-valuenow", String(Math.max(0, Math.min(total, Math.round(value)))));
    marker.setAttribute("aria-valuetext", fmtTime(Math.max(0, value) / 1000));
  }
  // The fade is optional; a separate deadline owns the mandatory pause.
  if (nowPlaying && progress && !progress.paused && !progress.stopFiring) {
    const stopMs = effectiveStopMs(nowPlaying.uuid);
    // Only enforce a stop that lands strictly before the end of the track. A stop
    // at (or beyond) the track's duration means "play all the way through".
    if (stopMs > 0 && total > 0 && stopMs < total) {
      const fadeMs = Math.max(0, effectiveFadeOutSec(null) * 1000);
      if (positionMs >= stopMs - fadeMs) {
        progress.stopFiring = true;
        const fromPct = cellEffectiveVolumePct(nowPlaying.uuid);
        const remaining = Math.max(0, stopMs - positionMs);
        if (fadeMs > 0 && canControlVolume()) doFade(fromPct, 0, remaining);
      }
    }
  }
  if (total > 0 && positionMs >= total) {
    // Track ended (per local clock); freeze at end and stop ticking
    if (dragTarget !== "dot") {
      document.getElementById("np-bar-fill").style.width = "100%";
      document.getElementById("np-bar-dot").style.left = "100%";
    }
    if (progressRaf) cancelAnimationFrame(progressRaf);
    progressRaf = null;
  }
}

// Current playback position in ms (local clock)
function currentPositionMs() {
  if (!progress) return 0;
  const elapsed = progress.elapsedAtPause + (progress.paused ? 0 : performance.now() - progress.baseTime);
  return progress.startOffsetMs + elapsed;
}

// Effective start time in ms for the currently-playing cell — pending override, else original cell.dataset.startms
function effectiveStartMs() {
  if (!nowPlaying) return 0;
  if (pending.starts[nowPlaying.uuid] !== undefined) return pending.starts[nowPlaying.uuid];
  return Number(playingSnapshot?.startms || 0);
}

// Effective stop time in ms for a cell — pending override, else cell.dataset.stopms.
// A value of 0 means "no stop set" (the database never stores 0 here).
function effectiveStopMs(uuid) {
  if (!uuid) return 0;
  if (pending.stops[uuid] !== undefined) return pending.stops[uuid];
  if (nowPlaying?.uuid === uuid) return Number(playingSnapshot?.stopms || 0);
  if (db) return originalStopMs(uuid);
  return 0;
}

function refreshPlayingSnapshot() {
  if (!nowPlaying || !db) return;
  const rows = queryAll(`SELECT fadeOutSeconds AS fadeout, volume,
    (COALESCE(startAtSeconds,0)+COALESCE(startAtSubSec,0))*1000 AS startms,
    (COALESCE(stopAtSeconds,0)+COALESCE(stopAtSubSec,0))*1000 AS stopms
    FROM Playback WHERE playbackUUIDRaw=?`, [nowPlaying.uuid]);
  if (rows.length && playingSnapshot) Object.assign(playingSnapshot, rows[0]);
  armStopDeadline();
}

// Original stop in ms from the DB (ignores pending). Used to detect a no-op revert.
function originalStopMs(pbUUID) {
  const r = queryAll(
    "SELECT stopAtSeconds AS s, stopAtSubSec AS sub FROM Playback WHERE playbackUUIDRaw=?",
    [pbUUID]
  );
  if (!r.length) return 0;
  return Math.round((r[0].s || 0) * 1000 + (r[0].sub || 0) * 1000);
}

// Record/clear a pending stop-time override for a cell, mirroring setPendingStart.
// exact=true stores the value verbatim (used by the fine slider); otherwise a
// value within 250ms of the DB original is treated as "put it back" and cleared.
function setPendingStop(pbUUID, ms, exact) {
  if (!prepareDatabaseEdit()) return;
  ms = Math.max(0, Math.round(ms));
  const cell = document.querySelector(`.cell[data-pbuuid="${pbUUID}"]`);
  const orig = originalStopMs(pbUUID);
  if (exact ? (ms === orig) : (Math.abs(ms - orig) < 250)) {
    delete pending.stops[pbUUID];
    if (cell) cell.dataset.stopms = String(orig);
  } else {
    pending.stops[pbUUID] = ms;
  }
  savePending();
  if (cell) applyPendingToCell(cell);
}

// Original start in ms from the DB (ignores pending). Used to detect a no-op revert.
function originalStartMs(pbUUID) {
  const r = queryAll(
    "SELECT startAtSeconds AS s, startAtSubSec AS sub FROM Playback WHERE playbackUUIDRaw=?",
    [pbUUID]
  );
  if (!r.length) return 0;
  return Math.round((r[0].s || 0) * 1000 + (r[0].sub || 0) * 1000);
}

// Seek the player to positionMs and resync local progress. callApi=false skips the network call (used while dragging).
async function seekTo(positionMs, callApi) {
  if (!progress) return false;
  positionMs = Math.max(0, Math.min(progress.durationMs || positionMs, Math.round(positionMs)));
  const observed = progress;
  const updateClock = () => {
    if (progress !== observed) return;
    progress.startOffsetMs = positionMs;
    progress.elapsedAtPause = 0;
    progress.baseTime = performance.now();
    progress.stopFiring = false;
    progress.stopAttempted = false;
    if (!progress.paused) scheduleProgressTick();
    armStopDeadline();
    renderProgress();
  };
  if (!callApi) { updateClock(); return true; }
  if (transportPending && transportIntentKind !== "Seek") {
    showToast("Wait for the pending playback command before seeking.");
    return false;
  }
  return queueTransport("Seek", async current => {
    if (nowPlaying?.disallows?.seeking) throw new Error("Spotify currently disallows seeking this item.");
    if (progress?.stopFiring && nowPlaying && canControlVolume()) {
      await sendVolume(cellEffectiveVolumePct(nowPlaying.uuid));
    }
    if (!current()) return;
    await api(`/me/player/seek?position_ms=${positionMs}`, { method: "PUT" });
    if (current()) updateClock();
  }, () => seekTo(positionMs, true));
}

// Set/clear a pending start-time override for a cell.
// Pass exact=true to save the value verbatim (used by the fine-cue slider).
// Without it, a value within 250ms of the track's original DB start is treated
// as "you basically put it back where it was", so the override is cleared. That
// rough-snap is handy for the caret but would throw away the small, deliberate
// nudges the fine slider exists to make — hence the bypass.
function setPendingStart(pbUUID, ms, exact) {
  if (!prepareDatabaseEdit()) return;
  ms = Math.max(0, Math.round(ms));
  const cell = document.querySelector(`.cell[data-pbuuid="${pbUUID}"]`);
  const orig = originalStartMs(pbUUID);
  // Exact-but-equal-to-original still clears the override (no point storing a
  // pending value identical to what's already in the database).
  if (exact ? (ms === orig) : (Math.abs(ms - orig) < 250)) {
    delete pending.starts[pbUUID];
  } else {
    pending.starts[pbUUID] = ms;
  }
  savePending();
  if (cell) applyPendingToCell(cell);
}

// =====================================================================
// Progress bar pointer interactions (click / drag dot / drag caret)
// =====================================================================
function setBarFocused(which) {
  barFocused = which;
  document.getElementById("np-bar-dot").classList.toggle("focused", which === "dot");
  document.getElementById("np-bar-caret").classList.toggle("focused", which === "caret");
  const stopEl = document.getElementById("np-bar-stop");
  if (stopEl) stopEl.classList.toggle("focused", which === "stop");
}

function barPctFromClientX(clientX) {
  const r = document.getElementById("np-bar").getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
}

// Leading+trailing throttle for slider drags. A fast drag streams an `input`
// event per notch; without this each one would fire a Spotify request (a /seek
// for the cue slider, a /volume for the volume slider), flooding the API and
// stuttering playback. `run` applies the first value immediately, then at most
// once per `ms` while values keep arriving (the latest wins). `flush` cancels
// the cool-down and applies a final value right away — used on 'change' so the
// settled position is always the last thing sent.
const SLIDER_THROTTLE_MS = 120;
function makeSliderThrottle(fn, ms) {
  let timer = null;
  const NONE = Symbol("none");
  let pending = NONE;
  const arm = () => {
    timer = setTimeout(() => {
      timer = null;
      if (pending !== NONE) {
        const v = pending; pending = NONE;
        fn(v);
        arm();                              // keep throttling while values still flow
      }
    }, ms);
  };
  return {
    run(arg) {
      if (timer) { pending = arg; return; } // inside cool-down: remember latest only
      fn(arg);                              // leading edge
      arm();
    },
    flush(arg) {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = NONE;
      fn(arg);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = NONE;
    },
  };
}

function setupBarInteractions() {
  const bar   = document.getElementById("np-bar");
  const dot   = document.getElementById("np-bar-dot");
  const caret = document.getElementById("np-bar-caret");
  const stop  = document.getElementById("np-bar-stop");
  for (const [marker, kind] of [[dot, "dot"], [caret, "caret"], [stop, "stop"]]) {
    marker.addEventListener("focus", () => setBarFocused(kind));
  }

  const onPointerDown = (e) => {
    if (!progress) return;
    const onDot   = dot.contains(e.target);
    const onCaret = caret.contains(e.target);
    const onStop  = stop.contains(e.target);
    if (onDot || onCaret || onStop) {
      e.preventDefault();
      dragTarget = onDot ? "dot" : (onCaret ? "caret" : "stop");
      setBarFocused(dragTarget);
      bar.setPointerCapture(e.pointerId);
      return;
    }
    // Click on the bar surface (not on a marker) → select dot and seek there
    e.preventDefault();
    setBarFocused("dot");
    const pct = barPctFromClientX(e.clientX);
    seekTo(pct * progress.durationMs, true);
  };

  const onPointerMove = (e) => {
    if (!dragTarget || !progress) return;
    const pct = barPctFromClientX(e.clientX);
    const ms  = pct * progress.durationMs;
    if (dragTarget === "dot") {
      // Provisional visuals only; commit on pointerup
      document.getElementById("np-bar-fill").style.width = (pct * 100) + "%";
      dot.style.left = (pct * 100) + "%";
      document.getElementById("np-time-cur").textContent = fmtTime(ms / 1000);
    } else if (dragTarget === "caret") {
      caret.style.left = (pct * 100) + "%";
    } else if (dragTarget === "stop") {
      stop.style.display = "block";
      stop.style.left = (pct * 100) + "%";
    }
  };

  const onPointerUp = async (e) => {
    if (!dragTarget || !progress) return;
    const kind = dragTarget;
    dragTarget = null;
    const pct = barPctFromClientX(e.clientX);
    const ms  = pct * progress.durationMs;
    if (kind === "dot") {
      await seekTo(ms, true);
    } else if (kind === "caret" && nowPlaying) {
      setPendingStart(nowPlaying.uuid, ms);
      // Restart playback at the new start so user can hear it
      if (nowPlaying.paused) {
        await resumePlayback();
      }
      await seekTo(ms, true);
      // Pop up the fine-nudge slider, centred on this freshly-set cue point.
      showCueFine(ms, "start");
    } else if (kind === "stop" && nowPlaying) {
      await setStopFromBar(ms);
    }
  };

  bar.addEventListener("pointerdown", onPointerDown);
  bar.addEventListener("pointermove", onPointerMove);
  bar.addEventListener("pointerup",   onPointerUp);
  bar.addEventListener("pointercancel", () => { dragTarget = null; });

  // Right-click (mouse) sets the end cue at that spot — unless you right-click the
  // marker itself, which clears the end cue (back to playing through to the end).
  bar.addEventListener("contextmenu", (e) => {
    if (!progress || !nowPlaying) return;
    e.preventDefault();
    if (e.target === stop) { clearEndCue(); return; }
    setStopFromBar(barPctFromClientX(e.clientX) * progress.durationMs);
  });
  // Touch long-press does the same thing (mouse is ignored inside bindLongPress).
  // Skip it when a marker is being dragged so holding a marker can't also set a cue.
  bindLongPress(bar, (clientX) => {
    if (!progress || !nowPlaying || dragTarget) return;
    setStopFromBar(barPctFromClientX(clientX) * progress.durationMs);
  });

  // --- Fine cue-nudge slider wiring ---
  const fine = document.getElementById("np-cue-fine-slider");
  if (fine) {
    // Throttle the live re-cue: 'input' fires once per 50ms notch, but each cue
    // change is a Spotify /seek, so a quick drag would spam the API and stutter.
    const fineThrottle = makeSliderThrottle((v) => applyCueFine(v), SLIDER_THROTTLE_MS);
    fine.addEventListener("input",  () => { bumpCueFineHide(); fineThrottle.run(parseInt(fine.value, 10)); });
    // 'change' fires when the drag/keypress settles. Flushing the final value
    // guarantees the last position wins even if rapid in-flight seeks from the
    // live drag happened to reach Spotify out of order.
    fine.addEventListener("change", () => { bumpCueFineHide(); fineThrottle.flush(parseInt(fine.value, 10)); });
    // Any touch of the slider keeps it on screen.
    fine.addEventListener("focus",       bumpCueFineHide);
    fine.addEventListener("pointerdown", bumpCueFineHide);
    fine.addEventListener("keydown",     bumpCueFineHide);
  }

  // --- Per-track volume slider wiring (same panel, same auto-hide timer) ---
  const vol = document.getElementById("np-vol-slider");
  if (vol) {
    // Same story as the cue slider: each notch is a Spotify /volume PUT, so a
    // drag is throttled and the settled value is flushed on 'change'.
    volumeFineThrottle = makeSliderThrottle((v) => applyVolumeFine(v), SLIDER_THROTTLE_MS);
    vol.addEventListener("input", () => {
      if (!canControlVolume()) return;
      bumpCueFineHide(); volumeFineThrottle.run(parseInt(vol.value, 10));
    });
    vol.addEventListener("change", () => {
      if (!canControlVolume()) return;
      bumpCueFineHide(); volumeFineThrottle.flush(parseInt(vol.value, 10));
    });
    vol.addEventListener("focus",       bumpCueFineHide);
    vol.addEventListener("pointerdown", bumpCueFineHide);
    vol.addEventListener("keydown",     bumpCueFineHide);
  }
}

// =====================================================================
// Fine cue-nudge slider
// ---------------------------------------------------------------------
// Whenever you move a track's start point with the red caret, this small slider
// pops up centred on 0. Nudging it shifts the cue point by up to two seconds in
// either direction, in 50ms (one-twentieth of a second) notches. Every nudge
// does two things at once:
//   1. it re-cues the track so you immediately hear the new starting point, and
//   2. it saves that exact point as this button's start time, so it sticks.
// The slider quietly disappears a few seconds after you stop fiddling with it
// (unless it still has keyboard focus, in which case it politely waits).
// =====================================================================
const CUE_FINE_HIDE_MS = 4000; // how long the slider lingers after your last interaction

// Format an absolute time in milliseconds as m:ss.cc (cc = hundredths of a second).
function fmtTimeCc(ms) {
  ms = Math.max(0, Math.round(ms));
  const totalCs = Math.round(ms / 10);            // total hundredths of a second
  const m  = Math.floor(totalCs / 6000);
  const s  = Math.floor((totalCs % 6000) / 100);
  const cc = totalCs % 100;
  return `${m}:${s.toString().padStart(2, "0")}.${cc.toString().padStart(2, "0")}`;
}

// Cancel any pending auto-hide and restart the countdown from now.
function bumpCueFineHide() {
  if (cueFineHideTimer) clearTimeout(cueFineHideTimer);
  cueFineHideTimer = setTimeout(hideCueFine, CUE_FINE_HIDE_MS);
}

// Put the slider away. If it currently holds keyboard focus we wait another
// round instead, so it never vanishes out from under someone mid-adjustment.
function hideCueFine() {
  const active = document.activeElement;
  const cue = document.getElementById("np-cue-fine-slider");
  const vol = document.getElementById("np-vol-slider");
  if (active && (active === cue || active === vol)) { bumpCueFineHide(); return; }
  if (cueFineHideTimer) { clearTimeout(cueFineHideTimer); cueFineHideTimer = null; }
  const wrap = document.getElementById("np-cue-fine");
  if (wrap) wrap.classList.add("hidden");
}

// Refresh the text + screen-reader description beside the slider. We show the
// REAL (clamped) offset and the resulting cue time, so the label stays honest
// even when we bump up against the start or end of the track.
function updateCueFineLabel(offsetMs, targetMs) {
  const sign = offsetMs < 0 ? "−" : "+";
  const prefix = (cueFineMode === "stop") ? "End " : "";
  const text = `${prefix}${sign}${Math.abs(offsetMs / 1000).toFixed(2)}s \u2192 ${fmtTimeCc(targetMs)}`;
  const label  = document.getElementById("np-cue-fine-label");
  const slider = document.getElementById("np-cue-fine-slider");
  if (label)  label.textContent = text;
  if (slider) slider.setAttribute("aria-valuetext", text);
}

// Set the end cue from a bar position (right-click, long-press, or stop-drag).
// Stores the pending stop, makes sure we're playing, and jumps to 4 seconds
// before the stop so you immediately hear how the ending will sound. Then pops
// the fine slider (in "stop" mode) so you can nudge the exact end point.
async function setStopFromBar(ms) {
  if (!nowPlaying || !progress) return;
  const uuid = nowPlaying.uuid;
  setPendingStop(uuid, ms);
  if (nowPlaying.paused) await resumePlayback();
  if (!nowPlaying || nowPlaying.uuid !== uuid) return;
  // Pre-roll: start 4s before the end cue (clamped to the track's start).
  await seekTo(Math.max(0, ms - 4000), true);
  showCueFine(ms, "stop");
}

// Remove a track's end cue so it plays through to the end. We do this by storing
// a pending stop equal to the track's duration, which our enforcement treats as
// "no early stop" (and the marker hides itself).
function clearEndCue() {
  if (!nowPlaying || !progress) return;
  setPendingStop(nowPlaying.uuid, progress.durationMs || 0, true);
  if (progress.stopFiring) { cancelFade(); progress.stopFiring = false; }
  armStopDeadline();
}

// Pop the slider up, centred (value 0) on the given absolute cue point in ms.
// The base stays fixed while the slider is open; changing the caret again later
// re-pops and re-centres it on the new point. `mode` is "start" (default) or
// "stop", which decides whether the slider edits the start caret or the end cue.
function showCueFine(baseMs, mode) {
  if (!progress) return;
  cueFineMode = (mode === "stop") ? "stop" : "start";
  const dur = progress.durationMs || 0;
  cueFineBaseMs = Math.max(0, dur ? Math.min(dur, Math.round(baseMs)) : Math.round(baseMs));
  cueFineLastSeek = null;   // fresh open: nothing seeked yet, so the first nudge always applies
  const wrap   = document.getElementById("np-cue-fine");
  const slider = document.getElementById("np-cue-fine-slider");
  if (!wrap || !slider) return;
  slider.value = "0";
  updateCueFineLabel(0, cueFineBaseMs);
  // Seed the volume slider with this track's current effective volume.
  const vslider = document.getElementById("np-vol-slider");
  if (vslider) {
    const pct = cellEffectiveVolumePct(nowPlaying ? nowPlaying.uuid : null);
    vslider.value = String(pct);
    updateVolLabel(pct);
  }
  updateVolumeControls();
  wrap.classList.remove("hidden");
  bumpCueFineHide();
}

// Apply the slider's current offset (in ms, relative to cueFineBaseMs): save the
// new start time and re-cue the track so the new point plays immediately.
async function applyCueFine(offsetMs) {
  if (!nowPlaying || !progress) return;
  const uuid = nowPlaying.uuid;
  const gen  = cueFineGen;                          // snapshot: detect a track switch mid-flight
  const dur  = progress.durationMs || 0;
  const target = Math.max(0, dur ? Math.min(dur, cueFineBaseMs + offsetMs)
                                 : cueFineBaseMs + offsetMs);
  updateCueFineLabel(target - cueFineBaseMs, target);
  // De-dupe: the slider fires BOTH "input" (live, as it moves) and "change"
  // (when it settles), and the two always end on the same value. Without this
  // guard that final value would be seeked twice in quick succession, which the
  // user hears as the song restarting at the same spot twice. We still always
  // save the pending value (cheap + idempotent); we only skip the redundant
  // audible re-cue when nothing actually changed since the last seek.
  const seekKey = `${cueFineMode}:${target}`;
  const isDuplicate = (seekKey === cueFineLastSeek);
  if (cueFineMode === "stop") {
    // Editing the end cue: save the new stop point, then jump to 4s before it so
    // the ending plays for preview. Enforcement (in renderProgress) handles the
    // actual fade-out/pause when the clock reaches the stop.
    setPendingStop(uuid, target, true);
    if (isDuplicate) return;
    cueFineLastSeek = seekKey;
    if (cueFineGen !== gen || !nowPlaying || nowPlaying.uuid !== uuid) return;
    if (nowPlaying.paused) await resumePlayback();
    if (cueFineGen !== gen || !nowPlaying || nowPlaying.uuid !== uuid) return;
    await seekTo(Math.max(0, target - 4000), true);
    return;
  }
  // Save first (exact=true keeps even tiny nudges). This persists regardless of
  // whether the audible seek below succeeds.
  setPendingStart(uuid, target, true);
  if (isDuplicate) return;
  cueFineLastSeek = seekKey;
  // If the track changed while we were saving, don't touch the player — the
  // saved value still belongs to the right button.
  if (cueFineGen !== gen || !nowPlaying || nowPlaying.uuid !== uuid) return;
  if (nowPlaying.paused) await resumePlayback();
  if (cueFineGen !== gen || !nowPlaying || nowPlaying.uuid !== uuid) return;
  await seekTo(target, true);
}

// =====================================================================
// Per-track volume slider (lives in the same pop-up panel as the fine cue)
// ---------------------------------------------------------------------
// Each tile can either follow the global default volume (stored as the -1
// sentinel in the database) or carry its own 0..1 volume. The slider shows the
// effective percentage; while that equals the Settings default we tag it
// "[Default]" and keep the tile on the inherit-the-default setting. Nudging it
// to any other value gives the tile its own volume. Changes are pending edits,
// written to the database's volume column when you Save.
// =====================================================================

// The raw stored volume for a tile: pending override first, then the value the
// cell carries from the database. Negative / missing means "inherit default".
function cellRawVolume(uuid) {
  if (!uuid) return -1;
  if (pending.volumes[uuid] !== undefined) return pending.volumes[uuid];
  if (nowPlaying?.uuid === uuid && playingSnapshot) return Number(playingSnapshot.volume ?? -1);
  if (db) return originalRawVolume(uuid);
  return -1;
}

// The tile's effective volume as a 0..100 percentage (resolving the -1 sentinel
// to the current Settings default).
function cellEffectiveVolumePct(uuid) {
  const raw = cellRawVolume(uuid);
  if (raw == null || raw < 0) return getDefaultVolumePct();
  return Math.round(raw * 100);
}

// The volume stored in the database for a tile (ignores pending). Used to tell
// whether a pending change is really a change or just a revert.
function originalRawVolume(pbUUID) {
  const r = queryAll("SELECT volume AS v FROM Playback WHERE playbackUUIDRaw=?", [pbUUID]);
  if (!r.length || r[0].v == null) return -1;
  return r[0].v;
}

// Record a pending volume for a tile. raw is either -1 (inherit default) or a
// 0..1 fraction. If it ends up matching what's already in the database we drop
// the pending entry instead of storing a no-op.
function setPendingVolume(pbUUID, raw) {
  if (!prepareDatabaseEdit()) return;
  const cell = document.querySelector(`.cell[data-pbuuid="${pbUUID}"]`);
  const orig = originalRawVolume(pbUUID);
  const sameInherit = raw < 0 && orig < 0;
  const sameExplicit = raw >= 0 && orig >= 0 && Math.abs(raw - orig) < 0.005;
  if (sameInherit || sameExplicit) {
    delete pending.volumes[pbUUID];
    // Reverting to the database value: restore the cell's dataset to that value
    // too, otherwise it would keep the last pending number and the wrong volume
    // would play. (applyPendingToCell only writes dataset.volume when a pending
    // entry exists, so it can't undo this on its own.)
    if (cell) cell.dataset.volume = String(orig);
  } else {
    pending.volumes[pbUUID] = raw;
  }
  savePending();
  if (cell) applyPendingToCell(cell);
}

// Refresh the volume slider's label. The "[Default]" marker appears whenever the
// chosen percentage equals the Settings default.
function updateVolLabel(pct) {
  const isDefault = pct === getDefaultVolumePct();
  const text = `\u{1F50A} ${pct}%${isDefault ? " [Default]" : ""}`;
  const label  = document.getElementById("np-vol-label");
  const slider = document.getElementById("np-vol-slider");
  if (label) {
    // Build with a dedicated span for the speaker emoji so CSS can enlarge just
    // the icon. Numeric text uses a text node (no markup injection).
    label.innerHTML = "";
    const icon = document.createElement("span");
    icon.className = "vol-emoji";
    icon.textContent = "\u{1F50A}";
    label.appendChild(icon);
    label.appendChild(document.createTextNode(` ${pct}%${isDefault ? " [Default]" : ""}`));
  }
  if (slider) slider.setAttribute("aria-valuetext", text);
}

// Apply the volume slider's value: store it as this tile's volume (or back to
// "inherit default" when it lands exactly on the default) and preview it live so
// you can hear the change on the currently-playing track.
function applyVolumeFine(pct) {
  if (!nowPlaying || !canControlVolume()) return;
  if (!Number.isFinite(pct)) return;
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  const def = getDefaultVolumePct();
  const raw = (pct === def) ? -1 : (pct / 100);
  setPendingVolume(nowPlaying.uuid, raw);
  updateVolLabel(pct);
  cancelFade();          // don't let a running fade fight the manual change
  setVolume(pct);        // live preview
  syncVolRail(pct);      // keep the right-edge rail in step with the footer slider
}

// =====================================================================
// Master volume rail (right-edge vertical fader for the playing song)
// ---------------------------------------------------------------------
// Live-only by design: moving the rail changes the device volume the moment you
// let go of the thumb (never mid-drag, to spare the Spotify API). It does NOT
// persist that level to the song on its own — the 💾 button does that, recording
// it as a pending edit that the global Save writes back to the database file.
// =====================================================================

// Show or hide the rail and reserve grid space for it.
function showVolRail(show) {
  const rail = document.getElementById("vol-rail");
  if (!rail) return;
  show = !!show && canControlVolume();
  rail.classList.toggle("hidden", !show);
  document.body.classList.toggle("vol-open", show);
}

function updateVolumeControls() {
  const available = canControlVolume();
  const focused = document.activeElement;
  const ids = ["vol-rail-slider", "vol-save", "vol-mute", "np-vol-slider", "in-volume", "in-fade-in", "in-fade-out"];
  for (const id of ids) {
    const control = document.getElementById(id);
    if (control) control.disabled = !available;
  }
  document.getElementById("np-volume-row")?.classList.toggle("hidden", !available);
  document.getElementById("volume-support-hint")?.classList.toggle("hidden", available);
  if (!available) {
    volumeSequence++;
    cancelFade();
    clearTimeout(volRailSettleTimer);
    volRailSettleTimer = null;
    volumeFineThrottle?.cancel();
    if (ids.includes(focused?.id)) {
      const target = focused.closest("#modal") ? "btn-close-modal" : nowPlaying ? "np-pause" : "btn-settings";
      document.getElementById(target)?.focus({ preventScroll: true });
    }
  }
  showVolRail(!!nowPlaying);
}

// Point the rail's slider + label at a percentage WITHOUT calling the API.
// Used when a song starts and whenever the footer slider or the Settings default
// moves the volume, so the two controls never disagree. (Setting .value
// programmatically does not fire input/change, so this can't loop back on us.)
function syncVolRail(pct) {
  const slider = document.getElementById("vol-rail-slider");
  const label  = document.getElementById("vol-rail-label");
  // The rail moves in 5% steps, so snap the displayed value to the nearest notch
  // and keep the slider thumb and the label showing the same number.
  const snapped = Math.max(0, Math.min(100, Math.round(pct / 5) * 5));
  if (slider) slider.value = String(snapped);
  if (label)  label.textContent = `${snapped}%`;
  updateVolRailThumb(snapped);
  if (snapped > 0) volRailPreMute = snapped;   // remember the level to restore on unmute
  refreshMuteIcon(snapped);
}

// Gray the thumb while the rail sits on the default volume notch; green otherwise.
function updateVolRailThumb(pct) {
  const slider = document.getElementById("vol-rail-slider");
  if (!slider) return;
  const def = Math.round(getDefaultVolumePct() / 5) * 5;   // default snapped to the rail's 5% grid
  slider.classList.toggle("is-default", pct === def);
}

// The bottom button shows a muted speaker at 0%, a normal speaker otherwise.
function refreshMuteIcon(pct) {
  const btn = document.getElementById("vol-mute");
  if (btn) btn.textContent = (pct === 0) ? "\u{1F507}" : "\u{1F50A}";
}

// The most recent non-zero rail level — what the mute button restores to.
let volRailPreMute = null;

// While dragging, we don't send a volume command on every notch. Instead we wait
// for the thumb to settle: if it stays on the same level for this long, we apply
// that level. Releasing the thumb applies immediately. This keeps the rail
// responsive without flooding the Spotify API.
const VOL_RAIL_SETTLE_MS = 250;
let volRailSettleTimer = null;
let volRailLastSent = null;

// Apply a rail level to the live device volume (no persist), guarding on a song
// being loaded and skipping redundant repeats of the last sent level.
function applyRailVolumeLive(pct) {
  if (!nowPlaying || !canControlVolume()) return;
  if (pct === volRailLastSent) return;
  cancelFade();      // don't let a running fade fight the manual change
  void setVolume(pct).then(ok => { if (ok && nowPlaying) volRailLastSent = pct; });
}

// Wire the rail's slider + save button (called once at startup).
function wireVolRail() {
  const slider = document.getElementById("vol-rail-slider");
  const save   = document.getElementById("vol-save");
  if (slider) {
    // Dragging updates the label immediately and arms a short settle timer: if the
    // thumb stays on this level for VOL_RAIL_SETTLE_MS, that level is applied live.
    slider.addEventListener("input", () => {
      if (!canControlVolume()) return;
      const pct = parseInt(slider.value, 10);
      const label = document.getElementById("vol-rail-label");
      if (label) label.textContent = `${pct}%`;
      updateVolRailThumb(pct);
      if (pct > 0) volRailPreMute = pct;   // keep the restore level current as you drag
      refreshMuteIcon(pct);
      if (volRailSettleTimer) clearTimeout(volRailSettleTimer);
      volRailSettleTimer = setTimeout(() => applyRailVolumeLive(pct), VOL_RAIL_SETTLE_MS);
    });
    // Releasing the thumb (change) applies the level immediately — not saved.
    slider.addEventListener("change", () => {
      if (!canControlVolume()) return;
      if (volRailSettleTimer) { clearTimeout(volRailSettleTimer); volRailSettleTimer = null; }
      applyRailVolumeLive(Math.max(0, Math.min(100, parseInt(slider.value, 10))));
    });
  }
  if (save) {
    // 💾 — persist the rail's current level as THIS song's volume. Reuses the
    // footer slider's pending-edit path (applyVolumeFine), so it shows up in the
    // global Save badge and is written to the file on the next Save/export.
    save.onclick = () => {
      if (!canControlVolume()) return;
      if (!nowPlaying) { showToast("Play a song first."); return; }
      const pct = Math.max(0, Math.min(100, parseInt(slider.value, 10)));
      applyVolumeFine(pct);   // records pending volume + previews live + updates footer label
      const fslider = document.getElementById("np-vol-slider");
      if (fslider) fslider.value = String(pct);
      syncVolRail(pct);
      showToast(`Saved ${pct}% as this song's volume.`);
    };
  }
  const mute = document.getElementById("vol-mute");
  if (mute) {
    // 🔊/🔇 — toggle mute. Muting drops the rail to 0; clicking again restores the
    // level it was at before (live-only, like dragging — it doesn't change the
    // song's saved volume).
    mute.onclick = () => {
      if (!canControlVolume()) return;
      if (!nowPlaying) { showToast("Play a song first."); return; }
      const cur = Math.max(0, Math.min(100, parseInt(slider.value, 10)));
      const target = (cur > 0) ? 0 : (volRailPreMute || Math.round(getDefaultVolumePct() / 5) * 5);
      syncVolRail(target);            // updates slider, label, thumb and the mute icon
      applyRailVolumeLive(target);    // send the new level live
    };
  }
}

// =====================================================================
// Pending edits (deferred-write model)
// =====================================================================
function loadPending() {
  const saved = localStorage.getItem(LS_PENDING);
  legacyPending = saved ? normalizePending(JSON.parse(saved)) : null;
}
function savePending() {
  workingRevision++;
  updateSaveBadge();
  if (db && !erasingBrowser) void persistDbToIdb();
  if (nowPlaying) refreshPlayingSnapshot();
}
function pendingCount() {
  return Object.keys(pending.colors).length + pending.deletes.length + Object.keys(pending.moves).length + Object.keys(pending.starts).length + Object.keys(pending.stops).length + Object.keys(pending.volumes).length + Object.keys(pending.hotkeys).length + (pending.tabOps || 0);
}
function updateSaveBadge() {
  const n = pendingCount();
  const b = document.getElementById("btn-save");
  const badge = document.getElementById("save-badge");
  badge.textContent = String(n);
  b.classList.toggle("has-changes", n > 0);
  b.classList.toggle("hidden", !db);
  updateDeleteButtons();
}

function renderDeleteButton(button, pbUUID, withLabel = false) {
  const marked = pending.deletes.includes(pbUUID);
  const label = marked ? "Undo deletion" : "Mark for deletion";
  const icon = document.createElement("span");
  icon.className = "emoji-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = marked ? "\u21A9\uFE0F" : "\u{1F5D1}\uFE0F";
  button.replaceChildren(icon);
  button.setAttribute("aria-label", label);
  button.title = withLabel ? label : `${label} (Del)`;
  if (withLabel) {
    button.appendChild(document.createTextNode(` ${label}`));
    button.classList.toggle("ctx-cancel", !marked);
  }
}

function updateDeleteButtons() {
  const footerButton = document.getElementById("np-delete");
  if (footerButton) renderDeleteButton(footerButton, nowPlaying?.uuid);
  const menuButton = document.getElementById("ctx-delete");
  if (menuButton) renderDeleteButton(menuButton, menuButton.dataset.pbuuid, true);
}

function setCellColor(pbUUID, color) {
  const cell = document.querySelector(`.cell[data-pbuuid="${pbUUID}"]`);
  if (!cell) return;
  if (!prepareDatabaseEdit()) return;
  // Find original color from DB to know if this is a real change vs revert
  const orig = queryAll("SELECT songCellColorRaw c FROM Playback WHERE playbackUUIDRaw=?", [pbUUID]);
  const origColor = orig.length ? orig[0].c : -1;
  if (color === origColor) {
    delete pending.colors[pbUUID];
  } else {
    pending.colors[pbUUID] = color;
  }
  savePending();
  applyPendingToCell(cell);
  cell.dataset.color = String(color);
  updateSwatchActive();
}

function toggleCellDelete(pbUUID) {
  const cell = document.querySelector(`.cell[data-pbuuid="${pbUUID}"]`);
  if (!cell) return;
  if (!prepareDatabaseEdit()) return;
  const i = pending.deletes.indexOf(pbUUID);
  if (i >= 0) pending.deletes.splice(i, 1);
  else {
    pending.deletes.push(pbUUID);
    // Delete cancels a pending move (contradictory)
    delete pending.moves[pbUUID];
  }
  savePending();
  applyPendingToCell(cell);
}

function setCellMove(pbUUID, targetGroupUUID) {
  const cell = document.querySelector(`.cell[data-pbuuid="${pbUUID}"]`);
  if (!cell) return;
  if (!prepareDatabaseEdit()) return;
  // Find current group
  const cur = queryAll("SELECT playbackGroupUUIDRaw g FROM Playback WHERE playbackUUIDRaw=?", [pbUUID]);
  const curGroup = cur.length ? cur[0].g : null;
  if (targetGroupUUID === curGroup) {
    // No-op: moving to same tab clears any pending move
    delete pending.moves[pbUUID];
  } else {
    pending.moves[pbUUID] = targetGroupUUID;
    // Move cancels a pending delete
    const di = pending.deletes.indexOf(pbUUID);
    if (di >= 0) pending.deletes.splice(di, 1);
  }
  savePending();
  applyPendingToCell(cell);
}

// Number-key → color value mapping (matches keypad layout: 0 = app default, 1..9 = colors)
function keyToColor(key) {
  if (key === "0") return -1;
  const n = parseInt(key, 10);
  if (n >= 1 && n <= KEYBOARD_COLOR_RAWS.length) return KEYBOARD_COLOR_RAWS[n - 1];
  return null;
}

// =====================================================================
// Save flow — applies pending edits to in-memory DB, downloads new file
// =====================================================================
function applyPendingToDatabase(database, edits) {
  const db = database;
  const pending = edits;
  db.run("BEGIN");
  try {
  // apply colors
  for (const [uuid, color] of Object.entries(pending.colors)) {
    db.run("UPDATE Playback SET songCellColorRaw = ?, updatedTimestamp1970 = ? WHERE playbackUUIDRaw = ?",
      [color, Date.now() / 1000, uuid]);
  }
  // apply start-time changes
  for (const [uuid, ms] of Object.entries(pending.starts)) {
    const seconds = Math.floor(ms / 1000);
    const subSec = (ms - seconds * 1000) / 1000;
    db.run(
      "UPDATE Playback SET startAtSeconds = ?, startAtSubSec = ?, updatedTimestamp1970 = ? WHERE playbackUUIDRaw = ?",
      [seconds, subSec, Date.now() / 1000, uuid]
    );
  }
  // apply end-cue (stop-time) changes
  for (const [uuid, ms] of Object.entries(pending.stops)) {
    const seconds = Math.floor(ms / 1000);
    const subSec = (ms - seconds * 1000) / 1000;
    db.run(
      "UPDATE Playback SET stopAtSeconds = ?, stopAtSubSec = ?, updatedTimestamp1970 = ? WHERE playbackUUIDRaw = ?",
      [seconds, subSec, Date.now() / 1000, uuid]
    );
  }
  // apply per-track volume changes (raw value: -1 = inherit default, else 0..1)
  for (const [uuid, raw] of Object.entries(pending.volumes)) {
    db.run(
      "UPDATE Playback SET volume = ?, updatedTimestamp1970 = ? WHERE playbackUUIDRaw = ?",
      [raw, Date.now() / 1000, uuid]
    );
  }
  // apply hotkey assignments (single letter, or "" to clear)
  for (const [uuid, key] of Object.entries(pending.hotkeys)) {
    db.run(
      "UPDATE Playback SET hotKey = ?, updatedTimestamp1970 = ? WHERE playbackUUIDRaw = ?",
      [key, Date.now() / 1000, uuid]
    );
  }
  // apply moves (set new playbackGroupUUIDRaw and append to end of target group)
  for (const [uuid, targetGroup] of Object.entries(pending.moves)) {
    if (!queryDatabase(db, "SELECT 1 FROM PlaybackGroup WHERE playbackGroupUUIDRaw=?", [targetGroup]).length) {
      throw new Error("A pending move targets a tab that no longer exists.");
    }
    const maxRow = queryDatabase(db,
      "SELECT COALESCE(MAX(orderIndex), -1) AS m FROM Playback WHERE playbackGroupUUIDRaw = ?",
      [targetGroup]
    );
    const newOrder = (maxRow[0]?.m ?? -1) + 1;
    db.run(
      "UPDATE Playback SET playbackGroupUUIDRaw = ?, orderIndex = ?, updatedTimestamp1970 = ? WHERE playbackUUIDRaw = ?",
      [targetGroup, newOrder, Date.now() / 1000, uuid]
    );
  }
  // apply deletes
  for (const uuid of pending.deletes) {
    db.run("DELETE FROM Playback WHERE playbackUUIDRaw = ?", [uuid]);
  }
    db.run("COMMIT");
  } catch (error) { db.run("ROLLBACK"); throw error; }
}

async function exportWorkingDatabase() {
  if (!db || erasingBrowser) throw new Error("No working database is available to export.");
  const candidate = new SQL.Database(db.export());
  try {
    applyPendingToDatabase(candidate, structuredClone(pending));
    return candidate.export();
  } finally { candidate.close(); }
}

async function commitChanges() {
  if (!db || saveInProgress || databaseImporting || erasingBrowser) return false;
  if (!confirm("Export the current working database and save its browser recovery copy? Verify the downloaded file yourself; a requested download is not proof that it was saved.")) return false;
  saveInProgress = true;
  const revision = workingRevision;
  const identity = databaseIdentity;
  const epoch = databaseEpoch;
  let candidate;
  try {
    const bytes = await exportWorkingDatabase();
    if (epoch !== databaseEpoch || identity !== databaseIdentity) return false;
    candidate = new SQL.Database(bytes);
    const record = recoveryRecord(bytes, emptyPending(), identity, baselineBytes, false);
    triggerDownload(bytes, "Sarcastaball9000.sqlite");
    await persistRecoveryRecord(record, epoch);
    if (epoch !== databaseEpoch || identity !== databaseIdentity) return false;
    if (workingRevision === revision) {
      db.close();
      db = candidate;
      candidate = null;
      pending = emptyPending();
      baselineActive = false;
      workingRevision++;
      refreshGroupsFromDB();
      renderTabs();
      renderGrid();
      restorePlayingHighlight();
      refreshPlayingSnapshot();
      updateSaveBadge();
    } else {
      if (!await persistDbToIdb()) return false;
    }
    showToast("Export requested; verify the saved file. Any newer edits remain in this tab.");
    return true;
  } catch (error) {
    if (epoch === databaseEpoch && !erasingBrowser) reportDatabaseError(`Save did not complete. Your working data and edits are retained. ${error.message}`);
    return false;
  } finally {
    candidate?.close();
    saveInProgress = false;
  }
}

function triggerDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/x-sqlite3" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// =====================================================================
// Cell context menu (right-click)
// =====================================================================
let contextMenuReturnFocus = null;
function hideCellContextMenu() {
  const m = document.getElementById("ctx-menu");
  const restoreFocus = m?.contains(document.activeElement);
  if (m) m.classList.add("hidden");
  if (restoreFocus) {
    const target = contextMenuReturnFocus?.isConnected ? contextMenuReturnFocus : document.getElementById("btn-settings");
    target?.focus({ preventScroll: true });
  }
  contextMenuReturnFocus = null;
}

// =====================================================================
// Tile copy / rename / delete
// ---------------------------------------------------------------------
// These let you duplicate, rename, or remove an individual song tile from the
// right-click menu (and the now-playing title bar). Copy and Rename change the
// in-memory database immediately — just like adding or deleting a tab — but,
// like every edit in this app, nothing is written to the .sqlite file on disk
// until you press Save. Delete reuses the reversible "mark for deletion"
// (trash-can) state and only takes effect on Save.
// =====================================================================

// The name a tile currently shows: its custom title if it has one, otherwise
// the underlying song's title, otherwise a placeholder.
function tileDisplayName(pbUUID) {
  const r = queryAll(`
    SELECT COALESCE(NULLIF(p.displayTitle, ''), s.title, '(untitled)') AS name
    FROM Playback p LEFT JOIN Sound s ON s.soundUUIDRaw = p.sourceUUIDRaw
    WHERE p.playbackUUIDRaw = ?`, [pbUUID]);
  return r.length ? r[0].name : "(untitled)";
}

// Which tab (group) a tile lives in.
function cellGroupUUID(pbUUID) {
  const r = queryAll("SELECT playbackGroupUUIDRaw AS g FROM Playback WHERE playbackUUIDRaw = ?", [pbUUID]);
  return r.length ? r[0].g : null;
}

// Every tile name currently shown in a tab, optionally skipping one tile. The
// skip is used when renaming so a tile's own name doesn't count as a clash.
function groupTileNames(groupUUID, excludeUUID) {
  const rows = queryAll(`
    SELECT p.playbackUUIDRaw AS u,
           COALESCE(NULLIF(p.displayTitle, ''), s.title, '(untitled)') AS name
    FROM Playback p LEFT JOIN Sound s ON s.soundUUIDRaw = p.sourceUUIDRaw
    WHERE p.playbackGroupUUIDRaw = ?`, [groupUUID]);
  const set = new Set();
  for (const r of rows) if (r.u !== excludeUUID) set.add(r.name);
  return set;
}

// Choose a unique name the way Windows does for duplicate files: if "Song" is
// already taken, try "Song (2)", then "Song (3)", and so on. If the requested
// name already ends in " (n)", we count up from there.
function uniqueTileName(desired, takenSet) {
  if (!takenSet.has(desired)) return desired;
  let base = desired, n = 2;
  const m = desired.match(/^(.*) \((\d+)\)$/);
  if (m) { base = m[1]; n = parseInt(m[2], 10) + 1; }
  while (takenSet.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

// Pop up a name prompt pre-filled with the current name. Returns the trimmed
// text, or null if the user cancelled (Esc) or cleared the box.
function promptForTileName(currentName) {
  const input = prompt("Tile name:", currentName);
  if (input === null) return null;
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

// Re-apply the "playing"/"paused" highlight after a full grid re-render, so the
// glowing tile doesn't go dark when we rebuild the grid for a copy or rename.
function restorePlayingHighlight() {
  if (!nowPlaying) return;
  const c = document.querySelector(`.cell[data-pbuuid="${nowPlaying.uuid}"]`);
  if (c) { c.classList.add("playing"); if (nowPlaying.paused) c.classList.add("paused"); }
}

// Duplicate a tile into the same tab. The copy keeps the same song, cue/stop
// times, fades, volume and colour — including any unsaved cue or colour tweaks
// you can currently see — gets a brand-new identity, and is appended to the end
// of the tab. Its hotkey is intentionally cleared so two tiles never fight over
// the same key.
function copyCell(pbUUID) {
  if (!db) return;
  const wanted = promptForTileName(tileDisplayName(pbUUID));
  if (wanted === null) return;
  const src = queryAll("SELECT * FROM Playback WHERE playbackUUIDRaw = ?", [pbUUID])[0];
  if (!src) return;
  const group = src.playbackGroupUUIDRaw;
  // The original tile still exists, so typing the name unchanged WILL clash and
  // become "… (2)" — exactly like copying a file in Windows.
  const finalName = uniqueTileName(wanted, groupTileNames(group, null));

  // Fold in any pending (unsaved) colour / cue edits so the copy matches what is
  // on screen right now.
  let color = src.songCellColorRaw;
  if (pending.colors[pbUUID] !== undefined) color = pending.colors[pbUUID];
  let startSec = src.startAtSeconds, startSub = src.startAtSubSec;
  if (pending.starts[pbUUID] !== undefined) {
    const ms = pending.starts[pbUUID];
    startSec = Math.floor(ms / 1000);
    startSub = (ms - startSec * 1000) / 1000;
  }
  let vol = src.volume;
  if (pending.volumes[pbUUID] !== undefined) vol = pending.volumes[pbUUID];
  // Fold any pending end-cue change into the copy too.
  let stopSec = src.stopAtSeconds, stopSub = src.stopAtSubSec;
  if (pending.stops[pbUUID] !== undefined) {
    const ms = pending.stops[pbUUID];
    stopSec = Math.floor(ms / 1000);
    stopSub = (ms - stopSec * 1000) / 1000;
  }
  const maxRow = queryAll("SELECT COALESCE(MAX(orderIndex), -1) AS m FROM Playback WHERE playbackGroupUUIDRaw = ?", [group]);
  const newOrder = (maxRow[0]?.m ?? -1) + 1;
  const now = Date.now() / 1000;
  if (!mutateDatabase(() => db.run(`INSERT INTO Playback
    (playbackUUIDRaw, playbackGroupUUIDRaw, sourceUUIDRaw, orderIndex, displayTitle, altTitle,
     volume, loopCount, willPlayOverRaw, willPlayNextSoundRaw, startAtSeconds, startAtSubSec,
     stopAtSeconds, stopAtSubSec, fadeInSeconds, fadeOutSeconds, hasBeenPlayedRaw, songCellColorRaw,
     hotKey, createdTimestamp1970, updatedTimestamp1970)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newUuid(), group, src.sourceUUIDRaw, newOrder, finalName, src.altTitle,
     vol, src.loopCount, src.willPlayOverRaw, src.willPlayNextSoundRaw, startSec, startSub,
     stopSec, stopSub, src.fadeInSeconds, src.fadeOutSeconds, 0, color,
     "", now, now]))) return;

  markTabOpDirty();
  renderGrid();
  restorePlayingHighlight();
}

// Rename a tile in place using the same dialog as Copy. The name is made unique
// within the tab while ignoring the tile's own current name, so keeping the name
// as-is is a harmless no-op (it won't turn into "… (2)").
function renameCell(pbUUID) {
  if (!db) return;
  const current = tileDisplayName(pbUUID);
  const wanted = promptForTileName(current);
  if (wanted === null) return;
  const finalName = uniqueTileName(wanted, groupTileNames(cellGroupUUID(pbUUID), pbUUID));
  if (finalName === current) return; // nothing actually changed
  if (!mutateDatabase(() => db.run("UPDATE Playback SET displayTitle = ?, updatedTimestamp1970 = ? WHERE playbackUUIDRaw = ?",
    [finalName, Date.now() / 1000, pbUUID]))) return;
  markTabOpDirty();
  renderGrid();
  restorePlayingHighlight();
  // Keep the now-playing banner in sync if we just renamed the playing tile.
  if (nowPlaying && nowPlaying.uuid === pbUUID) {
    document.getElementById("np-title").textContent = finalName;
  }
}

// Assign (or clear) a single-letter keyboard hotkey for a tile. Pressing that
// letter anywhere on this tab will instantly start the tile playing. We only
// allow letters A–Z: number keys are already used to recolor the focused cell,
// and space/enter/arrows/delete are reserved for navigation. The assignment is
// staged as a pending edit (shows the orange "edited" dot) and written to the
// database's existing hotKey column when the user clicks Save.
function setHotkeyForCell(pbUUID) {
  if (!db) return;
  // What is currently assigned (pending edit wins over the saved value)?
  let current = pending.hotkeys[pbUUID];
  if (current === undefined) {
    const row = queryAll("SELECT hotKey FROM Playback WHERE playbackUUIDRaw = ?", [pbUUID]);
    current = (row[0]?.hotKey || "").toString().toUpperCase();
  }
  const answer = prompt(
    "Type a single letter (A–Z) to use as this song's hotkey.\nLeave blank and press OK to remove the hotkey.",
    current
  );
  if (answer === null) return; // user cancelled
  const trimmed = answer.trim().toUpperCase();
  if (trimmed !== "" && !/^[A-Z]$/.test(trimmed)) {
    alert("Please enter a single letter A–Z (or leave blank to clear).");
    return;
  }
  if (!prepareDatabaseEdit()) return;
  // If another tile on this tab already shows this letter, free it up first so
  // each hotkey fires exactly one tile. Be careful not to destroy that tile's
  // SAVED hotkey: only stage "" when the conflict comes from its database value;
  // if the conflict is merely a pending override, revert that override instead.
  if (trimmed !== "") {
    document.querySelectorAll(`#grid .cell`).forEach(c => {
      const other = c.dataset.pbuuid;
      if (other === pbUUID) return;
      if ((c.dataset.hotkey || "") === trimmed) {
        const savedRow = queryAll("SELECT hotKey FROM Playback WHERE playbackUUIDRaw = ?", [other]);
        const saved = (savedRow[0]?.hotKey || "").toString().toUpperCase();
        if (saved === trimmed) {
          pending.hotkeys[other] = "";          // saved value collides → explicitly clear it
        } else {
          delete pending.hotkeys[other];        // only a pending override collided → revert to saved
          c.dataset.hotkey = saved;             // restore the cell's saved letter before re-render
        }
        applyPendingToCell(c);
      }
    });
  }
  pending.hotkeys[pbUUID] = trimmed;
  savePending();
  const cell = document.querySelector(`.cell[data-pbuuid="${pbUUID}"]`);
  if (cell) applyPendingToCell(cell);
}

// Mark a tile for deletion (the same reversible state as the footer trash-can),
// but confirm first because this is a right-click destructive action. If the
// tile is already marked, this simply undoes it (no confirmation needed).
function confirmDeleteCell(pbUUID) {
  if (pending.deletes.includes(pbUUID)) { toggleCellDelete(pbUUID); return; }
  if (confirm(`Mark "${tileDisplayName(pbUUID)}" for deletion?\n\nIt will be removed when you click Save. You can undo it before then.`)) {
    toggleCellDelete(pbUUID);
  }
}

function showCellContextMenu(cell, x, y) {
  contextMenuReturnFocus = cell;
  const menu = document.getElementById("ctx-menu");
  menu.innerHTML = "";

  const pbUUID = cell.dataset.pbuuid;
  const cur = queryAll("SELECT playbackGroupUUIDRaw g FROM Playback WHERE playbackUUIDRaw=?", [pbUUID]);
  // If a move is pending, the displayed "current" is still the source group; treat the source as "from" and the pending target as currently-selected.
  const sourceGroup = cur.length ? cur[0].g : null;
  const pendingTarget = pending.moves[pbUUID] || null;

  const titleDiv = document.createElement("div");
  titleDiv.className = "ctx-title";
  titleDiv.textContent = (cell.querySelector(".title")?.textContent || "Cell");
  menu.appendChild(titleDiv);

  // --- Per-tile actions (copy / rename / delete) ---
  const addItem = (label, handler, extraClass) => {
    const it = document.createElement("button");
    it.type = "button";
    it.className = "ctx-item" + (extraClass ? " " + extraClass : "");
    it.textContent = label;
    it.onclick = () => { hideCellContextMenu(); handler(); };
    menu.appendChild(it);
    return it;
  };
  addItem("📋 Copy song…",   () => copyCell(pbUUID));
  addItem("✏️ Rename song…", () => renameCell(pbUUID));
  addItem("⌨️ Set hotkey…",  () => setHotkeyForCell(pbUUID));
  // Manually flip this tile's "played" (grayed-out) state.
  const isPlayed = cell.classList.contains("played");
  addItem(isPlayed ? "↩️ Mark unplayed" : "✅ Mark played",
          () => setCellPlayedFlag(pbUUID, !isPlayed));
  const deleteItem = addItem("", () => confirmDeleteCell(pbUUID));
  deleteItem.id = "ctx-delete";
  deleteItem.dataset.pbuuid = pbUUID;
  renderDeleteButton(deleteItem, pbUUID, true);

  // "Move to..." submenu (rendered inline as a list)
  const moveHeader = document.createElement("div");
  moveHeader.className = "ctx-header";
  moveHeader.textContent = "📂 Move to…";
  menu.appendChild(moveHeader);

  for (const g of groups) {
    if (g.uuid === sourceGroup) continue;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ctx-item";
    item.textContent = g.name + (g.uuid === pendingTarget ? "  ✓" : "");
    item.onclick = () => {
      setCellMove(pbUUID, g.uuid);
      hideCellContextMenu();
    };
    menu.appendChild(item);
  }

  if (pendingTarget) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ctx-item ctx-cancel";
    cancel.textContent = "✖️ Cancel pending move";
    cancel.onclick = () => {
      setCellMove(pbUUID, sourceGroup);  // moving to source clears the pending move
      hideCellContextMenu();
    };
    menu.appendChild(cancel);
  }

  // Position, then clamp to viewport
  menu.classList.remove("hidden");
  const r = menu.getBoundingClientRect();
  let nx = x, ny = y;
  if (nx + r.width  > window.innerWidth)  nx = window.innerWidth  - r.width  - 8;
  if (ny + r.height > window.innerHeight) ny = window.innerHeight - r.height - 8;
  menu.style.left = nx + "px";
  menu.style.top  = ny + "px";
}

// =====================================================================
// Tab context menu + tab operations (apply immediately to in-memory DB)
// =====================================================================
function refreshGroupsFromDB() {
  groups = queryAll(`
    SELECT playbackGroupUUIDRaw AS uuid, groupName AS name, orderIndex, isVisibleRaw AS visible
    FROM PlaybackGroup
    WHERE isVisibleRaw = 1
    ORDER BY orderIndex
  `);
}

async function persistDbToIdb() {
  if (!db || erasingBrowser) return false;
  const epoch = databaseEpoch;
  try {
    const record = recoveryRecord();
    await persistRecoveryRecord(record, epoch);
    return true;
  }
  catch (error) {
    if (epoch === databaseEpoch && !erasingBrowser) reportDatabaseError(error.message);
    return false;
  }
}

function markTabOpDirty() {
  pending.tabOps = (pending.tabOps || 0) + 1;
  savePending();
}

function newUuid() {
  const u = (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; const v = c === "x" ? r : (r & 0x3 | 0x8); return v.toString(16);
  }));
  return u.toUpperCase();
}

function showTabContextMenu(tabIdx, x, y) {
  contextMenuReturnFocus = document.querySelectorAll("#tabs .tab")[tabIdx] || null;
  const menu = document.getElementById("ctx-menu");
  menu.innerHTML = "";
  const g = groups[tabIdx];
  if (!g) return;

  const title = document.createElement("div");
  title.className = "ctx-title";
  title.textContent = g.name;
  menu.appendChild(title);

  addCtxItem(menu, "Rename…", () => tabRename(tabIdx));

  addCtxHeader(menu, "Sort by");
  addCtxItem(menu, "Song Name",   () => tabSort(tabIdx, "name"));
  addCtxItem(menu, "Artist Name", () => tabSort(tabIdx, "artist"));
  addCtxItem(menu, "Song Color",  () => tabSort(tabIdx, "color"));
  addCtxItem(menu, "Random",      () => tabSort(tabIdx, "random"));

  addCtxHeader(menu, "Reorder");
  addCtxItem(menu, "Move Left",  () => tabMove(tabIdx, -1), tabIdx === 0);
  addCtxItem(menu, "Move Right", () => tabMove(tabIdx,  1), tabIdx === groups.length - 1);

  const del = addCtxItem(menu, "Delete tab…", () => tabDelete(tabIdx));
  del.classList.add("ctx-cancel");

  menu.classList.remove("hidden");
  const r = menu.getBoundingClientRect();
  let nx = x, ny = y;
  if (nx + r.width  > window.innerWidth)  nx = window.innerWidth  - r.width  - 8;
  if (ny + r.height > window.innerHeight) ny = window.innerHeight - r.height - 8;
  menu.style.left = nx + "px";
  menu.style.top  = ny + "px";
}

function addCtxItem(menu, label, onClick, disabled) {
  const item = document.createElement("button");
  item.type = "button";
  item.disabled = !!disabled;
  item.className = "ctx-item" + (disabled ? " ctx-disabled" : "");
  item.textContent = label;
  if (!disabled) {
    item.onclick = () => { hideCellContextMenu(); onClick(); };
  }
  menu.appendChild(item);
  return item;
}
function addCtxHeader(menu, label) {
  const h = document.createElement("div");
  h.className = "ctx-header";
  h.textContent = label;
  menu.appendChild(h);
}

function tabRename(idx) {
  const g = groups[idx];
  const name = prompt("Rename tab:", g.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === g.name) return;
  if (!mutateDatabase(() => db.run("UPDATE PlaybackGroup SET groupName = ?, updatedTimestamp1970 = ? WHERE playbackGroupUUIDRaw = ?",
    [trimmed, Date.now() / 1000, g.uuid]))) return;
  refreshGroupsFromDB();
  renderTabs();
  markTabOpDirty();
}

function tabMove(idx, dir) {
  const a = groups[idx];
  const j = idx + dir;
  if (j < 0 || j >= groups.length) return;
  const b = groups[j];
  const ts = Date.now() / 1000;
  if (!mutateDatabase(() => {
    db.run("UPDATE PlaybackGroup SET orderIndex = ?, updatedTimestamp1970 = ? WHERE playbackGroupUUIDRaw = ?", [b.orderIndex, ts, a.uuid]);
    db.run("UPDATE PlaybackGroup SET orderIndex = ?, updatedTimestamp1970 = ? WHERE playbackGroupUUIDRaw = ?", [a.orderIndex, ts, b.uuid]);
  })) return;
  refreshGroupsFromDB();
  const newIdx = groups.findIndex(g => g.uuid === a.uuid);
  if (newIdx >= 0) activeTabIdx = newIdx;
  localStorage.setItem(LS_TAB, String(activeTabIdx));
  renderTabs();
  markTabOpDirty();
}

function tabDelete(idx) {
  const g = groups[idx];
  const cnt = queryAll("SELECT COUNT(*) AS c FROM Playback WHERE playbackGroupUUIDRaw = ?", [g.uuid])[0].c;
  if (!confirm(`Delete tab "${g.name}" and all ${cnt} of its songs?\n\nThis cannot be undone except by reloading the DB before saving.`)) return;
  if (!mutateDatabase(() => {
    db.run("DELETE FROM Playback WHERE playbackGroupUUIDRaw = ?", [g.uuid]);
    db.run("DELETE FROM PlaybackGroup WHERE playbackGroupUUIDRaw = ?", [g.uuid]);
    const remaining = queryAll("SELECT playbackGroupUUIDRaw AS uuid FROM PlaybackGroup ORDER BY orderIndex");
    remaining.forEach((r, i) => {
      db.run("UPDATE PlaybackGroup SET orderIndex = ? WHERE playbackGroupUUIDRaw = ?", [i, r.uuid]);
    });
  })) return;
  cleanupOrphanedPending();
  refreshGroupsFromDB();
  if (activeTabIdx >= groups.length) activeTabIdx = Math.max(0, groups.length - 1);
  localStorage.setItem(LS_TAB, String(activeTabIdx));
  renderTabs();
  renderGrid();
  markTabOpDirty();
}

function tabAdd() {
  const name = prompt("New tab name:", "New Tab");
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const uuid = newUuid();
  const maxRow = queryAll("SELECT COALESCE(MAX(orderIndex), -1) AS m FROM PlaybackGroup");
  const orderIdx = (maxRow[0]?.m ?? -1) + 1;
  const ts = Date.now() / 1000;
  if (!mutateDatabase(() => db.run(
    "INSERT INTO PlaybackGroup (playbackGroupUUIDRaw, groupName, orderIndex, isVisibleRaw, isGoProGroupRaw, hotKey, createdTimestamp1970, updatedTimestamp1970) VALUES (?,?,?,?,?,?,?,?)",
    [uuid, trimmed, orderIdx, 1, 0, "", ts, ts]
  ))) return;
  refreshGroupsFromDB();
  const newIdx = groups.findIndex(g => g.uuid === uuid);
  if (newIdx >= 0) activeTabIdx = newIdx;
  localStorage.setItem(LS_TAB, String(activeTabIdx));
  renderTabs();
  renderGrid();
  markTabOpDirty();
}

function tabSort(idx, kind) {
  const g = groups[idx];
  const rows = queryAll(`
    SELECT
      p.playbackUUIDRaw AS pbUUID,
      COALESCE(NULLIF(p.displayTitle, ''), s.title, '') AS sortName,
      COALESCE(s.artist, '') AS sortArtist,
      p.songCellColorRaw AS sortColor
    FROM Playback p
    LEFT JOIN Sound s ON s.soundUUIDRaw = p.sourceUUIDRaw
    WHERE p.playbackGroupUUIDRaw = ?
  `, [g.uuid]);
  if (rows.length === 0) return;
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  if (kind === "name")        rows.sort((a, b) => collator.compare(a.sortName, b.sortName));
  else if (kind === "artist") rows.sort((a, b) => collator.compare(a.sortArtist, b.sortArtist) || collator.compare(a.sortName, b.sortName));
  else if (kind === "color")  rows.sort((a, b) => (a.sortColor - b.sortColor) || collator.compare(a.sortName, b.sortName));
  else if (kind === "random") {
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
  }
  const ts = Date.now() / 1000;
  if (!mutateDatabase(() => rows.forEach((r, i) => {
    db.run("UPDATE Playback SET orderIndex = ?, updatedTimestamp1970 = ? WHERE playbackUUIDRaw = ?",
      [i, ts, r.pbUUID]);
  }))) return;
  renderGrid();
  markTabOpDirty();
}

function cleanupOrphanedPending() {
  const live = new Set(queryAll("SELECT playbackUUIDRaw AS u FROM Playback").map(r => r.u));
  const destinations = new Set(queryAll("SELECT playbackGroupUUIDRaw AS u FROM PlaybackGroup").map(r => r.u));
  for (const k of Object.keys(pending.colors)) if (!live.has(k)) delete pending.colors[k];
  for (const k of Object.keys(pending.moves))  if (!live.has(k) || !destinations.has(pending.moves[k])) delete pending.moves[k];
  for (const k of Object.keys(pending.starts)) if (!live.has(k)) delete pending.starts[k];
  for (const k of Object.keys(pending.stops))  if (!live.has(k)) delete pending.stops[k];
  for (const k of Object.keys(pending.volumes)) if (!live.has(k)) delete pending.volumes[k];
  for (const k of Object.keys(pending.hotkeys)) if (!live.has(k)) delete pending.hotkeys[k];
  pending.deletes = pending.deletes.filter(u => live.has(u));
  savePending();
}

function buildSwatches() {
  const sw = document.getElementById("np-swatches");
  sw.innerHTML = "";
  // Order: app default (key 0), then keyboard-mapped colors in key order (1..9)
  const entries = [{ raw: -1, name: "App Default", key: "0" }];
  KEYBOARD_COLOR_RAWS.forEach((raw, i) => {
    const meta = S9000_COLORS.find(c => c.raw === raw);
    entries.push({ raw, name: meta ? meta.name : `Color ${raw}`, key: String(i + 1) });
  });
  for (const e of entries) {
    const d = document.createElement("div");
    d.className = "swatch";
    d.dataset.color = String(e.raw);
    d.title = `${e.name} (key ${e.key})`;
    d.onclick = () => {
      if (!nowPlaying) return;
      setCellColor(nowPlaying.uuid, e.raw);
    };
    sw.appendChild(d);
  }
}
function updateSwatchActive() {
  document.querySelectorAll("#np-swatches .swatch").forEach(s => s.classList.remove("active"));
  if (!nowPlaying) return;
  const cell = document.querySelector(`.cell[data-pbuuid="${nowPlaying.uuid}"]`);
  if (!cell) return;
  const c = cell.dataset.color;
  const sw = document.querySelector(`#np-swatches .swatch[data-color="${c}"]`);
  if (sw) sw.classList.add("active");
}

// =====================================================================
// Settings modal wiring
// =====================================================================
function showModal(open) {
  setDialogOpen("modal", open);
}

const dialogReturnFocus = new Map();
function setDialogOpen(id, open) {
  const dialog = document.getElementById(id);
  if (!dialog || (!open && dialog.classList.contains("hidden"))) return;
  if (open) {
    dialogReturnFocus.set(id, document.activeElement);
    document.querySelectorAll('[role="dialog"]').forEach(other => {
      if (other !== dialog) other.classList.add("hidden");
    });
  }
  dialog.classList.toggle("hidden", !open);
  if (id === "logout-modal" && !open) logoutExportGeneration++;
  for (const child of document.body.children) {
    child.inert = open && child !== dialog && child.tagName !== "SCRIPT";
  }
  if (open) {
    const first = Array.from(dialog.querySelectorAll('button, input, select, [href], [tabindex="0"]'))
      .find(element => !element.disabled && element.tabIndex >= 0 && !element.closest(".hidden"));
    (first || dialog).focus({ preventScroll: true });
  } else {
    const previous = dialogReturnFocus.get(id);
    if (previous?.isConnected && !previous.closest(".hidden")) previous.focus({ preventScroll: true });
    else document.getElementById("btn-settings")?.focus();
    dialogReturnFocus.delete(id);
  }
}

function wireAccessibleControls() {
  document.querySelectorAll(".icon-btn[title], .swatch[title]").forEach(el => {
    if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", el.title);
  });
  document.getElementById("grid").addEventListener("focusin", e => {
    const cell = e.target.closest(".cell");
    if (cell) setFocusedCell(cell, false);
  });
  document.addEventListener("keydown", e => {
    const dialog = document.querySelector('[role="dialog"]:not(.hidden)');
    if (!dialog) return;
    if (e.key === "Escape") {
      if (erasingBrowser) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (dialog.id === "add-song-modal") closeAddSong();
      else setDialogOpen(dialog.id, false);
    } else if (e.key === "Tab") {
      const controls = Array.from(dialog.querySelectorAll('button, input, select, [href], [tabindex="0"]'))
        .filter(el => !el.disabled && el.tabIndex >= 0 && !el.closest(".hidden"));
      const first = controls[0] || dialog;
      const last = controls[controls.length - 1] || dialog;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    }
  }, true);
}

// =====================================================================
// Fullscreen and browser-specific Home Screen guidance
// =====================================================================
let fullscreenRequest = null;
const FULLSCREEN_TIMEOUT_MS = 10000;
const FULLSCREEN_GUIDES = {
  safari: {
    name: "Safari",
    rows: [
      [["ios"], "iPhone / iPad", "Tap Share (or More, then Share), choose Add to Home Screen, enable Open as Web App if offered, then Add. Launch the new Home Screen icon."],
      [["mac"], "Mac", "Use this app's full screen button or View > Enter Full Screen. On supported Safari/macOS versions, File > Add to Dock creates a separate app window."],
      [["android", "windows", "desktop"], "Other computers / Android", "Current Safari is for Apple devices. Choose the Chrome, Edge or Firefox tab for another browser."],
    ],
  },
  chrome: {
    name: "Chrome",
    rows: [
      [["ios"], "iPhone / iPad", "Tap Share beside the address bar, then Add to Home Screen and Add. If that action is missing, open the same site in Safari and follow the Safari tab."],
      [["android"], "Android", "Open Chrome's menu and choose Add to Home screen, then Install or Create shortcut if offered. Launch the new icon; a shortcut may open a normal browser tab."],
      [["mac", "windows", "desktop"], "Computer", "Use the full screen button, or look in Chrome's menu under Cast, save, and share for Install page as app. Installation options vary by version and site."],
    ],
  },
  edge: {
    name: "Edge",
    rows: [
      [["ios"], "iPhone / iPad", "Open Edge's Share menu and use Add to Home Screen if offered. If it is absent, open this site in Safari and use Share > Add to Home Screen."],
      [["android"], "Android", "Look in Edge's menu for Add to Home screen, Add to phone or Install, if offered. If none is available, use Chrome's Home Screen instructions."],
      [["mac", "windows", "desktop"], "Computer", "Use the full screen button, or Edge's menu > Apps > Install this site as an app, if offered. Launch the installed app from your system's app list."],
    ],
  },
  firefox: {
    name: "Firefox",
    rows: [
      [["ios"], "iPhone / iPad", "Check Firefox's Share menu for Add to Home Screen. If it is not offered, open this site in Safari and follow Share > Add to Home Screen there."],
      [["android"], "Android", "Look in Firefox's menu for Add to Home screen or Install, if offered. A shortcut may open a normal tab. Chrome is another option when this action is unavailable."],
      [["mac", "windows", "desktop"], "Computer", "Use this app's full screen button or Firefox's full-screen menu control. Separate web-app installation depends on Firefox version and operating system; a bookmark alone does not create full screen."],
    ],
  },
};

function detectedBrowser() {
  const ua = navigator.userAgent;
  if (/EdgiOS|EdgA?\/|Edge\//i.test(ua)) return "edge";
  if (/FxiOS|Firefox\//i.test(ua)) return "firefox";
  if (/CriOS|Chrome\/|Chromium\//i.test(ua)) return "chrome";
  if (/Safari\//i.test(ua)) return "safari";
  return null;
}

function detectedPlatform() {
  if (isAppleMobileBrowser()) return "ios";
  if (/Android/i.test(navigator.userAgent)) return "android";
  if (/Mac/i.test(navigator.platform)) return "mac";
  if (/Win/i.test(navigator.platform)) return "windows";
  return "desktop";
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fullscreenApi() {
  const root = document.documentElement;
  if (typeof document.exitFullscreen === "function" &&
      (document.fullscreenElement || (document.fullscreenEnabled && typeof root.requestFullscreen === "function"))) {
    return { enter: () => root.requestFullscreen(), exit: () => document.exitFullscreen() };
  }
  if (typeof document.webkitExitFullscreen === "function" &&
      (document.webkitFullscreenElement || (document.webkitFullscreenEnabled && typeof root.webkitRequestFullscreen === "function"))) {
    return { enter: () => root.webkitRequestFullscreen(), exit: () => document.webkitExitFullscreen() };
  }
  return null;
}

function syncFullscreenButton() {
  const button = document.getElementById("btn-fullscreen");
  const active = !!fullscreenElement();
  const supported = !!fullscreenApi();
  const label = active ? "Exit full screen" : supported ? "Enter full screen" : "Full screen help";
  button.classList.remove("hidden");
  button.disabled = !!fullscreenRequest;
  button.title = label;
  button.setAttribute("aria-label", label);
  if (supported || active) {
    button.setAttribute("aria-pressed", String(active));
    button.removeAttribute("aria-haspopup");
  } else {
    button.removeAttribute("aria-pressed");
    button.setAttribute("aria-haspopup", "dialog");
  }
}

function finishFullscreenRequest(request, confirmed) {
  if (fullscreenRequest !== request) return;
  clearTimeout(request.timer);
  fullscreenRequest = null;
  syncFullscreenButton();
  if (!confirmed) showToast("Full screen was not confirmed. Home Screen help is available in Settings.");
  request.resolve(confirmed);
}

function toggleFullscreen() {
  if (fullscreenRequest) return Promise.resolve(false);
  const api = fullscreenApi();
  if (!api) {
    openFullscreenHelp();
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    const request = { resolve, desired: !fullscreenElement(), timer: null };
    fullscreenRequest = request;
    request.timer = setTimeout(() => finishFullscreenRequest(request, !!fullscreenElement() === request.desired), FULLSCREEN_TIMEOUT_MS);
    syncFullscreenButton();
    try {
      // Invoke immediately in the click handler, before yielding user activation.
      const operation = request.desired ? api.enter() : api.exit();
      Promise.resolve(operation).then(() => {
        if (!!fullscreenElement() === request.desired) finishFullscreenRequest(request, true);
      }, () => finishFullscreenRequest(request, false));
    } catch {
      finishFullscreenRequest(request, false);
    }
  });
}

function selectFullscreenBrowser(browser, focus = false) {
  if (!Object.hasOwn(FULLSCREEN_GUIDES, browser)) throw new Error("Unknown browser help tab.");
  const guide = FULLSCREEN_GUIDES[browser];
  document.querySelectorAll("#fullscreen-browser-tabs [role='tab']").forEach(tab => {
    const active = tab.dataset.browser === browser;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.getElementById("fullscreen-guide-panel").setAttribute("aria-labelledby", `fullscreen-tab-${browser}`);
  const body = document.getElementById("fullscreen-guide-steps");
  body.replaceChildren();
  const platform = detectedPlatform();
  for (const [platforms, label, steps] of guide.rows) {
    const row = document.createElement("tr");
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = label;
    if (platforms.includes(platform)) {
      const current = document.createElement("small");
      current.textContent = "This device";
      heading.appendChild(current);
    }
    const instructions = document.createElement("td");
    instructions.textContent = steps;
    row.append(heading, instructions);
    body.appendChild(row);
  }
  if (focus) document.getElementById(`fullscreen-tab-${browser}`).focus();
}

function openFullscreenHelp() {
  const browser = detectedBrowser();
  const selected = browser || (isAppleMobileBrowser() ? "safari" : "chrome");
  const standalone = navigator.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches;
  const mode = standalone ? "Already running in a Home Screen or app window." :
    fullscreenApi() ? "Native full screen is available from the toolbar." :
      "This browser does not offer webpage full screen here.";
  document.getElementById("fullscreen-help-context").textContent =
    `${mode} ${browser ? `Detected browser: ${FULLSCREEN_GUIDES[browser].name}.` : "Browser could not be identified."} Choose another tab if needed.`;
  selectFullscreenBrowser(selected);
  setDialogOpen("fullscreen-help-modal", true);
}

function wireFullscreenControls() {
  document.getElementById("btn-fullscreen").onclick = () => { void toggleFullscreen(); };
  document.getElementById("btn-fullscreen-help").onclick = openFullscreenHelp;
  document.getElementById("btn-close-fullscreen-help").onclick = () => setDialogOpen("fullscreen-help-modal", false);
  const tabs = Array.from(document.querySelectorAll("#fullscreen-browser-tabs [role='tab']"));
  tabs.forEach((tab, index) => {
    tab.onclick = () => selectFullscreenBrowser(tab.dataset.browser, true);
    tab.addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectFullscreenBrowser(tabs[next].dataset.browser, true);
    });
  });
  for (const event of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(event, () => {
      if (fullscreenRequest && !!fullscreenElement() === fullscreenRequest.desired) {
        finishFullscreenRequest(fullscreenRequest, true);
      } else syncFullscreenButton();
    });
  }
  for (const event of ["fullscreenerror", "webkitfullscreenerror"]) {
    document.addEventListener(event, () => {
      if (fullscreenRequest) finishFullscreenRequest(fullscreenRequest, false);
    });
  }
  syncFullscreenButton();
}

// =====================================================================
// Quick find (🔍)
// Lets the operator type any part of a tile name, song title, or artist and
// jump straight to the matching tile — even if it lives on a different tab.
// We never auto-play the result (the operator does that deliberately); we just
// switch to its tab and put the keyboard focus on it. The query is fully
// parameterized so a song titled with SQL punctuation can't break anything.
// =====================================================================
function openSearch() {
  if (!db) return;
  setDialogOpen("search-modal", true);
  const input = document.getElementById("search-input");
  input.value = "";
  document.getElementById("search-results").innerHTML =
    "<div class='hint'>Start typing to search…</div>";
  input.focus();
}
function closeSearch() {
  setDialogOpen("search-modal", false);
}
function runSearch(termRaw) {
  const results = document.getElementById("search-results");
  const term = (termRaw || "").trim().toLowerCase();
  if (term.length < 1) {
    results.innerHTML = "<div class='hint'>Start typing to search…</div>";
    return;
  }
  const like = "%" + term + "%";
  const rows = queryAll(`
    SELECT
      p.playbackUUIDRaw      AS uuid,
      p.displayTitle         AS title,
      p.playbackGroupUUIDRaw AS gUuid,
      s.title                AS sTitle,
      s.artist               AS sArtist
    FROM Playback p
    LEFT JOIN Sound s ON s.soundUUIDRaw = p.sourceUUIDRaw
    JOIN PlaybackGroup g ON g.playbackGroupUUIDRaw = p.playbackGroupUUIDRaw
    WHERE g.isVisibleRaw = 1
      AND (
        lower(COALESCE(p.displayTitle, '')) LIKE ?
        OR lower(COALESCE(s.title, ''))     LIKE ?
        OR lower(COALESCE(s.artist, ''))    LIKE ?
      )
    ORDER BY p.displayTitle
    LIMIT 50
  `, [like, like, like]);

  results.innerHTML = "";
  if (!rows.length) {
    results.innerHTML = "<div class='hint'>No matches.</div>";
    return;
  }
  for (const r of rows) {
    const gIdx = groups.findIndex(g => g.uuid === r.gUuid);
    const tabName = gIdx >= 0 ? groups[gIdx].name : "(hidden tab)";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "search-row";
    // textContent everywhere — titles/artists are user/3rd-party data.
    const main = document.createElement("span");
    main.className = "search-main";
    main.textContent = r.title || r.sTitle || "(untitled)";
    const sub = document.createElement("span");
    sub.className = "search-sub";
    const songLine = (r.sTitle && r.sArtist) ? `${r.sTitle} — ${r.sArtist}` : (r.sArtist || r.sTitle || "");
    sub.textContent = songLine ? `${songLine}  ·  ${tabName}` : tabName;
    row.appendChild(main);
    row.appendChild(sub);
    if (gIdx < 0) {
      row.classList.add("disabled");
      row.disabled = true;
    } else {
      row.onclick = () => { closeSearch(); jumpToCell(r.uuid, gIdx); };
    }
    results.appendChild(row);
  }
}
function jumpToCell(uuid, gIdx) {
  if (gIdx !== activeTabIdx) {
    activeTabIdx = gIdx;
    localStorage.setItem(LS_TAB, String(gIdx));
    renderTabs();
    renderGrid();
  }
  const cell = document.querySelector(`.cell[data-pbuuid="${uuid}"]`);
  if (cell) {
    setFocusedCell(cell);
    cell.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// =====================================================================
// Add song — search Spotify by name, or browse one of your own playlists,
// then drop the chosen track onto the current tab as a new tile.
// ---------------------------------------------------------------------
// A new tile needs a Sound row (the track) plus a Playback row (the button).
// Every existing song already exists in the loaded database, so this is the one
// place the web app mints brand-new Sound rows. We match exactly the column
// values that existing Spotify rows use (verified against a live DB) so the
// edited database stays in the same format and loads cleanly elsewhere.
// =====================================================================
let addSongMode = "search";                 // "search" | "playlist"
let addSearchTimer = null;                  // debounce handle for the search box
let addSearchSeq = 0;                        // guards against out-of-order async results
let addPlaylistSeq = 0;
let addSearchState = { term: "", offset: 0, total: null, loading: false };
let playlistsState = { offset: 0, total: null, loading: false };
let plTracksState  = { id: null, name: "", offset: 0, total: null, loading: false };

const ADD_SEARCH_PAGE = 10;
const ADD_PLAYLIST_PAGE = 50;
const ADD_TRACKS_PAGE = 100;

function openAddSong() {
  if (!db) { alert("Load a database first."); return; }
  const g = groups[activeTabIdx];
  if (!g) { alert("Create or open a tab first."); return; }
  const input = document.getElementById("add-search-input");
  input.value = "";
  document.getElementById("add-song-target").textContent = g.name;
  setDialogOpen("add-song-modal", true);
  setAddMode("search");
  addSearchState = { term: "", offset: 0, total: null, loading: false };
  document.getElementById("add-search-results").innerHTML =
    "<div class='hint'>Type a song or artist to search Spotify…</div>";
  input.focus();
}
function closeAddSong() {
  invalidateSearchWork();
  setDialogOpen("add-song-modal", false);
}
function invalidateSearchWork() {
  addSearchSeq++;
  addPlaylistSeq++;
  clearTimeout(addSearchTimer);
  addSearchState = { term: "", offset: 0, total: null, loading: false };
  playlistsState = { offset: 0, total: null, loading: false };
  plTracksState = { id: null, name: "", offset: 0, total: null, loading: false };
}
function setAddMode(mode) {
  invalidateSearchWork();
  addSongMode = mode;
  const isSearch = mode === "search";
  document.getElementById("add-mode-search").classList.toggle("active", isSearch);
  document.getElementById("add-mode-playlist").classList.toggle("active", !isSearch);
  document.getElementById("add-search-pane").classList.toggle("hidden", !isSearch);
  document.getElementById("add-playlist-pane").classList.toggle("hidden", isSearch);
  if (isSearch) {
    onAddSearchInput(document.getElementById("add-search-input").value);
  } else {
    // Entering playlist mode: always return to the playlist list (so we don't
    // show a stale drilled-in track list) and refresh it.
    showPlaylistList();
    loadPlaylists(true);
  }
}

async function addSongApi(path) {
  const generation = authGeneration;
  for (let attempt = 0; ; attempt++) {
    assertAuthGeneration(generation);
    try {
      return await api(path);
    } catch (e) {
      assertAuthGeneration(generation);
      if (e.status === 429 && e.reason !== "QUOTA_EXCEEDED" && attempt < 2 && e.retryAfterMs !== null && e.retryAfterMs <= 30_000) {
        await new Promise((resolve, reject) => {
          const signal = authController.signal;
          const cancel = () => { clearTimeout(timer); reject(new Error("Request canceled by sign-out.")); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, e.retryAfterMs);
          signal.addEventListener("abort", cancel, { once: true });
        });
        continue;
      }
      throw e;
    }
  }
}

// The authorized user's market takes precedence; do not retry unrelated errors
// with different query parameters.
async function addSongApiMarket(path) {
  return addSongApi(path);
}

// A track is usable only if it's a real, non-local, identifiable, playable
// Spotify track. Local files and unavailable tracks would create a tile that can
// never play (and a Sound row with no trackID), so we reject them up front.
function isUsableTrack(t) {
  return !!t &&
    t.type === "track" &&
    t.is_local !== true &&
    typeof t.id === "string" && t.id.length > 0 &&
    Number.isFinite(t.duration_ms) && t.duration_ms > 0 &&
    t.is_playable !== false;
}
function formatArtists(t) {
  return (t.artists || []).map(a => a.name).filter(Boolean).join(", ");
}

// Render one track result row (shared by search and playlist modes). Everything
// is built with textContent / DOM nodes — track, artist, album and playlist
// names are third-party strings and must never be injected as HTML.
function appendTrackRow(container, track) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "search-row";
  const main = document.createElement("span");
  main.className = "search-main";
  if (track.explicit) {
    const badge = document.createElement("span");
    badge.className = "explicit-badge";
    badge.title = "Explicit (may contain swearing)";
    badge.textContent = "🤬";
    main.appendChild(badge);
    row.classList.add("explicit");
  }
  main.appendChild(document.createTextNode(track.name || "(untitled)"));
  const sub = document.createElement("span");
  sub.className = "search-sub";
  const durSec = Math.round((track.duration_ms || 0) / 1000);
  const dur = `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, "0")}`;
  const album = (track.album && track.album.name) ? `  ·  ${track.album.name}` : "";
  sub.textContent = `${formatArtists(track)}${album}  ·  ${dur}`;
  row.appendChild(main);
  row.appendChild(sub);
  row.onclick = () => addTileForTrack(track);
  container.appendChild(row);
}

// Add (or reuse) the "Load more" button at the very end of a results container.
function setLoadMore(container, hasMore, onClick) {
  const old = container.querySelector(".load-more");
  if (old) old.remove();
  if (!hasMore) return;
  const btn = document.createElement("button");
  btn.className = "load-more";
  btn.textContent = "Load more";
  btn.onclick = onClick;
  container.appendChild(btn);
}

// --- Search mode ---
function onAddSearchInput(termRaw) {
  const term = (termRaw || "").trim();
  addSearchSeq++;
  addSearchState = { term, offset: 0, total: null, loading: false };
  if (addSearchTimer) clearTimeout(addSearchTimer);
  const results = document.getElementById("add-search-results");
  if (term.length < 2) {
    results.innerHTML = "<div class='hint'>Type a song or artist to search Spotify…</div>";
    return;
  }
  results.innerHTML = "<div class='hint'>Searching…</div>";
  // Debounce so a fast typist doesn't fire a request per keystroke.
  addSearchTimer = setTimeout(() => {
    addSearchState = { term, offset: 0, total: null, loading: false };
    runAddSearch(true);
  }, 300);
}
async function runAddSearch(reset) {
  const results = document.getElementById("add-search-results");
  const st = addSearchState;
  if (st.loading || !st.term) return;
  st.loading = true;
  const seq = ++addSearchSeq;
  try {
    const q = encodeURIComponent(st.term);
    const path = `/search?q=${q}&type=track&limit=${ADD_SEARCH_PAGE}&offset=${st.offset}`;
    const j = await addSongApiMarket(path);
    if (seq !== addSearchSeq) return;            // a newer search superseded this one
    const items = (j && j.tracks && j.tracks.items) || [];
    st.total = (j && j.tracks && typeof j.tracks.total === "number") ? j.tracks.total : null;
    if (reset) results.innerHTML = "";
    const usable = items.filter(isUsableTrack);
    usable.forEach(t => appendTrackRow(results, t));
    st.offset += items.length;
    if (reset && !results.querySelector(".search-row")) {
      results.innerHTML = "<div class='hint'>No playable tracks found.</div>";
    }
    const hasMore = items.length > 0 && (st.total === null || st.offset < st.total) && st.offset < 100;
    setLoadMore(results, hasMore, () => runAddSearch(false));
  } catch (e) {
    if (seq !== addSearchSeq) return;
    results.innerHTML = "";
    const err = document.createElement("div");
    err.className = "hint";
    err.textContent = "Search failed: " + (e && e.message ? e.message : String(e));
    results.appendChild(err);
  } finally {
    st.loading = false;
  }
}

// --- Playlist mode ---
function showPlaylistList() {
  addPlaylistSeq++;
  playlistsState = { offset: 0, total: null, loading: false };
  document.getElementById("add-playlist-back").classList.add("hidden");
  plTracksState = { id: null, name: "", offset: 0, total: null, loading: false };
}
async function loadPlaylists(reset) {
  const list = document.getElementById("add-playlist-results");
  const st = playlistsState;
  if (st.loading) return;
  st.loading = true;
  const seq = ++addPlaylistSeq;
  if (reset) { st.offset = 0; st.total = null; list.innerHTML = "<div class='hint'>Loading your playlists…</div>"; }
  try {
    const j = await addSongApi(`/me/playlists?limit=${ADD_PLAYLIST_PAGE}&offset=${st.offset}`);
    if (seq !== addPlaylistSeq) return;
    const items = (j && j.items) || [];
    st.total = (j && typeof j.total === "number") ? j.total : null;
    if (reset) list.innerHTML = "";
    items.forEach(pl => {
      if (!pl || !pl.id) return;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "search-row";
      const main = document.createElement("span");
      main.className = "search-main";
      main.textContent = pl.name || "(untitled playlist)";
      const sub = document.createElement("span");
      sub.className = "search-sub";
      const count = (pl.items && typeof pl.items.total === "number") ? `${pl.items.total} items` : "";
      const owner = (pl.owner && pl.owner.display_name) ? `by ${pl.owner.display_name}` : "";
      sub.textContent = [count, owner].filter(Boolean).join("  ·  ");
      row.appendChild(main);
      row.appendChild(sub);
      row.onclick = () => openPlaylist(pl.id, pl.name || "(untitled playlist)");
      list.appendChild(row);
    });
    st.offset += items.length;
    if (reset && !list.querySelector(".search-row")) {
      list.innerHTML = "<div class='hint'>No playlists found.</div>";
    }
    const hasMore = items.length > 0 && (st.total === null || st.offset < st.total) && st.offset < 500;
    setLoadMore(list, hasMore, () => loadPlaylists(false));
  } catch (e) {
    if (seq !== addPlaylistSeq) return;
    list.innerHTML = "";
    const err = document.createElement("div");
    err.className = "hint";
    const msg = (e && e.message) ? e.message : String(e);
    err.textContent = /403|insufficient/i.test(msg)
      ? "Couldn't read playlists. Check the developer app's allowlist and playlist-read permissions in Spotify."
      : "Couldn't load playlists: " + msg;
    list.appendChild(err);
  } finally {
    st.loading = false;
  }
}
function openPlaylist(id, name) {
  addPlaylistSeq++;
  document.getElementById("add-playlist-back").classList.remove("hidden");
  document.getElementById("add-playlist-name").textContent = name;
  plTracksState = { id, name, offset: 0, total: null, loading: false };
  document.getElementById("add-playlist-results").innerHTML = "<div class='hint'>Loading tracks…</div>";
  loadPlaylistTracks(true);
}
async function loadPlaylistTracks(reset) {
  const list = document.getElementById("add-playlist-results");
  const st = plTracksState;
  if (st.loading || !st.id) return;
  st.loading = true;
  const seq = ++addPlaylistSeq;
  try {
    // Use /items (not /tracks): Spotify now returns 403 on /playlists/{id}/tracks
    // for this app, while /items works. The track object lives under `item`.
    const path = `/playlists/${encodeURIComponent(st.id)}/items?limit=${ADD_TRACKS_PAGE}&offset=${st.offset}`;
    const j = await addSongApiMarket(path);
    if (seq !== addPlaylistSeq) return;
    const items = (j && j.items) || [];
    st.total = (j && typeof j.total === "number") ? j.total : null;
    if (reset) list.innerHTML = "";
    items.map(it => it && (it.item || it.track)).filter(isUsableTrack).forEach(t => appendTrackRow(list, t));
    st.offset += items.length;
    if (reset && !list.querySelector(".search-row")) {
      list.innerHTML = "<div class='hint'>No playable tracks on this playlist.</div>";
    }
    const hasMore = items.length > 0 && (st.total === null || st.offset < st.total) && st.offset < 2000;
    setLoadMore(list, hasMore, () => loadPlaylistTracks(false));
  } catch (e) {
    if (seq !== addPlaylistSeq) return;
    list.innerHTML = "";
    const err = document.createElement("div");
    err.className = "hint";
    err.textContent = "Couldn't load tracks: " + (e && e.message ? e.message : String(e));
    list.appendChild(err);
  } finally {
    st.loading = false;
  }
}

// --- Adding a chosen track to the current tab ---

// Return the soundUUIDRaw for this Spotify track, reusing an existing Sound row
// when one already references the same trackID (mirrors how copyCell shares a
// Sound across tiles) and minting a fresh Sound row in the expected format
// otherwise. We never rewrite an existing Sound's metadata, so old tiles are
// untouched.
function resolveSoundUUID(track) {
  const existing = queryAll("SELECT soundUUIDRaw AS u FROM Sound WHERE trackID = ?", [track.id]);
  if (existing.length) return existing[0].u;
  const uuid = newUuid();
  const now = Date.now() / 1000;
  db.run(`INSERT INTO Sound
    (soundUUIDRaw, soundTypeRaw, title, artist, albumTitle, playbackDuration,
     fileTypeRaw, fileURLPath, persistentID, playbackStoreID, trackID, localTrackURI,
     createdTimestamp1970, updatedTimestamp1970, persistentIDRaw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid, 2, track.name || "", formatArtists(track),
     (track.album && track.album.name) || "", (track.duration_ms || 0) / 1000,
     "public.audio", "file:///", 0, "", track.id, "",
     now, now, "0"]);
  return uuid;
}

function addTileForTrack(track) {
  if (!db) return;
  if (!isUsableTrack(track)) {
    alert("That track can't be added (it may be a local file or unavailable in your region).");
    return;
  }
  const g = groups[activeTabIdx];
  if (!g) { alert("Create or open a tab first."); return; }
  let name = (track.name || "").trim().slice(0, 200) || "(untitled)";
  name = uniqueTileName(name, groupTileNames(g.uuid, null));
  const maxRow = queryAll("SELECT COALESCE(MAX(orderIndex), -1) AS m FROM Playback WHERE playbackGroupUUIDRaw = ?", [g.uuid]);
  const newOrder = (maxRow[0]?.m ?? -1) + 1;
  const now = Date.now() / 1000;
  // Preserve the fractional duration across the schema's seconds/subseconds.
  const stopSecs = Math.floor((track.duration_ms || 0) / 1000);
  // Both inserts happen together: if the Playback insert fails we don't want a
  // stranded Sound row, so wrap them in a transaction.
  if (!mutateDatabase(() => {
    const soundUUID = resolveSoundUUID(track);
    db.run(`INSERT INTO Playback
      (playbackUUIDRaw, playbackGroupUUIDRaw, sourceUUIDRaw, orderIndex, displayTitle, altTitle,
       volume, loopCount, willPlayOverRaw, willPlayNextSoundRaw, startAtSeconds, startAtSubSec,
       stopAtSeconds, stopAtSubSec, fadeInSeconds, fadeOutSeconds, hasBeenPlayedRaw, songCellColorRaw,
       hotKey, createdTimestamp1970, updatedTimestamp1970)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newUuid(), g.uuid, soundUUID, newOrder, name, "",
       -1, 0, 0, 0, 0, 0,
       stopSecs, (track.duration_ms - stopSecs * 1000) / 1000, -1, -1, 0, -1,
       "", now, now]);
  })) return;
  markTabOpDirty();
  renderGrid();
  restorePlayingHighlight();
  showToast(`Added “${name}” to ${g.name}`);
}

// Show the device pill's current state. Passing a name shows it in green
// ("connected"); passing nothing shows the red "⚙️ Set Device" call to action.
function setDevicePill(name) {
  const pill = document.getElementById("device-pill");
  if (!pill) return;
  if (name) {
    pill.textContent = name;
    pill.dataset.state = "ready";
  } else {
    pill.textContent = "⚙️ Set Device";
    pill.dataset.state = "none";
  }
}

// The standalone device picker (opened from the top-bar pill) reuses the very
// same list rendering as the Settings dialog.
function openDevicePicker() {
  setDialogOpen("device-modal", true);
  refreshDevices("device-picker-list");
}
function closeDevicePicker() {
  setDialogOpen("device-modal", false);
}

// Populate a device list (either the Settings one or the standalone picker).
// `listId` says which container to render into so both can share this code.
async function refreshDevices(listId = "device-list") {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = "<div class='hint'>Loading...</div>";
  try {
    const j = await api("/me/player/devices");
    const selected = (j.devices || []).find(device => device.id === activeDeviceId);
    if (selected) {
      activeDeviceCapabilities = selected;
      updateVolumeControls();
    }
    list.innerHTML = "";
    (j.devices || []).forEach(d => {
      const div = document.createElement("div");
      div.className = "device" + (d.id === activeDeviceId ? " active" : "");
      const left = document.createElement("div");
      // Device name/type come from the Spotify API — build with textContent (not
      // innerHTML) so a device named with HTML can't inject markup into our page.
      const nameEl = document.createElement("strong");
      nameEl.textContent = d.name;
      const typeEl = document.createElement("div");
      typeEl.className = "hint";
      typeEl.textContent = `${d.type}${d.is_active ? " · active" : ""}`;
      left.appendChild(nameEl);
      left.appendChild(typeEl);
      const btn = document.createElement("button");
      btn.textContent = d.is_restricted ? "Control unavailable" : "Use";
      btn.disabled = !!d.is_restricted;
      btn.onclick = async () => {
        const transferred = await queueTransport("Device transfer", async current => {
          await api("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [d.id], play: false }) });
          if (!current()) return;
          clearIdlePlayback(true);
          setNowPlaying(null);
          localStorage.setItem(LS_DEVICE, d.id);
          localStorage.setItem(LS_DEVICE_NAME, d.name);
          activeDeviceId = d.id;
          activeDeviceCapabilities = d;
          updateVolumeControls();
          setDevicePill(d.name);
          closeDevicePicker();
        }, () => btn.click());
        if (transferred) {
          void refreshDevices("device-list");
          void checkIdlePlayback();
        }
      };
      div.appendChild(left); div.appendChild(btn);
      list.appendChild(div);
    });
    if (!list.children.length) list.innerHTML = "<div class='hint'>No devices found. Open Spotify on the device.</div>";
  } catch (e) {
    // Build with textContent so an error string can't inject markup.
    list.innerHTML = "";
    const err = document.createElement("div");
    err.className = "hint";
    err.textContent = "Error: " + (e && e.message ? e.message : String(e));
    list.appendChild(err);
  }
}

function updateAuthButtons() {
  const loggedIn = !!(getAuth() && getAuth().refreshToken);
  const loginBtn = document.getElementById("btn-login-spotify");
  const logoutBtn = document.getElementById("btn-logout-spotify");
  if (loginBtn) loginBtn.textContent = loggedIn ? "Re-log in with Spotify" : "Log in with Spotify";
  if (logoutBtn) logoutBtn.classList.remove("hidden");
}

let logoutExportGeneration = 0;
let logoutExportRevision = null;
function openLogout() {
  logoutExportGeneration++;
  logoutExportRevision = null;
  document.getElementById("logout-status").textContent = "";
  document.getElementById("btn-logout-saved").classList.add("hidden");
  setDialogOpen("logout-modal", true);
}

async function prepareLogoutExport() {
  const generation = ++logoutExportGeneration;
  const status = document.getElementById("logout-status");
  document.getElementById("btn-logout-saved").classList.add("hidden");
  try {
    if (!db) throw new Error("There is no loaded database to export. Cancel to load recovery data, or explicitly erase without export.");
    const revision = getWorkingDatabaseRevision();
    const bytes = await exportWorkingDatabase();
    if (generation !== logoutExportGeneration) return;
    if (revision !== getWorkingDatabaseRevision()) throw new Error("The database changed during export. Export again before erasing.");
    triggerDownload(bytes, "DJDad-export.sqlite");
    logoutExportRevision = revision;
    status.textContent = "Download requested. Check that the file was saved and can be found before confirming erase. Cancel if the download failed.";
    status.className = "status";
    document.getElementById("btn-logout-saved").classList.remove("hidden");
  } catch (e) {
    if (generation !== logoutExportGeneration) return;
    status.textContent = `Export was not completed. Your browser data has not been erased. ${e.message}`;
    status.className = "status err";
  }
}

async function confirmExportedLogout() {
  if (logoutExportRevision === null || logoutExportRevision !== getWorkingDatabaseRevision()) {
    document.getElementById("logout-status").textContent = "Your work changed since export. Export again before erasing.";
    document.getElementById("btn-logout-saved").classList.add("hidden");
    return;
  }
  await eraseBrowserData();
}

// Inspect recovery without creating an empty database after a completed erase.
// Call under the auth/erase lock, but close existing connections BEFORE waiting
// for that lock: its current owner may already be waiting for IDB deletion.
function readExistingRecoveryBinding() {
  return new Promise((resolve, reject) => {
    let absent = false;
    const request = indexedDB.open(IDB_NAME);
    request.onupgradeneeded = event => {
      if (event.oldVersion === 0) { absent = true; request.transaction.abort(); }
    };
    request.onerror = () => absent ? resolve(null) : reject(new Error("Recovery could not be checked. Keep this tab open and retry."));
    request.onsuccess = () => {
      const connection = request.result;
      databaseConnections.add(connection);
      connection.onversionchange = () => connection.close();
      const close = () => { databaseConnections.delete(connection); connection.close(); };
      if (!connection.objectStoreNames.contains(IDB_STORE)) { close(); resolve({ identity: null }); return; }
      const transaction = connection.transaction(IDB_STORE, "readonly");
      const read = transaction.objectStore(IDB_STORE).get(IDB_KEY);
      let binding = null;
      read.onsuccess = () => { if (read.result) binding = { identity: read.result.identity ?? null }; };
      transaction.oncomplete = () => { close(); resolve(binding); };
      transaction.onabort = transaction.onerror = () => {
        close();
        reject(new Error("Recovery could not be checked. Keep this tab open and retry."));
      };
    };
  });
}

function eraseOwnedStorage(store, keepSignal = false) {
  authStorage(() => {
    const keys = Array.from({ length: store.length }, (_, index) => store.key(index));
    keys.filter(key => key?.startsWith("s9000.") && !(keepSignal && key === LS_ERASE))
      .forEach(key => store.removeItem(key));
  });
}

function clearErasedDatabaseView() {
  clearDatabaseState();
  document.getElementById("in-db-file").value = "";
  document.getElementById("grid").replaceChildren();
  document.getElementById("tabs").replaceChildren();
  document.getElementById("empty-state").classList.remove("hidden");
  document.getElementById("db-status").textContent = "No database loaded.";
  if (wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    void lock.release().catch(() => {});
  }
  updateSaveBadge();
}

function clearErasedBrowserView(preserveCurrentSettings = false) {
  clearErasedDatabaseView();
  activeDeviceId = null;
  activeDeviceCapabilities = null;
  document.getElementById("in-client-id").value = "";
  document.getElementById("device-list").replaceChildren();
  document.getElementById("device-picker-list").replaceChildren();
  for (const id of ["search-results", "add-search-results", "add-playlist-results", "ctx-menu"]) {
    document.getElementById(id).replaceChildren();
  }
  for (const id of ["search-input", "add-search-input"]) document.getElementById(id).value = "";
  document.getElementById("add-playlist-name").textContent = "";
  document.getElementById("add-song-target").textContent = "";
  document.getElementById("in-volume").value = "70";
  document.getElementById("vol-label").textContent = "70";
  document.getElementById("in-fade-in").value = "0";
  document.getElementById("fade-in-label").textContent = "0";
  document.getElementById("in-fade-out").value = "2";
  document.getElementById("fade-out-label").textContent = "2";
  trackPlayedOn = true;
  document.getElementById("track-played").checked = true;
  applyDefaultColor();
  document.getElementById("in-default-color").value = String(DEFAULT_COLOR_FALLBACK);
  if (preserveCurrentSettings) {
    for (const [key, input, label, fallback] of [
      [LS_VOLUME, "in-volume", "vol-label", "70"],
      [LS_FADE_IN, "in-fade-in", "fade-in-label", "0"],
      [LS_FADE_OUT, "in-fade-out", "fade-out-label", "2"],
    ]) {
      const control = document.getElementById(input);
      control.value = authStorage(() => localStorage.getItem(key)) ?? fallback;
      document.getElementById(label).textContent = control.value;
    }
    trackPlayedOn = authStorage(() => localStorage.getItem(LS_TRACK_PLAYED)) !== "0";
    document.getElementById("track-played").checked = trackPlayedOn;
    document.getElementById("in-default-color").value = String(getDefaultColor());
  }
  updateTrackPlayedControl();
  setDevicePill(null);
  updateVolumeControls();
  updateIdleControls();
}

async function eraseBrowserData() {
  if (erasingBrowser) return false;
  const dialog = document.getElementById("logout-modal");
  const status = document.getElementById("logout-status");
  setDialogOpen("logout-modal", true);
  dialog.querySelectorAll("button").forEach(button => { button.disabled = true; });
  status.textContent = "Erasing this app's browser data...";
  let signal = null;
  try {
    requireAuthLocks();
    authStorage(() => { localStorage.getItem(LS_AUTH); sessionStorage.getItem(LS_PKCE); });
    logoutExportGeneration++;
    explicitErasing = erasingBrowser = true;
    // Close/abort this tab's IDB activity before joining a possibly busy gate.
    await invalidateDatabaseWork();
    await withAuthLock(async () => {
      const cached = await readExistingRecoveryBinding();
      signal = JSON.stringify({
        version: 1, id: crypto.randomUUID(), startedAt: Date.now(),
        identities: [databaseIdentity, cached?.identity].filter(identity => typeof identity === "string"),
      });
      authStorage(() => localStorage.setItem(LS_ERASE, signal));
      try {
        invalidateAuthWork();
        invalidateLoginWork();
        invalidateSearchWork();
        invalidateTransportWork();
        eraseOwnedStorage(localStorage, true);
        eraseOwnedStorage(sessionStorage);
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(IDB_NAME);
          request.onsuccess = resolve;
          request.onerror = () => reject(new Error("The browser could not erase the cached database. Retry cleanup."));
          request.onblocked = () => {
            status.textContent = "Waiting to erase the database. Close other DJDad tabs using this origin; cleanup will continue.";
          };
        });
        clearErasedBrowserView();
        // The signal and lock stay live until ALL shared deletion has finished.
        eraseOwnedStorage(localStorage, true);
        eraseOwnedStorage(sessionStorage);
      } finally {
        if (authStorage(() => localStorage.getItem(LS_ERASE)) === signal) {
          authStorage(() => localStorage.removeItem(LS_ERASE));
        }
      }
    });
    status.textContent = "";
    setDialogOpen("logout-modal", false);
    showModal(true);
    document.getElementById("auth-status").textContent = "Logged out; this app's browser data was erased. Spotify playback may continue on your device.";
    document.getElementById("auth-status").className = "status ok";
    updateAuthButtons();
    return true;
  } catch (e) {
    status.textContent = `Cleanup did not complete. ${e.message}`;
    status.className = "status err";
    return false;
  } finally {
    explicitErasing = false;
    erasingBrowser = activePeerErases > 0;
    dialog.querySelectorAll("button").forEach(button => { button.disabled = false; });
  }
}

function reconcileSavedAuth() {
  const savedAuth = authStorage(() => localStorage.getItem(LS_AUTH));
  if ((accessTokenAuth !== null && savedAuth !== accessTokenAuth) ||
      (refreshPromise && savedAuth !== refreshAuth)) invalidateAuthWork();
  updateAuthButtons();
}

function reconcilePeerErase(rawSignal) {
  const signal = parseLogin(rawSignal);
  if (signal?.version !== 1 || typeof signal.id !== "string" || !Number.isSafeInteger(signal.startedAt) ||
      !Array.isArray(signal.identities) || signal.identities.some(identity => typeof identity !== "string")) return Promise.resolve();
  for (const connection of databaseConnections) connection.close();
  if (explicitErasing) return Promise.resolve();
  if (peerEraseTasks.has(signal.id)) return peerEraseTasks.get(signal.id);
  let active = false;
  const task = (async () => {
    active = authStorage(() => localStorage.getItem(LS_ERASE)) === rawSignal;
    let quiet = Promise.resolve();
    let localValues = [];
    if (active) {
      activePeerErases++;
      erasingBrowser = true;
      invalidateAuthWork();
      invalidateLoginWork();
      invalidateSearchWork();
      invalidateTransportWork();
      quiet = invalidateDatabaseWork();
      localValues = authStorage(() => Array.from({ length: sessionStorage.length }, (_, index) => {
        const key = sessionStorage.key(index);
        return [key, sessionStorage.getItem(key)];
      }).filter(([key]) => key?.startsWith("s9000.")));
    }
    const snapshot = {
      database: db, identity: databaseIdentity, installedAt: databaseInstalledAt,
      epoch: databaseEpoch, sequence: importSequence,
      clientInput: document.getElementById("in-client-id").value,
    };
    await quiet;
    await withAuthLock(async () => {
      const cached = await readExistingRecoveryBinding();
      reconcileSavedAuth();
      const raw = authStorage(() => sessionStorage.getItem(LS_PKCE));
      const pkce = parseLogin(raw);
      const registration = pkce?.state ? loginRegistration(pkce) : null;
      const liveLogin = validLoginBinding(pkce) && sameLoginBinding(pkce, registration);
      if (raw && !liveLogin && authStorage(() => sessionStorage.getItem(LS_PKCE)) === raw) {
        authStorage(() => sessionStorage.removeItem(LS_PKCE));
      }
      for (const [key, value] of localValues) {
        if (key === LS_PKCE && liveLogin) continue;
        if (authStorage(() => sessionStorage.getItem(key)) === value) authStorage(() => sessionStorage.removeItem(key));
      }
      const oldBinding = active || signal.identities.includes(snapshot.identity) || snapshot.installedAt < signal.startedAt;
      const sameDatabase = () => db === snapshot.database && databaseIdentity === snapshot.identity &&
        databaseEpoch === snapshot.epoch && importSequence === snapshot.sequence;
      let locallyRevoked = false;
      if (oldBinding && sameDatabase() && (active || (!databaseImporting && !saveInProgress)) &&
          (!cached || cached.identity !== snapshot.identity)) {
        if (!active) {
          // Only revoked local work is canceled; never delete shared recovery.
          quiet = invalidateDatabaseWork();
          snapshot.epoch = databaseEpoch;
          snapshot.sequence = importSequence;
          await quiet;
        }
        if (sameDatabase()) {
          invalidateSearchWork();
          invalidateTransportWork();
          clearErasedDatabaseView();
          locallyRevoked = true;
        }
      }
      const savedAuth = getAuth();
      if (savedAuth) {
        document.getElementById("in-client-id").value = savedAuth.clientId;
      } else if (!liveLogin && !cached && !db) {
        if (active && locallyRevoked) {
          const currentInput = document.getElementById("in-client-id").value;
          clearErasedBrowserView(true);
          if (currentInput !== snapshot.clientInput) document.getElementById("in-client-id").value = currentInput;
        }
        if (active && document.getElementById("in-client-id").value === snapshot.clientInput) {
          document.getElementById("in-client-id").value = "";
        }
        if (!authStorage(() => localStorage.getItem(LS_DEVICE))) {
          activeDeviceId = activeDeviceCapabilities = null;
          setDevicePill(null);
          updateVolumeControls();
        }
        document.getElementById("auth-status").textContent = "Another DJDad tab logged out; this app's browser data was erased. Spotify playback may continue on your device.";
        document.getElementById("auth-status").className = "status ok";
        showModal(true);
      }
    });
  })().catch(error => {
    document.getElementById("auth-status").textContent = `Other-tab cleanup could not be checked. ${error.message}`;
    document.getElementById("auth-status").className = "status err";
  }).finally(() => {
    if (active) activePeerErases--;
    erasingBrowser = explicitErasing || activePeerErases > 0;
    if (peerEraseTasks.get(signal.id) === task) peerEraseTasks.delete(signal.id);
  });
  peerEraseTasks.set(signal.id, task);
  return task;
}

window.addEventListener("storage", e => {
  if (e.key === LS_ERASE && e.newValue) void reconcilePeerErase(e.newValue);
  else if (e.key === LS_AUTH) {
    try { reconcileSavedAuth(); }
    catch (error) {
      document.getElementById("auth-status").textContent = error.message;
      document.getElementById("auth-status").className = "status err";
    }
  } else if (e.key === LS_IPAD_KEEPALIVE) {
    cancelIdleCheck();
    idleBlocked = false;
    idleFailure = null;
    updateIdleControls();
    if (idleReady && idleEnabled()) void checkIdlePlayback();
  }
});

window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  for (const connection of databaseConnections) connection.close();
  const reconcile = async () => {
    const signal = authStorage(() => localStorage.getItem(LS_ERASE));
    if (signal) { await reconcilePeerErase(signal); return; }
    reconcileSavedAuth();
    await reconcilePendingLogin();
  };
  void reconcile().catch(error => {
    document.getElementById("auth-status").textContent = error.message;
    document.getElementById("auth-status").className = "status err";
  });
});

async function tryAuthHandshake() {
  const generation = authGeneration;
  try {
    await getAccessToken();
    const me = await api("/me");
    if (generation !== authGeneration || erasingBrowser) return false;
    document.getElementById("auth-status").textContent = `Connected${me.display_name ? ` as ${me.display_name}` : " to Spotify"}`;
    document.getElementById("auth-status").className = "status ok";
    return true;
  } catch (e) {
    if (generation !== authGeneration || erasingBrowser) return false;
    document.getElementById("auth-status").textContent = e.message;
    document.getElementById("auth-status").className = "status err";
    return false;
  }
}

// =====================================================================
// "Buy Me a Fake Beer" — a harmless Rickroll Easter egg
// ---------------------------------------------------------------------
// Clicking the button in Settings closes the dialog, starts Rick Astley's
// "Never Gonna Give You Up" on the active device, and rains confetti over the
// whole screen. The confetti canvas sits on top of everything and counts
// clicks; it takes two clicks anywhere to stop the song and clear the confetti.
// =====================================================================
const RICKROLL_TRACK_ID = "4uLU6hMCjMI75M1A2tKUQC"; // Never Gonna Give You Up
let confettiState = null; // { canvas, raf, resize, onClick, clicks } while running

async function playFakeBeer() {
  // The prior song is about to be replaced by the Rickroll, which we fire via a
  // raw API call that the progress bar doesn't track. Clear the now-playing
  // state so the stale progress bar disappears instead of pretending the old
  // song is still going.
  invalidateTransportWork();
  startConfetti();
  try {
    const dev = await ensureDevice();
    await setVolume(getDefaultVolumePct());
    await api(`/me/player/play?device_id=${encodeURIComponent(dev)}`, {
      method: "PUT",
      body: JSON.stringify({ uris: [`spotify:track:${RICKROLL_TRACK_ID}`] }),
    });
  } catch (e) {
    // No device / playback error: the confetti gag still runs, the song just
    // can't play. We deliberately don't nag the user mid-joke.
  }
}

// Tear down the gag: stop the music and remove the confetti.
async function dismissFakeBeer() {
  stopConfetti();
  try { await stopPlayback(); } catch (e) {}
}

function startConfetti() {
  stopConfetti(); // never stack two canvases
  const canvas = document.createElement("canvas");
  canvas.id = "confetti-canvas";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
  resize();

  const colors = ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93", "#1db954", "#ff7b00"];
  const particles = [];
  for (let i = 0; i < 540; i++) {  // doubled density (was 270)
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * -canvas.height,          // start above the top edge
      w: 6 + Math.random() * 8, h: 8 + Math.random() * 10,
      vy: 2 + Math.random() * 4, vx: -1 + Math.random() * 2,
      rot: Math.random() * Math.PI, vr: -0.1 + Math.random() * 0.2,
      color: colors[Math.floor(Math.random() * colors.length)],
    });
  }

  const state = { canvas, raf: 0, resize, onClick: null, clicks: 0, closeBtn: null };
  confettiState = state;

  const tick = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.y += p.vy; p.x += p.vx; p.rot += p.vr;
      if (p.y > canvas.height + 20) { p.y = -20; p.x = Math.random() * canvas.width; } // recycle to top
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);

  window.addEventListener("resize", resize);

  // A dedicated X button in the top-right corner ends the gag with a single
  // click. (It sits above the canvas and stops the click from also counting
  // toward the "tap anywhere" tally below.)
  const closeBtn = document.createElement("button");
  closeBtn.id = "confetti-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close";
  closeBtn.setAttribute("aria-label", "Close confetti");
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); dismissFakeBeer(); });
  document.body.appendChild(closeBtn);
  state.closeBtn = closeBtn;

  // Tapping anywhere else on the canvas takes three clicks to dismiss the gag.
  state.onClick = () => {
    state.clicks++;
    if (state.clicks >= 3) dismissFakeBeer();
  };
  canvas.addEventListener("click", state.onClick);
}

function stopConfetti() {
  if (!confettiState) return;
  cancelAnimationFrame(confettiState.raf);
  window.removeEventListener("resize", confettiState.resize);
  if (confettiState.onClick) confettiState.canvas.removeEventListener("click", confettiState.onClick);
  if (confettiState.closeBtn) confettiState.closeBtn.remove();
  confettiState.canvas.remove();
  confettiState = null;
}

// =====================================================================
// Boot
// =====================================================================
window.addEventListener("DOMContentLoaded", async () => {
  // If we're returning from a Spotify login redirect, finish the token exchange
  // before anything else so the rest of boot sees a logged-in state.
  const authResult = await handleAuthRedirect();
  wireAccessibleControls();

  // restore device pill
  const dev = localStorage.getItem(LS_DEVICE);
  if (dev) {
    activeDeviceId = dev;
    setDevicePill(localStorage.getItem(LS_DEVICE_NAME) || "Device set");
  } else {
    setDevicePill(null);
  }

  // The device pill is clickable (and keyboard-focusable) — it opens the picker.
  const devicePill = document.getElementById("device-pill");
  devicePill.onclick = openDevicePicker;
  devicePill.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDevicePicker(); }
  });
  document.getElementById("btn-refresh-devices-picker").onclick = () => refreshDevices("device-picker-list");
  document.getElementById("btn-close-device-modal").onclick = closeDevicePicker;
  wireVolRail();
  updateVolumeControls();
  wireFullscreenControls();
  wireIdlePlaybackControls();

  // wire buttons
  document.getElementById("btn-settings").onclick = () => showModal(true);
  document.getElementById("btn-close-modal").onclick = () => showModal(false);
  // Quick find (🔍) wiring
  document.getElementById("btn-search").onclick = () => openSearch();
  document.getElementById("btn-close-search").onclick = () => closeSearch();
  // Add song (➕) wiring
  document.getElementById("btn-add-song").onclick = () => openAddSong();
  document.getElementById("btn-close-add-song").onclick = () => closeAddSong();
  document.getElementById("add-mode-search").onclick = () => setAddMode("search");
  document.getElementById("add-mode-playlist").onclick = () => setAddMode("playlist");
  document.getElementById("btn-playlist-back").onclick = () => { showPlaylistList(); loadPlaylists(true); };
  document.getElementById("add-search-input").addEventListener("input", (e) => onAddSearchInput(e.target.value));
  document.getElementById("add-search-input").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAddSong();
  });
  document.getElementById("search-input").addEventListener("input", (e) => runSearch(e.target.value));
  document.getElementById("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSearch(); return; }
    if (e.key === "Enter") {
      // Enter activates the first result, if any.
      const first = document.querySelector("#search-results .search-row:not(.disabled)");
      if (first) first.click();
    }
  });
  document.getElementById("np-pause").onclick = async () => {
    if (!nowPlaying) return;
    if (nowPlaying.paused) await resumePlayback();
    else await pausePlayback();
  };
  document.getElementById("np-stop").onclick = async () => { await stopPlayback(); };
  // Toolbar stop button: one tap halts playback from anywhere, even when the
  // now-playing footer isn't in view.
  document.getElementById("btn-stop-all").onclick = async () => {
    try { await stopPlayback(); } catch (e) { handlePlaybackError(e); }
  };
  document.getElementById("np-delete").onclick = () => {
    if (!nowPlaying) return;
    toggleCellDelete(nowPlaying.uuid);
  };
  // Click the now-playing song title to rename that tile (same dialog as the
  // right-click "Rename song…").
  document.getElementById("np-title").onclick = () => {
    if (nowPlaying) renameCell(nowPlaying.uuid);
  };
  document.getElementById("btn-save").onclick = commitChanges;
  // "Track Played" switch + "Clear" button (top-right). Restore the saved switch
  // position first (defaults to on), then keep it in sync as the user toggles it.
  setTrackPlayed(localStorage.getItem(LS_TRACK_PLAYED) !== "0");
  const trackPlayedCb = document.getElementById("track-played");
  if (trackPlayedCb) trackPlayedCb.onchange = () => setTrackPlayed(trackPlayedCb.checked);
  const clearPlayedBtn = document.getElementById("btn-clear-played");
  if (clearPlayedBtn) clearPlayedBtn.onclick = clearPlayedOnTab;
  // Wire up the scrollable tab strip (arrows, drag, edge fades).
  setupTabScroller();
  document.getElementById("btn-refresh-db").onclick = () => {
    pickDatabaseFile();
  };
  buildSwatches();

  // Dismiss the cell context menu on outside click or Escape
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("ctx-menu");
    if (menu && !menu.classList.contains("hidden") && !menu.contains(e.target)) {
      hideCellContextMenu();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideCellContextMenu();
  });
  // Suppress the default browser context menu inside the menu itself
  document.getElementById("ctx-menu").addEventListener("contextmenu", (e) => e.preventDefault());

  // Unsaved-changes guard: if the operator has staged edits (color/cue/volume/
  // hotkey/move/delete changes that haven't been written to disk with Save) and
  // tries to close or reload the tab, ask the browser to show its native "Leave
  // site?" confirmation so the work isn't lost by accident.
  window.addEventListener("beforeunload", (e) => {
    if (pendingCount() > 0) {
      e.preventDefault();
      e.returnValue = "";
      return "";
    }
  });

  // Keyboard shortcuts (act on the keyboard-focused cell):
  //  - Arrow keys       : move focus
  //  - Space            : global play/pause (or start focused cell)
  //  - Enter            : play/pause the focused cell
  //  - A..Z             : fire the matching tile's hotkey on this tab
  //  - 0..9             : recolor the focused cell
  //  - Delete/Backspace : toggle pending-delete on the focused cell
  //  - Ignore when typing in an input field
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.defaultPrevented || e.repeat) return;
    if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (t?.closest('button, a, [role="button"]') && !t.closest(".cell")) return;
    if (t?.closest("#ctx-menu")) return;
    // Don't let grid/transport shortcuts fire while a dialog overlay is open
    // (Settings, the device picker, or quick-find). Otherwise, e.g., pressing a
    // letter behind an open dialog could start a song unexpectedly.
    const overlayOpen = document.querySelector('[role="dialog"]:not(.hidden)');
    if (overlayOpen) return;
    const key = e.key;
    // Ignore anything held with a system/browser modifier (Ctrl/Cmd/Alt) so we
    // don't hijack shortcuts like Ctrl+R/Cmd+L or fire a tile hotkey by accident.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (key === "ContextMenu" || (key === "F10" && e.shiftKey)) {
      const cell = t?.closest(".cell");
      if (cell) {
        e.preventDefault();
        const rect = cell.getBoundingClientRect();
        showCellContextMenu(cell, rect.left, rect.bottom);
        document.querySelector("#ctx-menu .ctx-item:not(:disabled)")?.focus();
      }
      return;
    }

    if (key === "ArrowLeft" || key === "ArrowRight") {
      // If a bar marker is focused, ←/→ adjusts it by ±5s instead of moving cell focus
      if (barFocused && progress) {
        e.preventDefault();
        const delta = (key === "ArrowLeft" ? -5000 : 5000);
        if (barFocused === "dot") {
          seekTo(currentPositionMs() + delta, true);
        } else if (barFocused === "caret" && nowPlaying) {
          const newMs = effectiveStartMs() + delta;
          setPendingStart(nowPlaying.uuid, newMs);
          seekTo(newMs, true);
          // Pop up the fine-nudge slider, centred on this new cue point.
          showCueFine(newMs, "start");
        } else if (barFocused === "stop" && nowPlaying) {
          const newMs = effectiveStopMs(nowPlaying.uuid) + delta;
          setStopFromBar(newMs);
        }
        return;
      }
      e.preventDefault();
      moveFocus(key === "ArrowLeft" ? -1 : 1, 0);
      return;
    }
    if (key === "ArrowUp")    { e.preventDefault(); moveFocus(0, -1); return; }
    if (key === "ArrowDown")  { e.preventDefault(); moveFocus(0,  1); return; }

    if (key === "Escape") {
      // clear bar focus
      if (barFocused) {
        barFocused = null;
        document.getElementById("np-bar-dot").classList.remove("focused");
        document.getElementById("np-bar-caret").classList.remove("focused");
        document.getElementById("np-bar-stop")?.classList.remove("focused");
      }
    }

    // Spacebar is a global transport toggle: if something is playing, pause/
    // resume it no matter which cell is focused (handy "tap to pause" during a
    // game). If nothing is playing but a cell is focused, start that cell.
    if (key === " ") {
      e.preventDefault();
      if (nowPlaying) {
        if (nowPlaying.paused) resumePlayback(); else pausePlayback();
      } else if (focusedCell) {
        smartSingleTap(focusedCell);
      }
      return;
    }

    // Letter keys A–Z are song hotkeys: instantly start the first tile on the
    // CURRENT tab whose assigned hotkey matches. This works regardless of which
    // cell is focused. (Letters are never used for anything else here.)
    if (/^[a-zA-Z]$/.test(key)) {
      const want = key.toUpperCase();
      const match = Array.from(document.querySelectorAll("#grid .cell"))
        .find(c => (c.dataset.hotkey || "") === want);
      if (match) {
        e.preventDefault();
        smartSingleTap(match);
        setFocusedCell(match);
        return;
      }
      // No tile uses this letter — fall through (does nothing).
    }

    if (!focusedCell) return;

    // Enter activates the focused cell (play / pause-resume / start as usual).
    if (key === "Enter") {
      e.preventDefault();
      smartSingleTap(focusedCell);
      return;
    }
    const color = keyToColor(key);
    if (color !== null) {
      e.preventDefault();
      setCellColor(focusedCell.dataset.pbuuid, color);
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      toggleCellDelete(focusedCell.dataset.pbuuid);
      return;
    }
  });
  document.getElementById("btn-load-db").onclick = () => {
    showModal(true);
    pickDatabaseFile();
  };
  document.getElementById("btn-refresh-devices").onclick = () => refreshDevices("device-list");
  document.getElementById("btn-fake-beer").onclick = () => { showModal(false); playFakeBeer(); };

  // Default-color picker (Appearance section in cog modal)
  const dcSel = document.getElementById("in-default-color");
  for (const c of S9000_COLORS) {
    const opt = document.createElement("option");
    opt.value = String(c.raw);
    opt.textContent = c.name;
    dcSel.appendChild(opt);
  }
  dcSel.value = String(getDefaultColor());
  dcSel.onchange = () => setDefaultColor(parseInt(dcSel.value, 10));
  applyDefaultColor();

  // Progress bar interactions: click to seek, drag dot to seek, drag caret to set start time.
  setupBarInteractions();

  // pre-fill auth fields + show the redirect URI to register
  const redirDisplay = document.getElementById("redirect-uri-display");
  if (redirDisplay) redirDisplay.textContent = redirectUri();
  const a = getAuth();
  if (a) {
    document.getElementById("in-client-id").value = a.clientId || "";
  }
  updateAuthButtons();

  // volume slider
  const volInput = document.getElementById("in-volume");
  const volLabel = document.getElementById("vol-label");
  const savedVol = parseInt(localStorage.getItem(LS_VOLUME) || "", 10);
  const initialVol = (!isNaN(savedVol) && savedVol >= 0 && savedVol <= 100) ? savedVol : 70;
  volInput.value = String(initialVol);
  volLabel.textContent = String(initialVol);
  volInput.addEventListener("input", () => {
    volLabel.textContent = volInput.value;
  });
  volInput.addEventListener("change", async () => {
    if (!canControlVolume()) return;
    const v = parseInt(volInput.value, 10);
    localStorage.setItem(LS_VOLUME, String(v));
    // Live-apply only if the playing track is inheriting the default volume —
    // a track with its own explicit volume shouldn't be overridden by a change
    // to the global default.
    if (nowPlaying && !nowPlaying.paused && cellRawVolume(nowPlaying.uuid) < 0) {
      await setVolume(v);
    }
    // Keep the per-track volume label/slider honest if the panel is open and the
    // track follows the default (its effective percentage just moved).
    if (nowPlaying && cellRawVolume(nowPlaying.uuid) < 0) {
      syncVolRail(v);
      const vslider = document.getElementById("np-vol-slider");
      const panel = document.getElementById("np-cue-fine");
      if (vslider && panel && !panel.classList.contains("hidden")) {
        vslider.value = String(v);
        updateVolLabel(v);
      }
    }
  });

  // fade-in / fade-out default sliders (seconds). Like volume, the web app keeps
  // its own override in localStorage and falls back to whatever value the loaded
  // database holds in AppSettings. These set the *defaults*; a tile can still
  // carry its own fade.
  const fadeInInput  = document.getElementById("in-fade-in");
  const fadeInLabel  = document.getElementById("fade-in-label");
  if (fadeInInput && fadeInLabel) {
    const init = getDefaultFadeInSec();
    fadeInInput.value = String(init);
    fadeInLabel.textContent = String(init);
    fadeInInput.addEventListener("input", () => { fadeInLabel.textContent = fadeInInput.value; });
    fadeInInput.addEventListener("change", () => {
      if (!canControlVolume()) return;
      localStorage.setItem(LS_FADE_IN, String(parseInt(fadeInInput.value, 10)));
    });
  }
  const fadeOutInput = document.getElementById("in-fade-out");
  const fadeOutLabel = document.getElementById("fade-out-label");
  if (fadeOutInput && fadeOutLabel) {
    const init = getDefaultFadeOutSec();
    fadeOutInput.value = String(init);
    fadeOutLabel.textContent = String(init);
    fadeOutInput.addEventListener("input", () => { fadeOutLabel.textContent = fadeOutInput.value; });
    fadeOutInput.addEventListener("change", () => {
      if (!canControlVolume()) return;
      localStorage.setItem(LS_FADE_OUT, String(parseInt(fadeOutInput.value, 10)));
    });
  }

  document.getElementById("btn-login-spotify").onclick = async () => {
    const clientId = document.getElementById("in-client-id").value.trim();
    const status = document.getElementById("auth-status");
    if (!clientId) {
      status.textContent = "Enter your Spotify Client ID first.";
      status.className = "status err";
      return;
    }
    status.textContent = "Redirecting to Spotify…";
    status.className = "status";
    try { await beginSpotifyLogin(clientId); }
    catch (error) {
      status.textContent = `Couldn't start login. ${error.message}`;
      status.className = "status err";
    }
  };

  document.getElementById("btn-logout-spotify").onclick = openLogout;
  document.getElementById("btn-logout-export").onclick = prepareLogoutExport;
  document.getElementById("btn-logout-saved").onclick = confirmExportedLogout;
  document.getElementById("btn-logout-discard").onclick = () => {
    if (confirm("Erase this app's browser database and unsaved edits WITHOUT exporting? Original files will not be deleted.")) {
      void eraseBrowserData();
    }
  };
  document.getElementById("btn-logout-cancel").onclick = () => setDialogOpen("logout-modal", false);

  document.getElementById("in-db-file").addEventListener("change", e => {
    void handleDatabaseFile(e.target.files[0]);
  });
  document.getElementById("btn-export-backup").onclick = () => {
    if (!baselineBytes) { showToast("No pre-edit snapshot is available in this browser."); return; }
    try { triggerDownload(baselineBytes, "DJDad-pre-edit.sqlite.backup"); }
    catch { reportDatabaseError("The backup download could not be started. Your browser snapshot was retained."); }
  };

  const bootEpoch = databaseEpoch;
  try {
    loadPending();
    updateSaveBadge();
    await restoreCachedDatabase();
  } catch {
    if (bootEpoch === databaseEpoch && !erasingBrowser) {
      reportDatabaseError("Browser recovery could not be opened. Existing data was preserved; do not erase it until your work is exported.");
    }
    document.getElementById("empty-state").classList.remove("hidden");
  }

  // Auth status: surface any redirect error, then connect if we have a token.
  if (authResult === "error" && authError) {
    const status = document.getElementById("auth-status");
    if (status) { status.textContent = authError; status.className = "status err"; }
    showModal(true);
  }
  updateAuthButtons();
  idleReady = true;
  if (getAuth() && getAuth().refreshToken) {
    if (await tryAuthHandshake()) {
      await refreshDevices();
      idleBlocked = false;
      await checkIdlePlayback();
    }
  }
});
