# Development and contributing

Read [AGENTS.md](AGENTS.md) for architecture, privacy and interoperability rules.
Prefer focused fixes with regression coverage over a framework rewrite.

**Only explicitly confirmed logout/reset may clear all app data.** Startup,
reload, invalid login attempts, token/refresh/network errors and ordinary auth
updates must preserve valid stored auth, settings, the database and edits.
Reconnection must not require deleting the remembered Client ID or library.

## Local development

There is no application build step:

```powershell
python -m http.server 8000 --bind 127.0.0.1 --directory docs
```

Open http://127.0.0.1:8000/. Use a fresh, isolated browser profile when testing
code you do not trust; repositories sharing an origin also share access to
browser storage. Never point automated tests at a personal profile or library.

The local CI definitions select Node.js 24 and Python 3.12 on Ubuntu 24.04.
Use a supported Node.js LTS compatible with the locked packages and Python 3
for development. Workflow configuration is not evidence of a successful CI run
or a claim that every runtime/browser version has been tested.

```powershell
npm ci
npm run check
npm test
npm run check:publication
npx playwright install chromium
npm run test:browser
```

Chromium installation is needed when that browser binary is missing. Browser
tests start their own loopback-only server on port 4187; do not register it as a
real Spotify integration. Linux CI also installs Chromium's OS dependencies
with `npx playwright install --with-deps chromium`.

Tests use synthetic SQLite fixtures, jsdom/fake IndexedDB and blocked/mocked
Spotify calls. Never run real playback or use credentials as a test side effect.
Report commands actually run and any gaps; do not infer passing CI from workflow
files. `package.json` retains `private: true` to prevent npm publication; that
flag is independent of the intentionally public GitHub repository.

## Change checklist

- Preserve database relationships, unfamiliar columns, uppercase generated UUIDs,
  timestamp units, fractional cues and inherited settings.
- Capture pre-edit backups before mutation. Preserve valid data on failures,
  canceled pickers, overlapping edits and recovery conflicts.
- Keep playback state independent of visible tiles.
- Reject stale asynchronous work after replacement or confirmed logout.
- A pending OAuth registration authorizes a new callback, not restoration of an
  already established session. Reject only the bad transaction.
- Protect auth/erase writes with Web Locks. Missing coordination must fail safely
  without wiping data; peers must not independently repeat shared-data erasure.
- Keep export/cancel/discard safeguards. Do not add a Reset control or rename
  storage identifiers, database formats or exported filenames.
- Preserve keyboard focus, native controls, reduced motion, narrow-screen fit
  and readable normal/visited/hover/focus/pressed link and control states.
- Keep the sql.js JS/WASM pair and all upstream notices together.
- Do not commit account configuration, personal databases, tokens or diagnostics.
- Use your own verified GitHub noreply identity. Inspect author, committer and
  trailer metadata for every outgoing commit, not just current Git settings.

Describe intended behavior, a synthetic reproduction, validation results and
remaining limitations. Follow [SECURITY.md](SECURITY.md) for sensitive findings;
ordinary public bug reports must also be sanitized.

## Validation and distribution limits

The configured browser suite is Chromium-based. Viewport tests do not prove
Safari/iOS, Firefox, real touch hardware, screen-reader or Spotify-device behavior.
Synthetic database tests do not establish every Sports Audio DJ version's compatibility.
Authentication remediation and publication workflows still require integrated
validation before public release; do not remove that qualification without evidence.

Keep repository guides in `guides`, outside the deployed `docs` asset root.
Keep `LICENSE` and `docs/LICENSE.txt` byte-identical. Preserve
`docs/THIRD_PARTY_NOTICES.md` and the complete `docs/vendor/LICENSE.sqljs.txt`.
Development dependencies and browser test artifacts are not Pages assets.

Public release is a later, explicit checkpoint after local validation and review
of source/history and site manifests. Local edits do not authorize Git
initialization, commits, repository creation, pushes, account/DNS changes or
deployment. Follow [the release runbook](guides/deployment.md).
