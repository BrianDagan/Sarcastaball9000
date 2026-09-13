# License and third-party notices

Original project material is covered by the accompanying [MIT license](LICENSE.txt),
Copyright (c) 2026 Brian Dagan. The shared baseball SVG is original artwork.
Third-party components retain their own terms; the project license does not grant
rights to music, Spotify content, trademarks or imported databases.

## Bundled runtime

The `vendor/sql-wasm.js` and `vendor/sql-wasm.wasm` pair is a **custom build
based on sql.js 1.14.2 with SQLite 3.53.4**, not an official sql.js distribution.
Two clean builds with independent objects/caches produced identical files;
each passed the bounded smoke checks and 24 upstream WASM tests.

| Asset | SHA-256 |
| --- | --- |
| `sql-wasm.js` | `f1c84000dbc856c9d87f4f3aabc4d3654bd436165db4be3da13751db3a9c20d7` |
| `sql-wasm.wasm` | `2539b74ab967497223088846f66b3a017e841abc764c582559ed7fb3d2b062ec` |

The source inputs are sql.js commit
`9c4e167ec37129192d166ab9223faa9a4bd07c58` and the official SQLite 3.53.4
amalgamation. The compiler release stamp is Emscripten 5.0.0, with executed
archive source revision `a7c5deabd7c88ba1c38ebe988112256775f944c6`.
The source repository's runtime-build guide records inputs, exact build rules,
measured hashes and limits. No personal libraries were used in the build.

sql.js uses the MIT license. Preserve its **complete**
[upstream license](vendor/LICENSE.sqljs.txt), including the additional
attributions and license text for portions of the Makefile. The project MIT
license does not replace or shorten that file. SQLite describes its core as
[public domain](https://sqlite.org/copyright.html); that does not remove the
sql.js distribution's own notices or automatically license contributed code.

Retain these complete candidate-matching notices:

- [Emscripten, including Node-derived-code terms](vendor/LICENSE.emscripten.txt)
- [musl copyright and notices](vendor/COPYRIGHT.musl.txt)
- [compiler-rt license and LLVM exceptions](vendor/LICENSE.compiler-rt.txt)
- [libc++ license and LLVM exceptions](vendor/LICENSE.libcxx.txt)
- [libc++abi license and LLVM exceptions](vendor/LICENSE.libcxxabi.txt)
- [SQLite, contributed extension, math, sorting and runtime component notices](vendor/NOTICE.runtime-components.txt)

The diagnostic link recorded 288 extracted archive members, including libc++ and
libc++abi support. Extraction precedes LTO/optimization; these notices conservatively
preserve the identified source terms, not a claim that every member survives.

The unchanged historical `extension-functions.c` has no embedded license statement.
Its exact source appears in Liam Healy's repository history, which later added
the reproduced Unlicense dedication. That source/history relationship is recorded;
every earlier contributor's rights were not independently exhaustively verified.

Keep this notice and all complete vendor notices with distributed site assets.
Update the JS/WASM pair and these version/hash records together only after
provenance, license and database-compatibility review.

**A matching hash does not establish freedom from vulnerabilities.** This build
contains the SQLite versions' fixes for the identified `concat_ws` and
CVE-2025-6965 issues; it is not a claim that all retained code is vulnerability-free.
Compiler acquisition used verified TLS and pinned EMSDK metadata, not an
independently verified publisher signature for the compiler archive. Repeatability
was checked on one host, not across independent toolchains.
This is not a complete binary, transitive-dependency, contributor-rights or
advisory audit. Application/native-format acceptance and public-release approval
remain separate from compiler and upstream test success.

## Development-only dependencies

| Direct dependency | Declared license |
| --- | --- |
| `@playwright/test` | Apache-2.0 |
| `fake-indexeddb` | Apache-2.0 |
| `jsdom` | MIT |

These are not deployed with the Pages asset directory. The lockfile records
resolved development dependencies, including transitive packages; they and
installed browser binaries retain their own upstream licenses/notices.
Redistributing that tooling requires reviewing those notices separately.
The project MIT license does not replace them, and this short direct-dependency
table is not an exhaustive software bill of materials.
