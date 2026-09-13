# Security and privacy

Sarcastaball 9000 is a static Spotify Connect controller, not a private hosting
service, encrypted vault or server-enforced owner-only website.

**Only an explicitly confirmed logout or app reset may clear ALL app data.**
Startup/reload, missing or expired PKCE, rejected callbacks, token expiry,
refresh/network failures and ordinary auth updates are not reset requests.
They must preserve valid remembered sign-in, settings, the database and edits.
Invalid or revoked credentials may require reconnecting, not deleting the
remembered Client ID or library. No new Reset control is provided.

The authentication lifecycle below is implemented and covered by deterministic
Node and isolated Chromium regressions, including the storage-preservation cases.
That is not a claim of hosted CI, every browser/device, or comprehensive security
validation. Public release remains separately gated.

## Reporting vulnerabilities

Do not post exploit details, credentials or personal data in public issues,
pull requests or discussions.

Private vulnerability reporting is not yet confirmed for the planned
`briandagan/Sarcastaball9000` repository. Once enabled and verified, use GitHub's
**Security -> Report a vulnerability**. If that option is unavailable, do not
post sensitive details publicly or assume an unpublished contact address exists.
A public issue may request a private reporting channel without disclosing the
finding, account information or exploit.

Maintainer publication prerequisite: enable and verify private reporting, then
replace the pending-channel wording with confirmed instructions. No private
email address, response-time promise or supported-version guarantee is supplied.

Even private reports should begin with a redacted description and synthetic
reproduction, not real data. Include affected behavior, potential impact,
relative source location, browser/OS version and a minimal invented example.

If credentials were exposed, revoke or replace them through the provider. Do not
test discovered credentials against a live service.

## Safe ordinary bug reports

Report expected versus observed behavior, a synthetic reproduction and a
sanitized error category or HTTP status.

Do not attach databases, browser-storage dumps, account/device identifiers,
configured Client IDs, authorization codes, PKCE values, tokens, cookies, HAR
files or unreviewed logs. Screenshots must not expose account names, private
playlists, device names, personal labels or local file paths.

A public OAuth Client ID is not a secret, but an account-specific value still
does not belong in committed examples or reports. Public creator/repository/domain
attribution is deliberate; it is not permission to publish other personal data.

## Browser data and origin isolation

| Location | Use |
| --- | --- |
| Memory | Access token, working SQLite database, pending edits and playback state |
| localStorage | Remembered sign-in, settings/device metadata and temporary pending-login registrations |
| sessionStorage | Temporary tab-local PKCE verifier/state for sign-in |
| IndexedDB | Database recovery, associated pending edits and pre-edit snapshot |
| Downloads | User-requested SQLite exports and backups |

The authentication release contract uses revocable, per-state shared
registrations with a 10-minute expiry for unfinished attempts and client/redirect
bindings. That expiry never applies to established saved sessions. Registrations
must contain no verifier, authorization code or tokens. Web Locks coordinate
registration, callback claims, credential persistence and explicit erase across
the origin. A registration is required for a new OAuth callback, not for
restoring an already established saved session.

Missing Web Locks must produce a useful error for protected auth operations,
not an unlocked fallback or an automatic wipe. Failure of one pending login
may clean up that transaction, not all application data. Preserve recoverable
browser data on storage/network errors and report uncertainty rather than success.

Browser storage is sensitive application data, not an encrypted vault. Same-origin
scripts can access it; different repository paths are not isolation. Prefer a
dedicated HTTPS subdomain without unrelated scripts.

Changing host, protocol or port changes the origin. Export work before moving;
sign in and import deliberately on the new origin. Moving from localhost does
not erase its data, and later same-origin reloads should not need another import.
Do not transfer browser credentials through URLs or SQLite exports.

## Network and hosting

The app loads same-origin assets and uses Spotify authorization/API services.
It has no application database-upload endpoint or required analytics integration.
This is not a guarantee against disclosure: hosting providers, Spotify and the
browser process request metadata under their own policies.

No-referrer, callback-parameter cleanup and CSP are defensive measures, not
universal guarantees. Public source, DNS and certificate records can make the
site discoverable. `noindex, nofollow` is a crawler request, not authorization.
Spotify allowlisting controls API access, not access to the page. Do not add a
robots rule that prevents crawlers from seeing the page's noindex directive.

Source scans and synthetic tests do not inspect real browser profiles, personal
libraries, downloads, Spotify account settings or hosting accounts. A vendor
hash match establishes provenance, not absence of vulnerabilities; see the
[third-party notices](docs/THIRD_PARTY_NOTICES.md).

## Export and confirmed logout

An export requests a local download, not an upload. Verify the saved file before
relying on it or confirming erase. The app does not add browser credentials to
SQLite exports, but imported data can itself contain private information.

Logout offers export, cancellation or explicit discard before removing owned
browser data. It must not delete originals, previous downloads or unrelated
apps' storage. Close older app tabs before upgrades/erase; older loaded code may
not participate in current cleanup and open connections can block deletion.

The required cross-tab design gives one explicit logout/reset coordinator
responsibility for shared-data erasure. Peers close relevant database connections
and reconcile local revoked state; late or duplicate notifications must not
purge shared storage or erase a newer session. No persistent logout epoch or
marker is retained after successful erase.

Browser APIs cannot immediately delete tab-local sessionStorage in a tab
currently away at Spotify. Revoking its shared
registration makes that pending login unusable; the temporary tab-local state
physically remains until the tab returns or closes. This does not erase Spotify's
own session. Fresh returns and back-forward-cache `pageshow` restoration reconcile
revoked tab-local material; an old tab must not recreate missing authority from
its verifier.

Logout does not revoke Spotify's session or grant and does not guarantee audio
stops. Use Spotify/device controls and account authorization settings. Keep
independent backups in case of browser eviction, profile loss or manual clearing.
