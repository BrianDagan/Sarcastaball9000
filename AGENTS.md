# Working on DJDad

## Architecture and commands

This is a static Spotify Connect remote controller, not a browser audio mixer.
GitHub Pages serves `docs`. `app.js` is a classic browser script; `index.html`
and `styles.css` define the UI. The local sql.js JavaScript/WASM pair in
`docs/vendor` reads and exports SQLite files. No backend, build step, analytics,
or CDN is required.

- Serve locally: `python -m http.server 8000 --bind 127.0.0.1 --directory docs`
- Open `http://127.0.0.1:8000/`; Spotify's registered callback must match exactly.
- Install development dependencies: `npm ci`
- Syntax check: `npm run check`
- Unit/regression tests: `npm test`
- Publication asset/license gate: `npm run check:publication`
- Browser regression tests: `npm run test:browser` (install the Playwright
  Chromium binary with `npx playwright install chromium` if it is missing).

Do not run real Spotify playback as a test side effect. Tests use synthetic
SQLite fixtures and mocked Spotify responses; no credentials are needed.

## State and compatibility

The app coordinates in-memory SQLite/pending edits, a versioned IndexedDB recovery
record, localStorage settings/auth, and a DOM-independent playback snapshot.
Playback configuration must not depend on whether a tile is currently rendered.

Preserve the originating database format: PlaybackGroup relates to
Playback.playbackGroupUUIDRaw; Playback.sourceUUIDRaw relates to Sound.soundUUIDRaw.
Preserve uppercase UUIDs, timestamp units, fractional cue columns, and inherited
volume/fade conventions. Do not invent schema migrations or sentinel meanings.
Never overwrite a valid cache with an unvalidated import. Capture backups before
mutations, make saves transactional, and preserve edits arriving during a save.
The versioned recovery record stores bytes, associated pending edits and a
pre-edit snapshot together. Legacy localStorage pending edits migrate only with
their existing cached database; stale tabs must not overwrite newer recovery.

Async commands must respect current intent. Stale refresh, playback, search,
save, or import completions must not restore state after logout/replacement.
Surface failures without dumping private data or claiming success.

**Only explicit confirmed logout/reset may clear all app data.** Startup, reload,
missing/expired PKCE, rejected callbacks, token/refresh/network failures and
ordinary auth updates must preserve valid stored auth, settings, recovery and
edits. An established session does not require a pending OAuth registration.
Invalid credentials may require reconnecting; retain the Client ID and library.
Missing Web Locks must fail safely without wiping data. Peer notifications
reconcile local state, not repeat a global purge. Do not add a reset control.
Moving to a new origin requires deliberate login/import there, not erasing the
old origin. Preserve existing storage identifiers and database/export filenames.

## Privacy and publishing

- Never commit or upload credentials, Spotify user/device identifiers, private
  hostnames, imported databases, browser storage, real fixtures, or personal logs.
  A public OAuth client identifier is not a client secret, but neither belongs
  in an account-specific committed setup.
- Keep reports redacted: category, relative path, line and remediation only.
  Never verify discovered credentials against a live service.
- The approved public metadata exceptions are creator/copyright Brian Dagan,
  `Copyright (c) 2026 Brian Dagan`, new PUBLIC `briandagan/Sarcastaball9000`,
  `https://github.com/briandagan/Sarcastaball9000` and planned site
  `https://sarcastaball.briandagan.com/`. They permit no other PII or account
  configuration. Keep `private: true` for npm; it is not GitHub visibility.
- Public source and Pages assets are intentional and discoverable. Retain
  `noindex, nofollow`; it and the Spotify Development Mode allowlist are not
  website authorization. Do not claim publication or private reporting is live
  before it is verified.
- Logout offers export, cancellation, or explicit discard before erasing only
  DJDad-owned browser data. Starting a download does not prove that it was saved.
  Never erase original/downloaded files or unrelated origin storage.
- Local preparation is approved, not public release. Git initialization, commits,
  creation of the approved PUBLIC repository, pushes, custom-domain configuration
  and publication remain separately gated. Review the release manifests and
  obtain explicit release approval first. Never substitute another destination
  or visibility. Before commits, verify a GitHub noreply identity and inspect
  every outgoing author, committer and trailer, not just Git configuration.
- Vendor JS and WASM must stay paired. The local pair is a custom build based on
  sql.js 1.14.2 with SQLite 3.53.4; hashes and complete component notices are in
  `docs/THIRD_PARTY_NOTICES.md`, with build provenance in `guides/runtime-build.md`.
  Do not substitute the official sql.js 1.14.2 pair, which uses older SQLite.
  Verify provenance and license before replacement; a match does not prove
  absence of vulnerabilities. Keep root `LICENSE` and served `docs/LICENSE.txt`
  byte-identical. Repository-only guides belong outside the deployed `docs` root.

## Scope and style

Preserve the current design and database interoperability. Prefer focused helpers
and regressions over a framework rewrite. Use native accessible controls, keep
keyboard focus truthful, and accommodate narrow/short screens and text zoom.
Keep the shared baseball SVG centered, square and inset; do not replace it with
a spinning font glyph. Animate artwork separately from playhead positioning and
honor reduced motion. Scope Settings-only layout changes to its own dialog.
Give native emoji controls explicit accessible labels independent of the glyph.
Theme both foreground and background on dynamic action buttons; check enabled
normal, hover, keyboard-focus and pressed text contrast against 4.5:1.
Use the shared volume-capability guard for every live volume/fade path. iPad/iPhone
controllers must not send volume commands; hide unusable controls without losing
stored values or end-cue pauses. Fullscreen state must follow browser events;
unsupported browsers get the accessible, browser-selected Home Screen help tabs.

Automatic iPad idle silence is gated by the selected Spotify device name
containing `iPad` (case-insensitive), never controller/UA or all Apple outputs.
Keep `in-ipad-keepalive` default-on when `s9000.ipadKeepAlive` is absent, with
persistent opt-out. Require visibility, valid auth, fresh eligible/unrestricted
device state and repeat confirmed Off; automatic idle must not replace playing
music. Eligible Pause and Stop switch to silence; Stop clears the tile, not
Spotify playback. Pause retains the original tile/position for explicit Resume.
Use the catalog track's reported duration for visible-only near-end renewal;
no Repeat One, repeat/queue-management, volume/fade or database changes.
Stop renewal on hidden/pagehide; opt-out pauses only freshly confirmed app-owned
silence. Never reset auth/data on failure or promise background execution,
acoustic silence or no audio after the track ends. Keep the local feature
contract and safe manual checks in `guides/configuration.md` accurate.

Spotify control is best-effort, not sample-accurate or background-safe. Do not add
Spotify mixing/overlap or public/business-playback features.
