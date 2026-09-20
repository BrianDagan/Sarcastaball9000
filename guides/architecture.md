# Architecture and database compatibility

## Runtime

| File | Responsibility |
| --- | --- |
| `docs/index.html` | UI, dialogs, metadata and local references |
| `docs/styles.css` | Layout, readable control/link states and animation |
| `docs/app.js` | Classic browser application script |
| `docs/assets/baseball.svg` | Original shared favicon/header/playhead artwork |
| `docs/vendor/sql-wasm.js` and `docs/vendor/sql-wasm.wasm` | Paired local SQLite runtime |
| `docs/LICENSE.txt` and `docs/THIRD_PARTY_NOTICES.md` | Deliberately served project license and notices |

No backend or application build is required. Initialization wires UI/auth and
restores browser recovery. Spotify supplies authorization, catalog/device data
and remote playback; the app does not upload the SQLite library.

The shared baseball artwork is centered, square and inset. Artwork rotates
separately from playhead positioning and respects reduced motion. Emoji controls
use independent accessible labels; their glyphs can vary between platforms.

`docs` is the public Pages asset root, including its retained `.nojekyll` and
complete vendor license. Repository guides live outside it. The
[deployment runbook](deployment.md) requires a clean, explicit site-file allowlist,
not packaging the repository, dependencies or browser artifacts.

## State boundaries

- Working in-memory sql.js database.
- Pending overlays for color/delete/move/cue/volume/hotkey edits.
- Versioned IndexedDB recovery containing bytes, associated edits and baseline.
- Browser preferences and authentication, including temporary PKCE state.
- A playing-track snapshot independent of visible DOM tiles.

**Only explicit confirmed logout/reset may clear ALL app data.** Startup/reload,
missing or expired PKCE, rejected callbacks, token/refresh/network failures and
ordinary credential updates must preserve valid stored auth, settings, recovery
and edits. Invalid credentials may require reconnecting, not discarding the
remembered Client ID or library.

Internal DJDad/`s9000` names, storage identifiers and export filenames are
compatibility contracts, not targets for public-branding cleanup. A new host,
protocol or port requires deliberate login/import there, not erasure of the old
origin. No Reset control or database-schema migration is introduced for publication.

## Authentication release requirements

The following contract is implemented and locally covered by synthetic Node and
Chromium regressions. It remains a requirement for future changes, not a claim
of comprehensive browser/security verification or hosted deployment.

- Register each explicitly initiated login by random state in origin-shared
  storage before asynchronous challenge preparation/navigation. Use independent,
  revocable registrations bound to client, redirect and a 10-minute expiry
  (`LOGIN_TTL_MS`) for unfinished attempts only, never established saved sessions.
- Keep the PKCE verifier tab-local. A shared registration must contain no verifier,
  authorization code or tokens.
- Scrub callback parameters and require both matching tab-local state and a live
  shared registration. Atomically claim and later consume the transaction; reject
  missing, malformed, expired, replayed and legacy/unregistered attempts. Never
  recreate missing authority from old sessionStorage.
- Use one origin-wide Web Lock for registration/claim/consumption, OAuth and
  refresh credential commits, and explicit shared erasure. Keep network waits,
  user export and confirmation outside that lock. Do not queue an old login
  start behind an in-progress erase so that it can reappear afterward.
- Revalidate the claim with final credential persistence and update memory only
  after persistence succeeds. Cleanup retires only its own transaction, not a
  newer login or a valid remembered session. Preserve refresh single-flight and
  saved-auth comparisons.
- Registration authorizes a **new callback only**. An already established saved
  session must recover normally without one. Token rotation/invalidation is not
  a request to erase the database, pending edits, preferences or Client ID.
- One explicit logout/reset coordinator clears shared data. Peers close relevant
  database connections before waiting on the gate, then reconcile local revoked
  bindings; delayed/duplicate notifications must not independently purge shared
  data or erase a newer session/database.
- Missing Web Locks or storage failures must fail clearly without an unlocked
  fallback or an automatic wipe. Continue recovery independently of failed auth
  where browser storage is readable.

No persistent logout epoch or marker is retained after successful erase. A tab
currently away at Spotify keeps its tab-local PKCE material physically until
return/close, but revocation of the shared registration makes it unusable.
Fresh returns and back-forward-cache `pageshow` restoration reconcile revoked
tab-local material.
This is not immediate cross-origin physical erasure or revocation of Spotify's
own session/grant. Old loaded versions may not implement the protocol; export
work and close them before upgrading or erasing.

Acceptance must cover fresh-document reload/recovery, rejected callbacks with
a good saved session, away-origin callbacks after logout without delivered
storage events, both exchange/erase write orders, independent pending tabs,
expiry/replay, delayed refresh, missing locks, storage failures and blocked
IndexedDB deletion. Use synthetic data and blocked/mocked external requests.

## Database contract

A user-supplied **Sports Audio DJ SQLite export is a prerequisite**, not a
verified native-app version matrix. Imports use a separate candidate,
`PRAGMA quick_check`, and required-table/column validation before replacement.
`DATABASE_COLUMNS` in `docs/app.js` is the current required-column list; test
fixtures are not the complete Sports Audio DJ format or a bundled starter library.

| Table | Role |
| --- | --- |
| `PlaybackGroup` | Tabs/groups, keyed by `playbackGroupUUIDRaw` |
| `Playback` | Buttons, keyed by `playbackUUIDRaw`, linked by `playbackGroupUUIDRaw` |
| `Sound` | Track data, keyed by `soundUUIDRaw`, referenced by `Playback.sourceUUIDRaw` |
| `AppSettings` | Imported defaults from the first row |

The AppSettings table is required, but its columns are not prescribed by the
validator. Known defaults include volume and fade durations.

Preserve:

- Existing tables, extra columns, unfamiliar values and identifier relationships.
- Uppercase new UUIDs; no unrequested rekeying of existing data.
- Unix-epoch seconds for created/updated timestamps.
- Separate seconds/fractional-seconds start and stop cue columns.
- `Sound.playbackDuration` in seconds, including fractional duration.
- Normalized volume with `-1` inheritance and negative inherited fade values.
- Other native-app flags without inventing meanings or implementing Spotify overlap.

Adding a track can reuse an existing Sound row with the same Spotify track ID.
Synthetic checks do not establish every native-app version's interoperability.
Runtime provenance, hashes and license caveats are in the
[third-party notices](../docs/THIRD_PARTY_NOTICES.md).

## Edits, export and recovery

Some changes are pending overlays, others immediately mutate the in-memory
database. Both participate in recovery and dirty tracking. Capture the baseline
before the first mutation.

Export copies the database and applies pending edits transactionally. It produces
SQLite, not a browser-settings export, and does not overwrite the original file.
Save must preserve edits arriving while its snapshot waits for storage. A download
request alone cannot establish that the file was saved.

IndexedDB uses database `s9000`, store `files`, key `db`. Its format-1 record has
an opaque conflict-detection version, database identity, bytes, pending edits,
optional baseline and baseline-active flag. This record format is separate from
the exported SQLite schema.

Legacy pending edits migrate only with their existing cached database. Stale
tabs must not overwrite newer recovery; missing historical baselines cannot be
reconstructed. Export before downgrading; old code cannot read the newer record.

## Lineup view and attendance

Standard remains the default layout. Per-tab Lineup uses the same track-button
renderer and playback UUIDs, with sibling drag/attendance controls rather than
interactive elements nested inside a song button. Track menus, pending overlays,
played flags and playback snapshots remain shared with Standard.

Layout and attendance live in a separate format-1 localStorage record under
`s9000.lineup.<encoded database identity>`. Its `layouts` map is keyed by group
UUID and its `absent` map by playback UUID. Neither tab titles/positions nor
Spotify track IDs identify a preference. Save/recovery keep the library
identity; a successful imported replacement gets a new identity and therefore
fresh Standard/present defaults. Browser-only changes do not dirty the SQLite
database or get embedded in exports.

Preference updates read/merge/write a validated record under the Lineup Web
Lock and the existing auth/erase gate. Before writing, they check the current
recovery identity with an existing-only IndexedDB read. A stale queued writer
must not recreate settings or even an empty recovery database after a missed
logout/import notification. Same-library storage events refresh local views
without writing back. Invalid records and storage failures retain existing
data and report failure rather than silently discarding attendance.

Track ordering is separate: `writePlaybackOrder()` checks exact group membership
and the current working revision, then uses the existing transaction/backup/
recovery path for native `Playback.orderIndex` and update timestamps. Tab sorting
shares this helper; the resulting order is checked before commit so a native
trigger cannot silently ignore the reorder. Canceled/unchanged drops do not mutate data; pending edits,
unfamiliar native columns and newer edits during Save remain intact.

Pointer capture and custom scrolling apply only to the handle. Dragging previews
an insertion marker and commits once at a valid drop. Cancellation and the
shared document-level release-click guard prevent playback or menu activation
from an ending gesture. Keyboard and non-drag move actions use the same order
helper, preserving focus by UUID rather than row index.

An absent playback UUID is restricted only while its actual owning group uses
Lineup, regardless of which tab is rendered. The command guard is independent
of DOM/ARIA styling and covers detached retries and asynchronous device/token
completion. Reject already-blocked commands before they alter transport intent
or cancel fades/idle renewal. Attendance changes do not interrupt current audio;
Pause, Stop, end-cue pauses and idle silence are unaffected. Standard retains
but ignores absence flags. Existing commands already sent to Spotify cannot
be recalled, and externally initiated playback is outside this UI restriction.

## Asynchronous playback and limits

Epochs, revisions and intent counters guard replacement and teardown. Playing
cues do not depend on the selected tab's tiles. Commands are queued, but
already-sent remote requests cannot be recalled by changing local intent.

Successful playback commands need not return JSON; nonempty data responses must
be valid JSON. Failed commands remain visible. Pause/resume invalidates obsolete
toggle restrictions without discarding unrelated item restrictions.

Network timing, browser suspension and external Spotify changes remain limits.
The fetch timeout covers awaiting fetch, not a guarantee of bounded body parsing.
The Chromium suite uses synthetic state, not real account/device behavior or a
Safari/native-iOS compatibility certification.
