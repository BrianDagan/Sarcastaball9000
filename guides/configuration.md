# Configuration, recovery and troubleshooting

**Only explicitly confirmed logout/reset may clear all app data.** Same-origin
startup/reload, missing or expired PKCE, rejected callbacks, token/refresh/network
failures and ordinary auth updates must preserve valid stored sign-in, settings,
the library and edits. Invalid credentials may require reconnecting, not
re-entering the Client ID or discarding the library. There is no new Reset control.

The authentication behavior has passed local synthetic Node/Chromium checks.
See [the architecture contract](architecture.md#authentication-release-requirements)
for its boundaries; this is not a guarantee for every browser or live account.

## Your own Spotify application

Use your own eligible Spotify Premium account and app in the
[Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
Enter its public **Client ID through Setup**. Authorization Code with PKCE
requires no client secret, server environment variable or committed account
configuration.

Current Development Mode requires Premium for the app owner and has authorized-user
limits. Keep only your intended account allowed for personal use. A user may
complete OAuth but receive API 403 if not authorized for that developer app.
Recheck [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
because provider eligibility and limits can change.

Cloners supply their own export, account, app, Client ID, callbacks and playback
device. They do not share the maintainer's Spotify configuration or credentials.

## Exact callback URLs

| Use | Callback |
| --- | --- |
| Local development | `http://127.0.0.1:8000/` |
| Planned upstream deployment | `https://sarcastaball.briandagan.com/` |
| Your fork | Your canonical HTTPS URL, including a repository path if applicable |

The app derives its callback from the current origin and pathname. `/index.html`
and `/` differ. Open the canonical URL and register the value shown in Setup,
including its scheme, host, port, path and trailing slash. Spotify permits HTTP
for explicit loopback IPs, not `localhost`; production requires HTTPS. See
[redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).

Use the same browser tab to start and complete a new sign-in. A pending-login
registration is required only for that new OAuth callback, not for normal
restoration of an established session. An unfinished attempt expires after
10 minutes; this is not a limit on established saved sessions or Spotify's token
lifetime. Missing, expired or revoked login state must reject that attempt without
resetting a good existing session or database.

Requested scopes cover private/collaborative playlists, playback-state reads,
currently-playing information and playback control. Do not put a Spotify account
identity, configured Client ID, callback authorization code or PKCE verifier into
repository examples or support reports.

## Browser requirements and limits

Serve the app over HTTPS or the explicit loopback HTTP address; do not open it
as a `file:` URL. It needs JavaScript, WebAssembly, Web Crypto and browser storage.
Web Locks are required for protected authentication writes: if unavailable,
the app must fail safely without an unlocked fallback or an automatic data wipe.
Use a supporting secure-context browser while preserving/exporting existing work.

Storage-disabled/private modes, browser eviction and multiple old tabs can limit
recovery. Browser storage is not an independent backup. Repositories served under
different paths on the same origin share its storage, so use a dedicated origin
without unrelated scripts.

The automated browser suite uses isolated Chromium. Small-screen and enlarged-text
tests are not proof of native iOS/Safari, Firefox, touch hardware, screen-reader
behavior or every Spotify device. No comprehensive compatibility matrix is claimed.

## Device and Sports Audio DJ library

Open Spotify on the intended device, activate playback if needed, refresh the
device list and select it. Check volume before testing. Some devices reject
transfer, seek or API volume; use physical/Spotify controls when required.

A compatible SQLite export from **Sports Audio DJ is a prerequisite**. Specific
native-app versions have not been verified. No personal library or starter
database is bundled, and synthetic fixtures are not a starter-library feature.

The database can have any filename, including `SADJDatabase.sqlite`. The chooser
intentionally shows all file types: some browsers or file providers do not
classify SQLite exports consistently. The app validates the selected file's
SQLite integrity and required schema rather than trusting its name or MIME type.

1. Keep an independent original and import a copy.
2. Integrity/schema validation precedes replacement of active data and recovery.
3. Cancel a replacement if current work still needs export; canceling a file
   picker leaves current work intact.
4. The first edit captures a pre-edit snapshot. Setup's **Download pre-edit
   backup** can download the retained snapshot again.
5. Export working data and verify the actual saved file. Requesting a download
   alone is not proof that the browser saved it.
6. For logout, export and verify, cancel, or explicitly confirm discard.

Recovery is not full version history. If another tab changed recovery, export
this tab's work before reloading. Close older app tabs before upgrades or erase.
Legacy edits migrate only with their existing cached database; migration cannot
reconstruct a pre-change baseline that was never saved. Export before downgrading;
older app versions cannot read the newer browser recovery record.

Confirmed logout clears only this app's browser data, not originals, downloaded
files or unrelated origin storage. It does not revoke the Spotify grant or
guarantee remote audio stops. Check Spotify/device controls directly and use
Spotify account settings if you also want to revoke the grant.

## Search and playback limits

Local Find searches the loaded library. Add Song searches Spotify or browses the
user's playlists. Track search requests use the current maximum of 10 items.
The app uses `/playlists/{id}/items`, reads the current `item` field and retains
a legacy `track` fallback.

Local files, non-track entries, unusable IDs/durations and explicitly unplayable
tracks are filtered. A page with no usable tracks can still have another page.
Seeing playlist metadata does not guarantee access to its contents; Development
Mode can restrict contents to owned/collaborated playlists.

See [Spotify API changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026).
Provider limits and contracts may change.

The latency indicator measures a command's API round trip, not speaker latency.
Fades and end cues depend on browser scheduling, network and device behavior.
Keep the controller visible. Screen Wake Lock does not guarantee uninterrupted
background execution or exact silence timing. This is a Connect remote, not
Spotify mixing/overlap or public/business-playback software.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Callback rejected | Exact origin, port, path and trailing slash |
| Sign-in mismatch/expired flow | Only that attempt is rejected; start a fresh login if needed without resetting existing data |
| Web Locks unavailable | Use a supporting browser in a secure context; do not clear storage to solve missing coordination |
| Spotify 401 | Reconnect through Setup if authorization is invalid; retain the library, edits, settings and Client ID |
| Refresh/token/network failure | Preserve data, check connectivity and retry or reconnect as needed; logout is not a prerequisite |
| Spotify 403 | Premium, allowlist, scopes, playlist access and device restrictions |
| No device / Spotify 404 | Activate Spotify, refresh/reselect the device, and check track availability |
| Spotify 429 | Respect rate limiting; quota exhaustion is not fixed by repeated retries |
| Import rejected | Preserve the original; schema or integrity may be unsupported |
| File grayed out in the picker | Refresh to load the unfiltered chooser; if it remains unavailable, download a local copy through your file manager/provider. Do not rename or reset app data to bypass this. |
| Recovery write failed | Keep the tab open and export before reloading or clearing any data |
| Erase blocked | Close other app tabs using that origin; do not clear unrelated storage |
| Download missing | Check download permissions/history before acknowledging erase |
| WASM unavailable | Serve `docs` over HTTP/HTTPS with the paired vendor assets present |
| Unconfirmed Stop/seek/fade | Check Spotify directly; use device controls |

Use [safe reporting guidance](../SECURITY.md), not personal databases, storage
dumps or unreviewed network logs, when requesting help.

## Moving to a hosted origin

Moving from localhost to the hosted HTTPS site is an origin change, not an app
reset. Browsers do not automatically share storage across host/protocol/port
boundaries. Export work, then deliberately sign in and import on the new origin
once; this does **not** erase local-origin data. Normal later visits at the same
origin should restore its stored settings, sign-in and library.

Never transfer credentials through URLs or SQLite exports to bypass the origin
boundary. Register the new canonical callback separately and retain the local
callback if you still use it. The upstream hosted address remains planned until
the [deployment checks](deployment.md) have actually passed.
