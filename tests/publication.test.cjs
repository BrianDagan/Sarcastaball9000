const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PUBLIC_ASSETS, validatePublication } = require("../scripts/validate-publication.cjs");

const MIT = `MIT License

Copyright (c) 2026 Brian Dagan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const HTML = `<!doctype html>
<html><head>
<meta name="robots" content="noindex, nofollow">
<link rel="canonical" href="https://sarcastaball.briandagan.com/">
<link rel="stylesheet" href="styles.css">
<link rel="icon" href="assets/baseball.svg">
</head><body>
<img src="assets/baseball.svg" alt="">
<a href="LICENSE.txt">License</a>
<a href="THIRD_PARTY_NOTICES.md">Notices</a>
<script src="vendor/sql-wasm.js"></script>
<script src="app.js"></script>
</body></html>`;
const SENTINEL = "SYNTHETIC_FIXTURE_CONTENT_NOT_FOR_DIAGNOSTICS";

function fixture(t) {
  // Fixtures live only in this project, never the OS temp directory or a profile.
  const root = fs.mkdtempSync(path.join(__dirname, "publication-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = relative => path.join(root, ...relative.split("/"));
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
    fs.writeFileSync(file(relative), content);
  };
  const replace = (relative, from, to) => {
    const before = fs.readFileSync(file(relative), "utf8");
    assert.ok(before.includes(from));
    write(relative, before.replace(from, to));
  };
  write("LICENSE", MIT);
  write("docs/.nojekyll", "");
  write("docs/LICENSE.txt", MIT);
  write("docs/THIRD_PARTY_NOTICES.md", "# Synthetic notices\n[sql.js license](vendor/LICENSE.sqljs.txt)\n");
  write("docs/index.html", HTML);
  write("docs/app.js", "// Synthetic application stand-in.\n");
  write("docs/styles.css", '.ball { background-image: url("./assets/baseball.svg"); }\n');
  write("docs/assets/baseball.svg", '<svg xmlns="http://www.w3.org/2000/svg"><defs><circle id="ball"/></defs><use href="#ball"/></svg>\n');
  write("docs/vendor/LICENSE.sqljs.txt", MIT.replace("Brian Dagan", "Synthetic fixture authors"));
  for (const name of [
    "COPYRIGHT.musl.txt", "LICENSE.compiler-rt.txt", "LICENSE.emscripten.txt",
    "LICENSE.libcxx.txt", "LICENSE.libcxxabi.txt", "NOTICE.runtime-components.txt",
  ]) write(`docs/vendor/${name}`, "Synthetic component notice.\n");
  write("docs/vendor/sql-wasm.js", "// Synthetic vendor stand-in.\n");
  write("docs/vendor/sql-wasm.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  return { root, file, write, replace, validate: () => validatePublication(root) };
}

function hasIssue(result, category, relative) {
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.category === category && issue.path === relative),
    JSON.stringify(result.issues));
}

function symlink(t, target, link, directory = false) {
  try {
    fs.symlinkSync(target, link, directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
      t.skip("This filesystem/account cannot create the isolated test symlink.");
      return false;
    }
    throw error;
  }
}

function runCli(root, args = ["--root", root]) {
  return spawnSync(process.execPath, [path.resolve(__dirname, "..", "scripts", "validate-publication.cjs"), ...args], {
    cwd: root,
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    encoding: "utf8",
    timeout: 10000,
  });
}

test("the public manifest is an explicit, immutable sixteen-file docs boundary", () => {
  assert.ok(Object.isFrozen(PUBLIC_ASSETS));
  assert.deepEqual(PUBLIC_ASSETS, [
    ".nojekyll", "LICENSE.txt", "THIRD_PARTY_NOTICES.md", "app.js",
    "assets/baseball.svg", "index.html", "styles.css", "vendor/COPYRIGHT.musl.txt",
    "vendor/LICENSE.compiler-rt.txt", "vendor/LICENSE.emscripten.txt",
    "vendor/LICENSE.libcxx.txt", "vendor/LICENSE.libcxxabi.txt",
    "vendor/LICENSE.sqljs.txt", "vendor/NOTICE.runtime-components.txt",
    "vendor/sql-wasm.js", "vendor/sql-wasm.wasm",
  ]);
});

test("valid publication fixtures need no Git checkout and only inspect the approved docs tree", t => {
  const f = fixture(t);
  f.write("node_modules/nested/private.log", SENTINEL);
  f.write(".env", SENTINEL);
  f.write("library.sqlite", SENTINEL);
  f.write("guides/local.md", SENTINEL);
  const readdir = fs.readdirSync;
  const visited = [];
  t.mock.method(fs, "readdirSync", (directory, ...args) => {
    visited.push(path.relative(f.root, directory).split(path.sep).join("/"));
    return readdir(directory, ...args);
  });
  const result = f.validate();
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.files.length, 16);
  assert.deepEqual(visited.sort(), ["docs", "docs/assets", "docs/vendor"]);
  assert.equal(fs.existsSync(f.file(".git")), false);
  assert.equal(fs.readFileSync(f.file(".env"), "utf8"), SENTINEL);
});

for (const relative of [
  "docs/.env", "docs/.gitignore", "docs/CNAME", "docs/library.sqlite",
  "docs/debug.log", "docs/auth.json", "docs/test-results.xml",
  "docs/index.html.bak", "docs/assets/private.db", "docs/vendor/package.json",
]) {
  test(`unexpected public file is rejected: ${relative}`, t => {
    const f = fixture(t);
    f.write(relative, SENTINEL);
    hasIssue(f.validate(), "unexpected-file", relative);
  });
}

for (const directory of ["docs/node_modules", "docs/.git", "docs/reports", "docs/assets/private"]) {
  test(`unexpected directory is not traversed: ${directory}`, t => {
    const f = fixture(t);
    f.write(`${directory}/nested/fixture.txt`, SENTINEL);
    const result = f.validate();
    assert.deepEqual(result.issues, [{ category: "unexpected-directory", path: directory }]);
    assert.equal(fs.readFileSync(f.file(`${directory}/nested/fixture.txt`), "utf8"), SENTINEL);
  });
}

for (const asset of PUBLIC_ASSETS) {
  test(`required public asset cannot be omitted: ${asset}`, t => {
    const f = fixture(t);
    fs.unlinkSync(f.file(`docs/${asset}`));
    hasIssue(f.validate(), "missing-asset", `docs/${asset}`);
  });
}

test("missing manifest directories and a file substituted for a directory are rejected", t => {
  const f = fixture(t);
  fs.rmSync(f.file("docs/assets"), { recursive: true });
  f.write("docs/assets", SENTINEL);
  const result = f.validate();
  hasIssue(result, "non-directory", "docs/assets");
  hasIssue(result, "missing-asset", "docs/assets/baseball.svg");
});

test("a required regular file cannot be replaced by a directory", t => {
  const f = fixture(t);
  fs.unlinkSync(f.file("docs/app.js"));
  f.write("docs/app.js/fixture.txt", SENTINEL);
  assert.deepEqual(f.validate().issues, [{ category: "non-regular-file", path: "docs/app.js" }]);
});

test("the root license is required even though only docs is published", t => {
  const f = fixture(t);
  fs.unlinkSync(f.file("LICENSE"));
  hasIssue(f.validate(), "missing-file", "LICENSE");
});

test("root and served licenses must be byte-identical, including line endings", t => {
  const f = fixture(t);
  f.write("docs/LICENSE.txt", MIT.replaceAll("\n", "\r\n"));
  hasIssue(f.validate(), "license-mismatch", "docs/LICENSE.txt");
});

test("matching but non-MIT license placeholders cannot satisfy the legal gate", t => {
  const f = fixture(t);
  f.write("LICENSE", "Synthetic non-license placeholder.");
  f.write("docs/LICENSE.txt", "Synthetic non-license placeholder.");
  hasIssue(f.validate(), "invalid-license", "LICENSE");
});

for (const relative of ["LICENSE", "docs/LICENSE.txt", "docs/THIRD_PARTY_NOTICES.md", "docs/vendor/LICENSE.sqljs.txt", "docs/app.js"]) {
  test(`empty required material is rejected: ${relative}`, t => {
    const f = fixture(t);
    f.write(relative, "");
    hasIssue(f.validate(), "empty-file", relative);
  });
}

test("the sole empty marker cannot carry extra content", t => {
  const f = fixture(t);
  f.write("docs/.nojekyll", SENTINEL);
  hasIssue(f.validate(), "invalid-marker", "docs/.nojekyll");
});

for (const relative of ["docs/app.js", "docs/unexpected-link.txt", "LICENSE"]) {
  test(`file symlinks are rejected without reading their targets: ${relative}`, t => {
    const f = fixture(t);
    f.write("outside-docs.txt", SENTINEL);
    if (fs.existsSync(f.file(relative))) fs.unlinkSync(f.file(relative));
    if (!symlink(t, f.file("outside-docs.txt"), f.file(relative))) return;
    const result = f.validate();
    hasIssue(result, "symlink", relative);
    assert.ok(result.issues.every(issue => !issue.path.includes("outside-docs")));
    assert.equal(fs.readFileSync(f.file("outside-docs.txt"), "utf8"), SENTINEL);
  });
}

for (const relative of ["docs", "docs/assets", "docs/vendor"]) {
  test(`directory symlinks/junctions are rejected: ${relative}`, t => {
    const f = fixture(t);
    const target = f.file("isolated-link-target");
    fs.renameSync(f.file(relative), target);
    if (!symlink(t, target, f.file(relative), true)) return;
    const result = f.validate();
    hasIssue(result, "symlink", relative);
    assert.ok(result.issues.every(issue => !issue.path.includes("isolated-link-target")));
  });
}

test("hard-linked assets are rejected rather than dereferenced into an upload", t => {
  const f = fixture(t);
  try {
    fs.linkSync(f.file("docs/app.js"), f.file("isolated-hardlink.txt"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error.code)) {
      t.skip("This filesystem cannot create the isolated test hardlink.");
      return;
    }
    throw error;
  }
  hasIssue(f.validate(), "hardlink", "docs/app.js");
});

test("read failures report only category and relative path, not an exception message", t => {
  const f = fixture(t);
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === f.file("LICENSE")) throw Object.assign(new Error(SENTINEL), { code: "EACCES" });
    return read(file, ...args);
  });
  const result = f.validate();
  assert.deepEqual(result.issues, [{ category: "unreadable-file", path: "LICENSE" }]);
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
});

for (const reference of [
  "../outside.js", "%2e%2e/outside.js", "&#46;&#46;/outside.js",
  "/app.js", "//example.invalid/app.js", "https://example.invalid/app.js",
  "file:///outside.js", "javascript:example", "C:\\fixture\\app.js",
  "app.js/extra", "missing.js", "app%00.js", "bad%escape.js",
]) {
  test(`unapproved static script reference is rejected: ${reference}`, t => {
    const f = fixture(t);
    f.replace("docs/index.html", 'src="app.js"', `src="${reference}"`);
    hasIssue(f.validate(), "unsafe-or-unapproved-reference", "docs/index.html");
  });
}

test("approved relative/entity-encoded asset references and HTTPS navigation remain valid", t => {
  const f = fixture(t);
  f.replace("docs/index.html", 'src="app.js"', 'src="./app&#46;js?v=fixture"');
  f.replace("docs/index.html", "</body>",
    '<a href="https://github.com/briandagan/Sarcastaball9000">Source</a><a href="#about">About</a></body>');
  assert.equal(f.validate().ok, true);
});

test("external navigation cannot contain URL credentials and diagnostics never repeat the URL", t => {
  const f = fixture(t);
  f.replace("docs/index.html", "</body>", `<a href="https://fixture:${SENTINEL}@example.invalid/">Bad fixture</a></body>`);
  const result = f.validate();
  hasIssue(result, "unsafe-or-unapproved-reference", "docs/index.html");
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
});

test("local navigation cannot escape to root-only files", t => {
  const f = fixture(t);
  f.replace("docs/index.html", 'href="LICENSE.txt"', 'href="../LICENSE"');
  hasIssue(f.validate(), "unsafe-or-unapproved-reference", "docs/index.html");
});

test("the stylesheet and both runtime scripts must be actually referenced", t => {
  const f = fixture(t);
  f.replace("docs/index.html", '<script src="app.js"></script>', '<a href="app.js">Not a script load</a>');
  hasIssue(f.validate(), "missing-local-reference", "docs/index.html");
});

for (const replacement of ["", '<meta name="robots" content="index, follow">', '<meta name="robots" content="noindex">']) {
  test(`the live app retains explicit noindex and nofollow: ${replacement || "missing meta"}`, t => {
    const f = fixture(t);
    f.replace("docs/index.html", '<meta name="robots" content="noindex, nofollow">', replacement);
    hasIssue(f.validate(), "indexing-policy", "docs/index.html");
  });
}

test("a base tag cannot silently change local URL resolution", t => {
  const f = fixture(t);
  f.replace("docs/index.html", "<head>", '<head><base href="https://example.invalid/">');
  hasIssue(f.validate(), "unsafe-base", "docs/index.html");
});

test("canonical metadata, when present, uses only the approved public website", t => {
  const f = fixture(t);
  f.replace("docs/index.html", "https://sarcastaball.briandagan.com/", "https://example.invalid/");
  hasIssue(f.validate(), "unexpected-public-url", "docs/index.html");
});

test("canonical metadata cannot also load a remote stylesheet", t => {
  const f = fixture(t);
  f.replace("docs/index.html", 'rel="canonical"', 'rel="canonical stylesheet"');
  hasIssue(f.validate(), "unexpected-public-url", "docs/index.html");
});

test("comments and raw inline script bodies are not mistaken for static markup", t => {
  const f = fixture(t);
  f.replace("docs/index.html", "</body>", `<!-- <img src="outside.png"> -->
<script>const syntheticMarkup = '<img src="outside.png">';</script></body>`);
  assert.equal(f.validate().ok, true);
});

test("duplicate URL attributes are rejected rather than ambiguously parsed", t => {
  const f = fixture(t);
  f.replace("docs/index.html", 'src="app.js"', 'src="app.js" src="app.js"');
  hasIssue(f.validate(), "duplicate-attribute", "docs/index.html");
});

for (const css of [
  'body { background: url("../outside.png"); }',
  'body { background: url("https://example.invalid/image.png"); }',
  '@import "outside.css";',
  'body { background: url("assets\\baseball.svg"); }',
]) {
  test(`CSS references stay inside the public manifest: ${css}`, t => {
    const f = fixture(t);
    f.write("docs/styles.css", css);
    hasIssue(f.validate(), "unsafe-or-unapproved-reference", "docs/styles.css");
  });
}

test("inline style and srcset references are validated", t => {
  const f = fixture(t);
  f.replace("docs/index.html", '<img src="assets/baseball.svg" alt="">',
    '<img src="assets/baseball.svg" srcset="assets/baseball.svg 1x, ../outside.svg 2x" style="background:url(../outside.svg)" alt="">');
  hasIssue(f.validate(), "unsafe-or-unapproved-reference", "docs/index.html");
});

test("SVG references cannot load a non-manifest resource", t => {
  const f = fixture(t);
  f.replace("docs/assets/baseball.svg", 'href="#ball"', 'href="../../outside.svg"');
  hasIssue(f.validate(), "unsafe-or-unapproved-reference", "docs/assets/baseball.svg");
});

test("served notice links cannot depend on root-only documentation", t => {
  const f = fixture(t);
  f.write("docs/THIRD_PARTY_NOTICES.md", "[Synthetic notice](../guides/local.md)\n");
  hasIssue(f.validate(), "unsafe-or-unapproved-reference", "docs/THIRD_PARTY_NOTICES.md");
});

test("the CLI validates an isolated pre-Git fixture and states its bounded scope", t => {
  const f = fixture(t);
  const result = runCli(f.root);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /16 approved docs assets/);
  assert.match(result.stdout, /not a comprehensive secret scan/);
  assert.equal(result.stderr, "");
});

test("CLI failure output contains only category/relative path, not contents or absolute paths", t => {
  const f = fixture(t);
  f.write("docs/.env", SENTINEL);
  const result = runCli(f.root);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "unexpected-file: docs/.env");
  assert.ok(!result.stderr.includes(SENTINEL));
  assert.ok(!result.stderr.includes(f.root));
});

test("CLI argument failures do not echo arbitrary user input", t => {
  const f = fixture(t);
  const result = runCli(f.root, ["--unexpected", SENTINEL]);
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), "invalid-arguments: .");
});

const workflowDirectory = path.resolve(__dirname, "..", ".github", "workflows");
const checks = fs.readFileSync(path.join(workflowDirectory, "checks.yml"), "utf8").replaceAll("\r\n", "\n");
const pages = fs.readFileSync(path.join(workflowDirectory, "pages.yml"), "utf8").replaceAll("\r\n", "\n");
const job = (workflow, name) => {
  const result = workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z_-]*:\\r?$|$(?![\\s\\S]))`, "m"));
  assert.ok(result, `Missing workflow job: ${name}`);
  return result[1];
};
const packageJob = job(pages, "package");
const deployJob = job(pages, "deploy");

function conditionPasses(section, context) {
  const condition = section.match(/^    if: >-\r?\n((?:      .+\r?\n)+)/m);
  assert.ok(condition, "Expected an explicit folded publication condition");
  return condition[1].trim().split(/\s*&&\s*/).every(clause => {
    const equality = clause.match(/^([\w.]+)\s*==\s*('[^']*'|[\w.]+)$/);
    assert.ok(equality, "Publication conditions should stay simple and auditable");
    const right = equality[2].startsWith("'") ? equality[2].slice(1, -1) : context[equality[2]];
    return context[equality[1]] === right;
  });
}

test("workflow triggers and validation preserve the low-privilege contract", () => {
  assert.match(checks, /^  pull_request:\r?\n    branches: \[main\]/m);
  assert.match(checks, /^  workflow_call:/m);
  assert.match(pages, /^  push:\r?\n    branches: \[main\]/m);
  assert.match(pages, /^  workflow_dispatch:/m);
  for (const workflow of [checks, pages]) {
    assert.doesNotMatch(workflow, /pull_request_target:|workflow_run:|always\(\)|continue-on-error:|secrets:/);
  }
  assert.match(checks, /^permissions:\r?\n  contents: read\r?$/m);
  assert.doesNotMatch(checks, /pages: write|id-token: write/);
  for (const section of [checks, packageJob]) {
    assert.match(section, /node-version: "24"\n          check-latest: true/);
  }
  assert.match(checks, /python-version: "3\.12"/);
  for (const command of [
    "npm ci --no-audit --no-fund", "npm run check", "npm test",
    "npm run check:publication", "npx playwright install --with-deps chromium",
    "npm run test:browser",
  ]) assert.ok(checks.includes(`run: ${command}\n`));
  assert.match(job(pages, "checks"), /uses: \.\/\.github\/workflows\/checks\.yml/);
  assert.match(job(pages, "checks"), /if: github\.ref == 'refs\/heads\/main'/);
});

test("all external action uses are version-commented verified full SHA pins", () => {
  const pins = new Map([
    ["actions/checkout", ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"]],
    ["actions/setup-node", ["820762786026740c76f36085b0efc47a31fe5020", "v7.0.0"]],
    ["actions/setup-python", ["5fda3b95a4ea91299a34e894583c3862153e4b97", "v7.0.0"]],
    ["actions/upload-pages-artifact", ["fc324d3547104276b827a68afc52ff2a11cc49c9", "v5.0.0"]],
    ["actions/deploy-pages", ["368f82528645a54fb793d4d04e342629a3f51346", "v5.0.1"]],
  ]);
  const uses = [...`${checks}\n${pages}`.matchAll(/^\s+uses: ([^\r\n]+)$/gm)]
    .map(match => match[1]).filter(value => !value.startsWith("./"));
  assert.equal(uses.length, 7);
  for (const value of uses) {
    const match = value.match(/^(actions\/[a-z-]+)@([0-9a-f]{40}) # (v[\d.]+)$/);
    assert.ok(match, "Every external action needs a full SHA and version comment");
    assert.deepEqual([match[2], match[3]], pins.get(match[1]));
  }
  for (const workflow of [checks, pages]) {
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=\n      - |$)/g)];
    assert.equal(checkouts.length, 1);
    for (const checkout of checkouts) assert.match(checkout[1], /persist-credentials: false/);
  }
});

test("packaging uses a fresh checked commit, only docs, and no test-created artifacts", () => {
  assert.match(packageJob, /needs: checks/);
  assert.match(packageJob, /ref: \$\{\{ needs\.checks\.outputs\.checked_sha \}\}/);
  assert.match(packageJob, /clean: true/);
  assert.match(packageJob, /run: test "\$CHECKOUT_SHA" = "\$CHECKED_SHA"/);
  assert.match(packageJob, /run: node scripts\/validate-publication\.cjs/);
  assert.match(packageJob, /path: docs\r?$/m);
  assert.match(packageJob, /include-hidden-files: true/);
  assert.match(packageJob, /retention-days: 1/);
  assert.doesNotMatch(packageJob, /run: npm|run: npx|download-artifact|id-token:|pages: write/);
  assert.match(deployJob, /artifact_name: \$\{\{ needs\.package\.outputs\.artifact_name \}\}/);
});

test("a serialized release rechecks main and binds checks/package to the executing attempt", () => {
  assert.match(pages, /^concurrency:\r?\n  group: pages-main-publication\r?\n  cancel-in-progress: false\r?\n/m);
  assert.match(packageJob, /gh api --method GET "repos\/\$\{GITHUB_REPOSITORY\}\/git\/ref\/heads\/main"/);
  assert.match(packageJob, /if \[ "\$MAIN_SHA" != "\$CHECKED_SHA" \]; then[\s\S]*?exit 1\s+fi/);
  assert.match(checks, /checked_attempt: \$\{\{ steps\.completed\.outputs\.attempt \}\}/);
  assert.match(checks, /run: printf 'attempt=%s\\n' "\$GITHUB_RUN_ATTEMPT" >> "\$GITHUB_OUTPUT"/);
  assert.match(packageJob, /packaged_attempt: \$\{\{ steps\.release\.outputs\.attempt \}\}/);
  assert.match(packageJob, /printf 'attempt=%s\\n' "\$GITHUB_RUN_ATTEMPT" >> "\$GITHUB_OUTPUT"/);
  assert.match(packageJob, /artifact_name: github-pages-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
});

test("publication conditions fail closed for disabled, stale, failed and partial-rerun cases", () => {
  const current = {
    "github.ref": "refs/heads/main",
    "github.sha": "synthetic-checked-commit",
    "github.run_attempt": "1",
    "vars.PAGES_PUBLISH_ENABLED": "true",
    "needs.checks.result": "success",
    "needs.checks.outputs.checked_sha": "synthetic-checked-commit",
    "needs.checks.outputs.checked_attempt": "1",
    "needs.package.result": "success",
    "needs.package.outputs.packaged_attempt": "1",
  };
  assert.equal(conditionPasses(packageJob, current), true);
  assert.equal(conditionPasses(deployJob, current), true);
  for (const changed of [
    { "vars.PAGES_PUBLISH_ENABLED": "" },
    { "vars.PAGES_PUBLISH_ENABLED": "false" },
    { "github.ref": "refs/heads/fixture-branch" },
    { "needs.checks.result": "failure" },
    { "needs.checks.result": "cancelled" },
    { "needs.checks.result": "skipped" },
    { "needs.checks.outputs.checked_sha": "different-synthetic-commit" },
    { "github.run_attempt": "2" },
  ]) {
    assert.equal(conditionPasses(packageJob, { ...current, ...changed }), false);
    assert.equal(conditionPasses(deployJob, { ...current, ...changed }), false);
  }
  for (const changed of [
    { "needs.package.result": "failure" },
    { "needs.package.result": "cancelled" },
    { "needs.package.result": "skipped" },
    { "needs.package.outputs.packaged_attempt": "0" },
  ]) assert.equal(conditionPasses(deployJob, { ...current, ...changed }), false);
  const fullyRechecked = {
    ...current, "github.run_attempt": "2", "needs.checks.outputs.checked_attempt": "2",
    "needs.package.outputs.packaged_attempt": "2",
  };
  assert.equal(conditionPasses(packageJob, fullyRechecked), true);
  assert.equal(conditionPasses(deployJob, fullyRechecked), true);
});

test("only the main-gated deploy job has write/OIDC privileges and it executes no repository code", () => {
  assert.match(deployJob, /needs: \[checks, package\]/);
  assert.match(deployJob, /permissions:\r?\n      pages: write\r?\n      id-token: write/);
  assert.match(deployJob, /name: github-pages/);
  assert.equal([...pages.matchAll(/pages: write/g)].length, 1);
  assert.equal([...pages.matchAll(/id-token: write/g)].length, 1);
  assert.equal([...deployJob.matchAll(/uses:/g)].length, 1);
  assert.doesNotMatch(deployJob, /\brun:|checkout@|setup-node@|npm|npx|contents:|GH_TOKEN|secrets:/);
  assert.match(deployJob, /uses: actions\/deploy-pages@[0-9a-f]{40}/);
});

test("MIT package metadata preserves the internal name, version, private flag and locked root dependencies", () => {
  const root = path.resolve(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.name, "djdad");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "MIT");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].license, "MIT");
  assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
});
