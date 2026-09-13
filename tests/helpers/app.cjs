const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");

const root = path.resolve(__dirname, "..", "..");

function createLockManager() {
  const locks = new Map();
  function advance(name, state) {
    if (state.held || !state.queue.length) return;
    state.held = true;
    const entry = state.queue.shift();
    const finish = (settle, value) => {
      state.held = false;
      advance(name, state);
      settle(value);
    };
    Promise.resolve().then(() => entry.callback({ name, mode: "exclusive" }))
      .then(value => finish(entry.resolve, value), error => finish(entry.reject, error));
  }
  return {
    request(name, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      if (!locks.has(name)) locks.set(name, { held: false, queue: [] });
      const state = locks.get(name);
      if (options.ifAvailable && (state.held || state.queue.length)) {
        return Promise.resolve().then(() => callback(null));
      }
      return new Promise((resolve, reject) => {
        state.queue.push({ callback, resolve, reject });
        advance(name, state);
      });
    },
    async query() {
      return {
        held: [...locks].filter(([, state]) => state.held).map(([name]) => ({ name, mode: "exclusive" })),
        pending: [...locks].flatMap(([name, state]) => state.queue.map(() => ({ name, mode: "exclusive" }))),
      };
    },
    isHeld: name => !!locks.get(name)?.held,
  };
}

function createOrigin({ autoEvents = true } = {}) {
  const entries = new Map();
  const documents = new Set();
  const events = [];
  const origin = { indexedDB: new IDBFactory(), locks: createLockManager(), autoEvents, failure: null };
  const dispatch = event => {
    if (documents.has(event.target)) event.target.dispatchEvent(new event.target.StorageEvent("storage", event.data));
  };
  origin.flushEvents = () => { events.splice(0).forEach(dispatch); };
  origin.attach = window => {
    documents.add(window);
    const check = (operation, key) => {
      if (origin.failure?.(operation, key)) throw new Error("Synthetic storage unavailable");
    };
    const notify = (key, oldValue, newValue) => {
      if (oldValue === newValue) return;
      for (const target of documents) if (target !== window) {
        const event = { target, data: { key, oldValue, newValue, url: window.location.href } };
        if (origin.autoEvents) queueMicrotask(() => dispatch(event));
        else events.push(event);
      }
    };
    const storage = {
      get length() { check("read"); return entries.size; },
      key(index) { check("read"); return [...entries.keys()][index] ?? null; },
      getItem(key) { check("read", String(key)); return entries.get(String(key)) ?? null; },
      setItem(key, value) {
        key = String(key); value = String(value);
        check("write", key);
        const oldValue = entries.get(key) ?? null;
        entries.set(key, value);
        notify(key, oldValue, value);
      },
      removeItem(key) {
        key = String(key);
        check("remove", key);
        const oldValue = entries.get(key) ?? null;
        entries.delete(key);
        notify(key, oldValue, null);
      },
      clear() {
        check("remove");
        entries.clear();
        notify(null, "present", null);
      },
    };
    return new Proxy(storage, {
      ownKeys: () => [...entries.keys()],
      getOwnPropertyDescriptor: (_, key) => entries.has(key) ? { configurable: true, enumerable: true, value: entries.get(key) } : undefined,
      get: (target, key) => key in target ? Reflect.get(target, key) : entries.get(key),
    });
  };
  origin.detach = window => documents.delete(window);
  return origin;
}

function createApp({ origin, url = "http://127.0.0.1:8000/", sessionStorage = {}, locks } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "docs", "index.html"), "utf8"), {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const listeners = window.addEventListener.bind(window);
  window.addEventListener = (type, listener, options) => {
    if (type === "DOMContentLoaded") {
      window.startApp = listener;
      return;
    }
    listeners(type, listener, options);
  };
  window.indexedDB = origin?.indexedDB || new IDBFactory();
  window.navigator.locks = locks === false ? undefined : (locks || origin?.locks || createLockManager());
  Object.defineProperty(window.crypto, "subtle", { value: webcrypto.subtle, configurable: true });
  if (origin) Object.defineProperty(window, "localStorage", { value: origin.attach(window), configurable: true });
  for (const [key, value] of Object.entries(sessionStorage)) window.sessionStorage.setItem(key, value);
  window.structuredClone = structuredClone;
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  window.fetch = async () => { throw new Error("Unexpected network request in test"); };
  window.confirm = () => false;
  window.alert = () => {};
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
  window.URL.createObjectURL = () => "blob:synthetic-test";
  window.URL.revokeObjectURL = () => {};
  const source = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
  window.eval(`${source}\n;window.__test = { run: (code) => eval(code) };`);
  return {
    window,
    run: (code) => window.__test.run(code),
    close: () => { origin?.detach(window); window.close(); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

module.exports = { createApp, createOrigin, createLockManager, deferred, root };
