const fs = require("node:fs");
const path = require("node:path");

// This is a docs artifact gate, not a repository-wide secret scanner or an HTML
// sanitizer. Dynamic runtime URLs and the contents of source code need review.
const PUBLIC_ASSETS = Object.freeze([
  ".nojekyll",
  "LICENSE.txt",
  "THIRD_PARTY_NOTICES.md",
  "app.js",
  "assets/baseball.svg",
  "index.html",
  "styles.css",
  "vendor/COPYRIGHT.musl.txt",
  "vendor/LICENSE.compiler-rt.txt",
  "vendor/LICENSE.emscripten.txt",
  "vendor/LICENSE.libcxx.txt",
  "vendor/LICENSE.libcxxabi.txt",
  "vendor/LICENSE.sqljs.txt",
  "vendor/NOTICE.runtime-components.txt",
  "vendor/sql-wasm.js",
  "vendor/sql-wasm.wasm",
]);
const assetSet = new Set(PUBLIC_ASSETS);
const directorySet = new Set(PUBLIC_ASSETS.map(file => path.posix.dirname(file)).filter(dir => dir !== "."));
const PUBLIC_WEBSITE = "https://sarcastaball.briandagan.com/";

function decodeEntities(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|quot|apos|lt|gt));/gi, (_, hex, decimal, name) => {
    if (name) return named[name.toLowerCase()];
    const number = Number.parseInt(hex || decimal, hex ? 16 : 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "\ufffd";
  });
}

function validatePublication(rootDirectory = path.resolve(__dirname, "..")) {
  const root = path.resolve(rootDirectory);
  const issues = [];
  const reported = new Set();
  const admitted = new Set();
  const seen = new Set();
  const filename = relative => path.join(root, ...relative.split("/"));
  const report = (category, relative) => {
    const key = `${category}\0${relative}`;
    if (!reported.has(key)) {
      reported.add(key);
      issues.push({ category, path: relative });
    }
  };
  const stat = relative => {
    try {
      const value = fs.lstatSync(filename(relative));
      if (value.isSymbolicLink()) {
        report("symlink", relative);
        return null;
      }
      return value;
    } catch (error) {
      report(error.code === "ENOENT" ? "missing-file" : "unreadable-path", relative);
      return null;
    }
  };
  const admitFile = (relative, value) => {
    if (!value.isFile()) report("non-regular-file", relative);
    else if (value.nlink > 1) report("hardlink", relative);
    else if (relative === "docs/.nojekyll" && value.size !== 0) report("invalid-marker", relative);
    else if (relative !== "docs/.nojekyll" && value.size === 0) report("empty-file", relative);
    else admitted.add(relative);
  };
  const walk = directory => {
    let names;
    try {
      names = fs.readdirSync(filename(directory)).sort();
    } catch {
      report("unreadable-directory", directory);
      return;
    }
    for (const name of names) {
      const relative = `${directory}/${name}`;
      const asset = relative.slice("docs/".length);
      seen.add(asset);
      const value = stat(relative);
      if (!value) continue;
      if (assetSet.has(asset)) admitFile(relative, value);
      else if (directorySet.has(asset)) {
        if (value.isDirectory()) walk(relative);
        else report("non-directory", relative);
      } else {
        // Never traverse unexpected trees such as node_modules or read their data.
        report(value.isDirectory() ? "unexpected-directory" : "unexpected-file", relative);
      }
    }
  };
  const read = relative => {
    if (!admitted.has(relative)) return null;
    try {
      return fs.readFileSync(filename(relative));
    } catch {
      report("unreadable-file", relative);
      return null;
    }
  };
  const finish = () => ({
    ok: issues.length === 0,
    issues: issues.sort((a, b) => a.path.localeCompare(b.path) || a.category.localeCompare(b.category)),
    files: PUBLIC_ASSETS.map(asset => `docs/${asset}`),
  });

  const rootStat = stat(".");
  if (!rootStat) return finish();
  if (!rootStat.isDirectory()) {
    report("non-directory", ".");
    return finish();
  }
  const docsStat = stat("docs");
  if (docsStat) {
    if (docsStat.isDirectory()) walk("docs");
    else report("non-directory", "docs");
  }
  for (const asset of PUBLIC_ASSETS) {
    if (!seen.has(asset)) report("missing-asset", `docs/${asset}`);
  }
  const licenseStat = stat("LICENSE");
  if (licenseStat) admitFile("LICENSE", licenseStat);
  const license = read("LICENSE");
  const servedLicense = read("docs/LICENSE.txt");
  if (license && servedLicense && !license.equals(servedLicense)) report("license-mismatch", "docs/LICENSE.txt");
  if (license) {
    const markers = [
      "MIT License",
      "Copyright (c) 2026 Brian Dagan",
      "Permission is hereby granted, free of charge",
      'THE SOFTWARE IS PROVIDED "AS IS"',
    ];
    if (markers.some(marker => !license.toString("utf8").includes(marker))) report("invalid-license", "LICENSE");
  }

  const reference = (rawValue, source, allowExternal = false) => {
    const value = rawValue.trim();
    if (!value || value.startsWith("#")) return null;
    const fail = () => {
      report("unsafe-or-unapproved-reference", `docs/${source}`);
      return null;
    };
    if (/[\u0000-\u0020\u007f\\]/.test(value)) return fail();
    if (/^https:\/\//i.test(value)) {
      if (!allowExternal) return fail();
      try {
        const url = new URL(value);
        if (url.username || url.password) return fail();
        return null;
      } catch {
        return fail();
      }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/")) return fail();
    let local;
    try {
      local = decodeURIComponent(value.split(/[?#]/, 1)[0]);
    } catch {
      return fail();
    }
    if (local.startsWith("/") || /[\\:\u0000-\u0020\u007f]/.test(local) || local.split("/").includes("..")) return fail();
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), local));
    if (!assetSet.has(resolved)) return fail();
    return resolved;
  };
  const checkCss = (css, source) => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    if (/@import\b/i.test(text)) report("unsafe-or-unapproved-reference", `docs/${source}`);
    for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
      reference(match[1] ?? match[2] ?? match[3], source);
    }
  };
  const checkMarkup = (markup, source) => {
    const uncommented = markup.replace(/<!--[\s\S]*?-->/g, "");
    for (const match of uncommented.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) checkCss(match[1], source);
    const text = uncommented.replace(/<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/\1\s*>/gi, "<$1$2>");
    const scripts = new Set();
    const styles = new Set();
    let noindex = false;
    for (const tag of text.matchAll(/<([a-z][a-z0-9:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
      const name = tag[1].toLowerCase();
      const attributes = new Map();
      for (const attribute of tag[2].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        const key = attribute[1].toLowerCase();
        if (attributes.has(key)) report("duplicate-attribute", `docs/${source}`);
        else attributes.set(key, decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""));
      }
      if (name === "base") report("unsafe-base", `docs/${source}`);
      if (name === "meta" && attributes.get("name")?.toLowerCase() === "robots") {
        const directives = (attributes.get("content") || "").toLowerCase().split(/[,\s]+/);
        if (directives.includes("noindex") && directives.includes("nofollow")) noindex = true;
        else report("indexing-policy", `docs/${source}`);
      }
      const rel = (attributes.get("rel") || "").toLowerCase().split(/\s+/).filter(Boolean);
      for (const key of ["src", "href", "xlink:href", "poster", "data"]) {
        if (!attributes.has(key) || (key === "data" && name !== "object")) continue;
        if (name === "link" && key === "href" && rel.includes("canonical")) {
          if (rel.some(value => value !== "canonical") || attributes.get(key) !== PUBLIC_WEBSITE) {
            report("unexpected-public-url", `docs/${source}`);
          }
          continue;
        }
        const resolved = reference(attributes.get(key), source, name === "a" && key === "href");
        if (name === "script" && key === "src" && resolved) scripts.add(resolved);
        if (name === "link" && key === "href" && rel.includes("stylesheet") && resolved) styles.add(resolved);
      }
      if (attributes.has("srcset")) {
        for (const candidate of attributes.get("srcset").split(",")) reference(candidate.trim().split(/\s+/)[0], source);
      }
      if (attributes.has("style")) checkCss(attributes.get("style"), source);
    }
    if (source === "index.html") {
      if (!noindex) report("indexing-policy", "docs/index.html");
      if (!scripts.has("app.js") || !scripts.has("vendor/sql-wasm.js") || !styles.has("styles.css")) {
        report("missing-local-reference", "docs/index.html");
      }
    }
  };

  for (const source of ["index.html", "assets/baseball.svg"]) {
    const content = read(`docs/${source}`);
    if (content) checkMarkup(content.toString("utf8"), source);
  }
  const styles = read("docs/styles.css");
  if (styles) checkCss(styles.toString("utf8"), "styles.css");
  const notices = read("docs/THIRD_PARTY_NOTICES.md");
  if (notices) {
    for (const match of notices.toString("utf8").matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      reference(match[1], "THIRD_PARTY_NOTICES.md", true);
    }
  }
  return finish();
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--root")) {
    console.error("invalid-arguments: .");
    process.exitCode = 2;
  } else {
    try {
      const result = validatePublication(args[1]);
      if (result.ok) {
        console.log(`Publication artifact valid: ${result.files.length} approved docs assets. This is not a comprehensive secret scan.`);
      } else {
        for (const issue of result.issues) {
          const relative = issue.path.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
            character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
          console.error(`${issue.category}: ${relative}`);
        }
        process.exitCode = 1;
      }
    } catch {
      console.error("validation-error: .");
      process.exitCode = 1;
    }
  }
}

module.exports = { PUBLIC_ASSETS, validatePublication };
