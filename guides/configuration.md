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

When the controller runs on an iPad or iPhone (including an iPad presenting a
desktop user agent), it does not send Spotify volume commands. The right-side
rail and fine-volume row are hidden, and volume/fade settings are disabled with
an inline explanation instead of a repeated popup. The same controls are hidden
when the selected Spotify device reports that volume control is unsupported.
Stored volume/fade values are retained, not reset.

Start, pause, resume, seek and stop still work where the device permits them.
Volume fades are skipped, but end-cue pauses remain independently scheduled.
A manually requested Fade Out keeps its configured delayed stop even when it
cannot ramp the volume. Supported desktop/device volume control remains available;
genuine API failures are still reported.

There is no automatic fade-on-pause in the iPad/iPhone controller configuration.
Spotify plays the audio in its own app, and Sarcastaball cannot ramp its level
without supported volume commands. Pause therefore stops the song directly
(or transitions to idle silence below). Use physical speaker/mixer controls for
a manual fade; this limitation cannot be fixed by sending more volume requests.

The [automatic iPad idle mode](#automatic-ipad-idle-silence) changes eligible
Pause/Stop behavior, not these volume protections.

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

### Editing an existing track on iPad

Touch and hold a song tile without moving for about half a second, then lift your
finger. Its action menu offers **Rename song**, **Copy song**, **Set hotkey**,
played/unplayed marking, deletion and moves to other tabs. Opening that menu does
not play or pause the song; tap an action separately after lifting your finger.
This is the same right-click context menu used with a mouse, not a separate edit
dialog or an immediate Rename action.
Moving to scroll, canceling the touch or leaving the page cancels a pending hold.
Ordinary short taps and configured double/triple taps retain their playback actions.

An attached mouse/trackpad can use a secondary click. With keyboard focus on a
tile, the Context Menu key or Shift+F10 opens the same menu where the browser
delivers those keys. Press Escape or tap outside to dismiss it.

The visible app/browser-tab title is **Sarcastaball**. Repository references,
browser-storage identifiers and database/export filenames remain unchanged.

## Standard and Lineup layouts

Right-click or touch-and-hold a **tab name**, then choose **Lineup** under
**Layout**. Choose **Standard** to return to the original grid. Every tab can
be configured independently; no tab name automatically enables Lineup.
With a keyboard, focus a tab and use the Context Menu key or Shift+F10.

Lineup shows one full-width row per existing track button. Each row has a
three-line reorder handle, its position number, the existing song button and
a **Present** checkbox. Song titles, cues, colors, hotkeys and played marks
retain their existing meanings. Holding/right-clicking the song still opens
its complete action menu, including Copy song.

Drag the handle to place a row before or after another row on the same tab.
Near the list's top/bottom edge, the list scrolls to reach additional players.
Dragging the song body is not a reorder gesture; normal scrolling and pinch
zoom remain available there. Escape, a canceled/multi-touch gesture or leaving
the view cancels a drag without applying its preview. A drop does not play a song.

Alternatively, click/tap the handle for **Move Up / Move Down**, or focus the
handle and use the Up/Down keys. After a move, focus stays with that player.
Use the existing song menu's **Move to** action to move between tabs.

### Attendance during a game

Uncheck **Present** to mark a player **Absent**. Their row remains in place,
keeps its position number and becomes dimmed; it is not deleted or skipped in
the numbering. Its reorder handle, attendance control and song action menu
remain available. The played mark is independent: a previously played song
can still be played again, whereas an absent player cannot be started/resumed
while their tab uses Lineup.

Attendance restrictions also apply to keyboard/hotkey activation, toolbar
Resume and Retry, even when another tab is visible. Marking a player absent
does **not** stop music already playing or remove its end cue. Pause and Stop
remain available, and eligible iPad idle silence continues normally while
paused. Mark the player present before resuming, or change their own tab to
Standard. Neither change automatically resumes anything.
Saved cue edits are still possible, but a blocked preview does not resume or
seek the idle audio; mark the player present to hear the preview.

Standard ignores, but remembers, that tab's absence flags. Switching back to
Lineup restores them. For the next game, the Lineup tab menu's
**Mark everyone present** command clears only that tab's absence flags after
confirmation. It does not change order, played marks or other tabs. There is
no automatic date-based reset.

### What is saved where

Reordering updates the existing SQLite `Playback.orderIndex` field through
the normal backup, dirty-state and browser-recovery path. The order also
appears in Standard. Use **Save** to export it in the database; dragging does
not overwrite the original file on disk.

Layout and attendance are browser-only preferences, separate from database
edits. They survive same-browser reloads, browser restarts, tab renames/reorders
and Save/export, provided browser storage is retained. They do not travel with
the exported SQLite file or transfer to another browser/origin. No native
database columns or tables are added.

Every successful new database import starts with Standard layouts and everyone
present, even when importing a previously exported copy with the same IDs.
Recovering the existing browser library is different from importing a file:
recovery retains its preferences. Failed/canceled imports leave them intact.
New/copied buttons start present; existing buttons retain their attendance
when moved, with restrictions determined by their destination tab's layout.

Preference read/write errors are reported without erasing existing data.
Resolve browser-storage access problems and use **Retry loading settings**,
then repeat a change that was not saved. Missing Web Locks does not permit
unprotected preference writes. Unreadable attendance cannot silently authorize
a new Start/Resume; Pause, Stop and database export remain available.

## Automatic iPad idle silence

This section describes the local feature contract for builds with **Settings ->
Playback -> Keep iPad Spotify awake**. It is not a claim of public deployment or
new hardware validation. The preference is on when absent and is saved for this
origin under `s9000.ipadKeepAlive` (`0` means off); uncheck it to opt out.

The same switch is available in the top icon bar and stays synchronized with
Settings. Its fixed-size icon shows **coffee** when enabled and waiting,
a **sleeping face** when off, and a **muted spinning baseball** while idle silence
is running. Reduced motion disables the animation without changing the reported
state. Normal activity no longer adds a banner or shifts the grid; genuine
keep-awake errors still display their explanation and Retry action.

A reported iPad trial lost control after about two minutes paused, while
continuous playback of a silent Spotify track kept it reachable beyond two
minutes. That supports an idle-playback workaround, not a confirmed iPadOS cause,
background-timer guarantee or compatibility claim for other iPads, Safari or
Home Screen mode.

The mode is automatic only when the **selected Spotify playback-device name
contains `iPad`, case-insensitive**. It does not select devices based on the
controller's device/user agent or apply to every Apple output. This rule is
independent of the controller-based iPad/iPhone volume guard.

Automatic idle playback requires all of the following:

- The app is visible and authorization is valid.
- Fresh Spotify state confirms that the selected device is present, eligible,
  unrestricted and idle. A missing, offline, stale or unknown device/state is not
  permission to play.
- Spotify's repeat state is confirmed **Off**. If repeat is enabled, the app asks
  you to turn it Off in Spotify, then retry; it does not silently change it.

Automatic idle detection must not replace music that Spotify reports as already
playing. When eligible, the app uses a normal Spotify play command for the
[linked silent catalog track](https://open.spotify.com/track/3mkOlbSv5RYadx0JsjTrKq).
That ID identifies public catalog content, not an account or device. It is not
added as a SQLite library tile; library data, playback flags and stored
volume/fade values are preserved. Idle playback sends no volume/fade commands.

### Pause, Stop, Resume and opting out

With keep-awake enabled and the selected device eligible:

- **Pause switches Spotify to the silent track**, rather than leaving Spotify
  paused. DJDad retains the paused tile's original song and position.
- **Resume explicitly restores that song at the saved position**, subject to
  Spotify Connect timing; it must not merely resume the silent track.
- **Stop clears the active tile but starts or continues silent Spotify
  playback. Stop does not stop Spotify while this mode is active.**

Automatic idle playback also preserves a locally paused tile. It can, however,
replace the Spotify playback context of a song paused outside DJDad. DJDad
cannot export or restore Spotify's remote queue; the saved local tile/position
is not a queue backup. The paused playback snapshot is in memory, not stored in
the library: reloading the page does not retain that temporary resume position.

Uncheck **Keep iPad Spotify awake** to stop renewal and restore normal Pause/Stop
behavior. Normal behavior also applies when the selected output is ineligible.
Disabling requests a pause only if fresh state confirms that the current track
on the intended device is silence started by this app; it leaves unrelated
playback alone. A failed or unconfirmed pause still needs checking in Spotify.
Opting out does not reset sign-in, settings, library data or edits.

The neighboring **Track Played** switch uses an uncovered monkey face when on
and a covered-eyes monkey when off. Its original played-marking behavior is
unchanged; both switches retain explicit accessible labels independent of icons.

### Foreground renewal and limits

The app reads the track's actual reported duration and uses a renewal deadline
with network headroom: up to one minute before its natural end, capped at a
quarter of the reported duration for shorter tracks. Response time counts toward
that deadline, and the next check moves forward when the deadline is nearer than
the normal polling interval. Delayed observations from before a confirmed restart
cannot move the new cycle's deadline back to the old one.

Each restart still requires fresh eligible device/playback state, valid auth and
a visible page. This is not an unconditional timer that overwrites another song.
The app does not enable
Spotify's global Repeat One or issue repeat/queue-management commands. Repeat
must remain confirmed Off.

Renewal stops on hiding or leaving the page (`pagehide`). A page cannot guarantee
background JavaScript execution, and a closed page cannot renew playback.
Stopping a timer cannot recall a remote play command already issued.
**Closing, locking or backgrounding
the app does not guarantee silence or stop Spotify.** If a restart is missed,
Spotify's queue or Autoplay can start other audio after the track ends. The app
does not mix or overlap tracks, and a successful provider command does not
acoustically verify that the audio is silent. Check Spotify/device controls
directly when stopping audio matters.

Missing/offline iPads, restricted devices, unavailable catalog content and
provider denials are recoverable errors, not reasons to log out or clear data.
Keep the app visible, open Spotify on the intended device, refresh/reselect it
and use **Retry** after addressing the reported cause. If repeat is the blocker,
turn it Off in Spotify yourself. Respect any rate-limit wait; repeated retries
do not fix provider eligibility or quota restrictions.

### Safe manual acceptance check

This is an optional user-run check with your own eligible account/device, not an
automated test or a claim that it has passed. Do not make real Spotify playback
a test-suite side effect.

1. Use a safe listening level set directly on the device/Spotify. Confirm the
   intended output is present in Spotify and selected in DJDad, with `iPad` in
   its name. Confirm repeat is Off and review the queue/Autoplay risk first;
   remain able to stop unexpected audio directly.
2. Keep the controller visible in the foreground and the screen unlocked.
   Check the reported track duration and observe at least two automatic restarts,
   not merely two minutes (for a ten-minute track, allow more than twenty minutes).
   Note whether the screen stays awake and the muted baseball stays in its
   running state. A locked/hidden page is a separate case and cannot guarantee renewal.
3. Confirm an already-playing song is not automatically replaced. Test **Pause**
   and **Resume** with a library tile: silence should run while the tile remains
   paused, then the original song should return at its retained position.
   Test **Stop** separately: the tile clears, but silent Spotify playback remains.
4. Disable the setting and verify the app-owned silence pauses if Spotify state
   confirms it is still current. Verify normal Pause/Stop behavior while off,
   the opt-out survives reload, and a nonmatching selected output is not
   automatically kept awake. No sign-in or library reset should be needed.
5. For any failure, note the exact displayed status/error and HTTP status if
   shown, whether the selected device remained listed, and whether the page was
   visible. Redact account/device names, identifiers and authentication details;
   do not attach personal libraries, browser storage or unreviewed logs.

Longer success on one device still does not establish behavior on other
iPads/browsers or while locked/backgrounded. Use mock Spotify responses for
automated regressions; these do not establish real-device reachability or
acoustic silence.

## Full screen and Home Screen help

The toolbar's **Full screen** button enters/exits native webpage fullscreen when
the browser permits it. Its label and pressed state follow actual browser events,
including an exit through the browser's controls. Requests can be denied by the
browser; no playback or stored data changes are needed to enter fullscreen.

If native fullscreen is unavailable, the same button opens **Full screen and
Home Screen** help. It is also available from Setup's **Display** section.
The dialog has Safari, Chrome, Edge and Firefox tabs, with the detected browser
selected and the detected device's row identified. Detection is best-effort;
select another tab if needed. Arrow keys, Home and End navigate the tabs.

For Safari on iPhone/iPad, use **Share -> Add to Home Screen**, select **Open as
Web App** if offered, then **Add** and launch the new icon. Chrome on iPhone/iPad
also exposes the action through Share on supported versions. If Edge or Firefox
does not offer it, open the same URL in Safari. The other tabs include
conditional Android and desktop menu guidance.

Menu names and installation support vary. A shortcut may open a normal browser
tab rather than a standalone window. A Home Screen app or another browser can
have separate storage: keep a database export and sign in/import there if needed.
This does not erase the current browser's data. Fullscreen/Home Screen mode does
not guarantee background execution, offline Spotify control or exact cue timing.

References:
[Apple's Home Screen guidance](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios),
[Chrome's web-app guidance](https://support.google.com/chrome/answer/9658361),
and [Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API).

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
| iPad keep-awake unavailable/failed | Check the selected name contains `iPad`, device presence/restrictions, valid authorization and repeat Off; keep the page visible and Retry after resolving the reported cause, without logout/reset |
| Spotify keeps playing after Stop | With eligible keep-awake enabled, Stop clears the tile but leaves silent playback running; disable the setting and confirm Spotify pauses, or stop directly in Spotify |
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
