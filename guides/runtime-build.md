# Local SQLite runtime candidate build

This is a **custom build**, not an official sql.js distribution. Building a
candidate does not install it into `docs/vendor`, authorize public release, or
establish that all vulnerabilities are fixed. Application compatibility and an
independent review remain separate release gates.

## Why a custom build

The original paired sql.js 1.10.3 assets embed SQLite 3.45.2. The official sql.js
1.14.2 build still embeds SQLite 3.49.1; simply replacing the pair with that
release does not address CVE-2025-6965. This candidate keeps the sql.js 1.14.2
wrapper and build settings, substituting SQLite **3.53.4**.

SQLite 3.53 changed numeric-to-text conversion from 15 to 17 significant digits.
Do not treat successful SQL execution as proof of application compatibility.
Schema identity, numeric values, fractional cues, timestamp units, database
export/reimport, IndexedDB recovery, and save/rollback behavior require synthetic
application regressions before a maintainer integrates the pair.

The upstream `extension-functions.c` is retained unchanged. This is unsupported
legacy contributed code (last updated in 2010), not a maintained SQLite core
component. Retaining its functions preserves compatibility but is not a
no-vulnerabilities claim.

The reviewed author-repository history distinguishes the exact legacy
bytes at commit `f1e8effa1f9f8bdf6a430edd8766a3ca187a113a` from the later
Unlicense dedication at commit `16c2a17c7d9675ecbc717cad1883df21011a71e4` in
`gitlab.com/liamh/extension-functions`. The retained legacy file has no embedded
license text; the later dedication is separate licensing evidence, not a reason
to relabel or silently replace the compiled bytes. The distribution retains the
history and component notices.

## Pinned public inputs

| Input | Identity |
| --- | --- |
| sql.js | 1.14.2, commit `9c4e167ec37129192d166ab9223faa9a4bd07c58` |
| SQLite | `sqlite-amalgamation-3530400.zip`, SQLite 3.53.4 |
| EMSDK metadata | Commit `b4258c35121c8d0e12f53568ffb22236d7816723` |
| Emscripten | 5.0.0; compiler build `e44d3cc557d78155966478aa2bd8dec657609619` |
| Node | Private Linux x64 Node 24.21.0 |
| Closure | `google-closure-compiler` and Linux native package 20240317.0.0, from the toolchain's unchanged lockfile |

The [pinned upstream Makefile][makefile] defines the flags and wrapper steps.
Its opening Emscripten 2.0.15 comment is stale: the
[pinned development container][container] specifies **5.0.0**. This matches the
source baseline, not the current 6.0.9 toolchain, and is not a promise that 5.x
receives maintenance. The driver reads the Makefile, preserving the optimized
`dist/sql-wasm.js` target rather than constructing a different wrapper.

The raw compiler archive contains `emscripten-version.txt` with
`4.0.24-git`. This is expected for this release archive: the pinned
[EMSDK installer][installer] (lines 2212–2220) replaces that file with `"5.0.0"`
using its release-hash mapping. The driver performs precisely that installation
stamp, records both identities, and rejects any different initial version. It
does not change compiler source or substitute another compiler archive.
The Emscripten 5.0.0 source tag points to
`be68a767ff3937d97ffc7996a24bd3d7e7f9c849`; that legal/source reference is
distinct from the verified archive's embedded source revision
`a7c5deabd7c88ba1c38ebe988112256775f944c6`. Both identities are retained.

Checksums supplied independently of this build:

```text
SQLite amalgamation ZIP, SHA3-256:
628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e

sqlite3.c, SHA3-256:
67f423e9ebbbdc473cbc4772c872ee6b89f31fde4ed0279a5c25d5f65c043a16

extension-functions.c, SHA-256:
991b40fe8b2799edc215f7260b890f14a833512c9d9896aa080891330ffe4052

node-v24.21.0-linux-x64.tar.gz, SHA-256:
6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
```

Expected SQLite source ID:

```text
2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc
```

The Emscripten Linux archive is 350,259,396 compressed bytes. **No independently
published SHA-256 or publisher signature has been verified for that archive.**
It is acquired with certificate-validated HTTPS from the compiler-build URL
identified by the pinned EMSDK metadata. The acquired bytes' SHA-256 is retained
in `input-records.json` and `provenance.json`, including this provenance limit.
A repeat-download pin establishes byte identity, not independent authenticity.
The sql.js source archive and EMSDK metadata also have recorded acquisition
digests. Node's downloaded publisher checksum list must agree with the pinned
digest; the release signatures are not verified by this driver.

The observed toolchain SHA-256, now pinned by the driver for future downloads, is:

```text
ba97bdf3737d19f70af390223eb6262013b89206202779b6a8d57568b3241a59
```

Public download URLs are in `tools/build-sqljs.py` and the generated provenance.
No source, dependency graph, private data, credential, or application fixture is
uploaded. npm audit, funding requests, and lifecycle scripts are disabled.

## Isolated prerequisites and invocation

The driver requires an **existing Linux x86_64 environment**, Python 3.10+ with
TLS, ZIP, gzip, and xz support, a compatible native ELF loader, and at least
12 GiB free in a private workspace. WSL is suitable if already installed.
An existing Ubuntu 24.04 / glibc 2.39 / Python 3.12.3 environment was selected
for qualification. This is not a claim of compatibility with every Linux host.

No Docker, `make`, `emmake`, `cmake`, `unzip`, system Node, Java installation,
`apt`, shell activation, or profile changes are required. The driver runs the
pinned Emscripten compiler through Python, and uses the private Node/native
Closure binaries. Missing native loader libraries or unusable Closure are
blockers, not reasons to disable optimization or install global packages.
The archive includes its Node dependencies. The driver first checks for those
packages; only if required modules are missing does it run a private
`npm ci --omit=dev --ignore-scripts --no-audit --no-fund`. It never performs a
floating reinstall. Closure is configured to the locked native binary directly;
no Java fallback or alternate minifier is selected.

Copy **only** the driver into a chosen private working directory, outside the
application's deployed tree, and open a shell in that directory. Do not copy or
mount browser profiles, personal databases, private libraries, or application
source as build inputs. In that existing Linux shell:

```sh
python3 build-sqljs.py --work-dir extraction-self-test --self-test
python3 build-sqljs.py --work-dir runtime-build
```

The relative `--work-dir` must be new and dedicated to this build. A successful
invocation acquires inputs, qualifies native tools, builds twice from separate
source extractions, runs measurements/tests, compares hashes, and stages:

```text
runtime-build/
  input-records.json
  provenance.json
  downloads/
  emscripten-unpacked/
  node-unpacked/
  sqljs-unpacked/
  provision-state/
  logs/
  build-1/
  build-2/
  candidate/
    sql-wasm.js
    sql-wasm.wasm
    build-sqljs.py
    input-records.json
    provenance.json
    license-inputs/
    evidence/
```

`--prepare-only` downloads and qualifies tools without compiling. A subsequent
normal invocation can use that same prepared workspace; acquired archives are
rechecked against their input digests. A directory containing an incomplete
extraction or an existing `build-1`/`build-2` is **not** silently cleaned or
reused. Inspect the local diagnostic, then use a new dedicated workspace or
manually remove only explicitly owned failed build subdirectories. Never delete
a home, session, repository, or broad parent directory to retry.

## What is preserved

The driver reproduces upstream Makefile lines 20–74, 110–120 and 162–204:

- Compile both SQLite and the retained extension with `-Oz`,
  `SQLITE_OMIT_LOAD_EXTENSION`, `SQLITE_DISABLE_LFS`, `SQLITE_ENABLE_FTS3`,
  `SQLITE_ENABLE_FTS3_PARENTHESIS`, `SQLITE_THREADSAFE=0`, and
  `SQLITE_ENABLE_NORMALIZE`.
- Use the complete upstream exported-functions and exported-runtime-methods JSON
  lists; retain reserved function pointers, table growth, separate files,
  disabled Node exception/rejection interception, and a 5 MB stack.
- Link the WASM target with memory growth, `-Oz`, `-flto`, and `--closure 1`.
  This reproduces upstream's placement of LTO at link time; it does not invent
  additional C compilation settings.
- Apply the unchanged `src/api.js` pre-JS, then concatenate upstream
  `shell-pre.js`, the generated loader, and `shell-post.js` byte-for-byte.
- Do not substitute FTS5, wasm64, threads, a browser-only target, or a new wrapper.

Only path-remapping flags are additional:
`-ffile-prefix-map=<workspace>=.` and
`-fdebug-prefix-map=<workspace>=.`. Compiler input/output arguments are relative
to the extracted public source. Generated assets are checked for the actual
workspace prefix and common private Linux/WSL path prefixes. Logs and provenance
replace the workspace prefix with a generic marker.
The unchanged `/home/web_user` string is Emscripten's fixed **in-memory**
filesystem home, not a host home directory; it is deliberately permitted.

Every compiler/package subprocess receives a constructed credential-free
environment, rather than the caller's environment. `HOME`, npm configuration,
npm cache, scratch, `EM_CONFIG`, `EM_CACHE`, `EM_LLVM_ROOT`, `EM_BINARYEN_ROOT`,
and `EM_NODE_JS` are process-local. No global PATH is altered. Each clean build
has separate objects, system-library cache, home and scratch; only public
downloaded inputs and qualified tool binaries/dependencies are shared.

Tar/ZIP extraction rejects traversal, absolute paths, special files, conflicting
paths and escaping links. It preserves executable bits and permits only safe
in-archive TAR links; ZIP links are rejected. No archive is extracted with a
blanket unvalidated `extractall`.

## Acceptance and retained evidence

Success requires both clean builds' JS **and** WASM SHA-256 values to match, plus
matching measured SQLite identity/options. `provenance.json` records input
URLs/digests, source and tool identities, Closure lock entries and integrity,
compiler flags/commands, sanitized log paths, both artifact hashes, the host
qualification, and the tests actually completed.
The candidate retains sanitized compile/link/test/tool logs under `evidence`,
input records, and public license inputs (sql.js, the retained extension,
Emscripten, musl and compiler-rt). The driver snapshot's hash is recorded, so
later edits to the working copy cannot silently change which driver is attached
to an already produced candidate.

The bounded private-Node smoke checks version/source ID, compile options, small
`concat`/`concat_ws` inputs, retained extension functions, FTS3, normalized SQL,
bound values/blobs, transactions, user-defined functions, and synthetic export/
reopen/integrity. It records a high-precision numeric-to-text sample. It does not
run malicious, huge-allocation, OOM or CVE proof-of-concept payloads.

The applicable source-locked upstream runner is
`node --unhandled-rejections=strict test/all.js wasm`. It needs only Node
built-ins, so the sql.js development package set is not installed. The driver
requires a complete positive test summary as well as a successful process exit:
the upstream loader's error handler alone is not a reliable failure exit.
For its worker test, the driver also generates the upstream
`worker.sql-wasm.js` concatenation in each build's `dist` directory. That
test-only worker asset is not included in the candidate pair. The suite reads
only its public upstream database fixtures, not application/user databases;
its long-statement test uses a bounded one-million-character string.
Other build variants, lint, browsers, the full SQLite test suite, application
storage regressions and independent security review are not supplied by this
runtime-only driver.

Two clean builds on one host demonstrate **local repeatability**, not
independent-host or diverse-toolchain reproducibility. A prepared toolchain,
one successful compile, or matching binaries without completed tests is not an
accepted candidate. On failure, `provenance.json` records `status: blocked`.

### Completed local qualification

Two independently extracted builds, with separate objects and Emscripten caches,
completed successfully on the qualified Ubuntu/WSL x86_64 host. Each passed the
bounded smoke checks and **24/24 upstream WASM tests**. Both produced:

| Candidate file | Bytes | SHA-256 |
| --- | ---: | --- |
| `sql-wasm.js` | 46,535 | `f1c84000dbc856c9d87f4f3aabc4d3654bd436165db4be3da13751db3a9c20d7` |
| `sql-wasm.wasm` | 675,092 | `2539b74ab967497223088846f66b3a017e841abc764c582559ed7fb3d2b062ec` |

The measured SQLite version/source ID matched 3.53.4 and the identity above.
FTS3, FTS3 parentheses, normalization, omitted loadable extensions and
`THREADSAFE=0` were present; FTS5 was absent. The numeric-to-text sample was
`1.2345678901234567`. Export/reopen/integrity passed with a 24,576-byte synthetic
database.

Native tools executed successfully: Node 24.21.0; Emscripten 5.0.0 at source
revision `a7c5deabd7c88ba1c38ebe988112256775f944c6`; clang 23.0.0git; Binaryen
125 (`version_125-114-g6c29e8513`); native Closure `v20240317`. The archive's
bundled dependencies sufficed: no npm installation, Java installation, global
package modification or shell-profile change was performed.

The driver also passed offline extraction/path/link/mode, Makefile parsing,
credential-environment isolation and subprocess-timeout checks. These are
runtime-build results, not by themselves application/browser acceptance,
independent review or public-release approval.

### Local application integration

The reviewed pair is now installed in the local application's vendor directory,
with complete identified component notices. The actual installed assets (without
the earlier candidate-only test preload) passed JavaScript syntax/publication
checks, **202 Node tests** and **42 Chromium browser tests**. Three additional
Node tests were skipped because the Windows account could not create file
symlinks; junction and hardlink checks passed.

Coverage includes numeric/storage-class/blob round trips, unknown columns,
generated columns, triggers/views, fractional cues, recovery and auth/logout
preservation. This is not verification against every Sports Audio DJ version,
independent-host reproducibility, live Spotify behavior or public-release approval.

### Linked-library evidence

A subsequent diagnostic relink reused the actual first build's C objects and
system-library cache, adding only these linker-reporting options:

```text
-Wl,--why-extract=out/link-members.tsv
-Wl,--Map=out/link-map.txt
-Wl,--trace
```

Its final wrapped JS and WASM were byte-identical to both clean builds. This is
**not a third clean build**. The sanitized extraction table, link map, trace,
command, object/archive hashes and reviewed legal-source references are
retained under `candidate/evidence/link-inventory`.

The linker reported 288 extracted members across eight archives:

| Archive | Extracted members |
| --- | ---: |
| `libc.a` | 251 |
| `libc_optz.a` | 6 |
| `libcompiler_rt.a` | 18 |
| `libdlmalloc.a` | 2 |
| `libc++-noexcept.a` | 2 |
| `libc++abi-noexcept.a` | 7 |
| `libnoexit.a` | 1 |
| `libstubs.a` | 1 |

The local evidence includes the libc++ and libc++abi license inputs as well as
the previously retained licenses, for notice reconciliation.
Archive extraction precedes LTO and subsequent WASM optimization: it does not
prove every member survives in the final binary, and is not an exhaustive
post-optimization object inventory or legal audit.

## Integration and notices remain separate

Maintainers install the pair only after concurrent writers have finished and
compatibility testing is ready. Preserve both files as a pair; do not stage one
over a different wrapper version. Do not update an integrity allowlist merely to
make an unreviewed candidate pass.

Before integration, reconcile the complete upstream sql.js MIT/third-party
license, SQLite public-domain dedication/source identity, the retained
extension's full header/attribution/disclaimer, applicable runtime-library
notices, custom-build disclosure, and the measured paired hashes. Build-tool
packages are not deployed. The documentation/notices owner, not this driver,
updates served notices and release manifests.

Git initialization/commits, public repository creation, pushes, deployment,
accounts, DNS and real-user database validation remain outside this procedure
and require the separate publication approvals.

[makefile]: https://github.com/sql-js/sql.js/blob/9c4e167ec37129192d166ab9223faa9a4bd07c58/Makefile
[container]: https://github.com/sql-js/sql.js/blob/9c4e167ec37129192d166ab9223faa9a4bd07c58/.devcontainer/Dockerfile
[installer]: https://github.com/emscripten-core/emsdk/blob/b4258c35121c8d0e12f53568ffb22236d7816723/emsdk.py#L2212-L2220
