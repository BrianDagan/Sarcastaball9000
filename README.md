# Sarcastaball 9000

A static, browser-based **Spotify Connect remote** for personal/private listening.
Load a compatible SQLite library export from **Sports Audio DJ**, organize song
buttons, and control playback on a Spotify device.

**Audio plays on the selected Spotify device, not in this browser.** This is not
a dual-deck mixer or a sample-accurate cue system. No backend, application build,
analytics service or CDN is required.

- Public source: https://github.com/briandagan/Sarcastaball9000
- Intended website: https://sarcastaball.briandagan.com/
- Created by **Brian Dagan**
- Project license: [MIT](LICENSE)

The source repository is public and GitHub Pages is configured for checked
Actions deployments. The custom hostname still needs Cloudflare DNS setup and
GitHub certificate/HTTPS verification; see the [deployment guide](guides/deployment.md).
Passing checks do not establish compatibility with every browser or Spotify device.

## Data preservation comes first

**Only an explicitly confirmed logout or app reset may clear ALL app data.**
Normal same-origin startup/reload, missing or expired PKCE, rejected callbacks,
token expiry, refresh/network failures and ordinary auth updates must not reset
valid stored sign-in, settings, the database or edits. An established session
does not require a pending OAuth registration.

Invalid or revoked authorization may require reconnection, but the remembered
Client ID, library, pending edits and settings must be preserved. There is no
new Reset control; Reload database is not a destructive reset. See the
[authentication release requirements](guides/architecture.md#authentication-release-requirements)
and [recovery guide](guides/configuration.md).

## Prerequisites

- Your own eligible Spotify Premium account and developer application.
- A Spotify device supporting the commands you intend to use.
- Your own compatible **Sports Audio DJ SQLite export**, with independent backups.
- A browser supporting JavaScript, WebAssembly, Web Crypto, Web Locks and browser
  storage in a secure context.
- Python 3 for local serving; Node.js/npm only for development and tests.

Specific Sports Audio DJ versions have not been verified. No personal library or
starter database is bundled. Each cloner supplies their own Spotify app, account,
Client ID, callbacks and playback device; this is not a shared developer app.
The Chromium regression suite is not proof of Safari/native-iOS, Firefox, real
touch hardware or all Spotify-device support.

## Windows quickstart

Clone the public repository:

```powershell
git clone https://github.com/briandagan/Sarcastaball9000.git
Set-Location .\Sarcastaball9000
python -m http.server 8000 --bind 127.0.0.1 --directory docs
```

Open **http://127.0.0.1:8000/**. Register that exact URL, including the trailing
slash, as a redirect URI in your own
[Spotify developer app](https://developer.spotify.com/dashboard).

In Setup, enter its public **Client ID**, sign in, load a copy of your library and
select a Spotify device. **No client secret is required or should be entered.**
Start with an appropriate device and per-song volume.

Do not double-click `index.html`, substitute `localhost`, use `/index.html` as
though it were the same callback, or expose Python's development server to the
internet. See [configuration](guides/configuration.md) for hosted/fork callbacks,
browser requirements and troubleshooting.

## Before relying on it

- Keep originals and important exports independently. Browser recovery is not
  archival storage and can be lost to profile clearing or browser eviction.
- Imports validate a candidate before replacement; cancel if you still need to
  export current work. A canceled picker is not permission to discard edits.
- The first edit captures a pre-edit snapshot. **A requested download is not
  proof that the file was saved.** Verify important exports and backups yourself.
- Logout offers export, cancellation or explicit discard. It does not delete
  originals/downloads, revoke the Spotify grant or guarantee remote audio stops.
- A new hosting origin requires a deliberate one-time sign-in/import there.
  Moving from localhost does not erase the local-origin data. Never move
  credentials through callback URLs or library exports.
- Playback, fades and end cues are best-effort network controls. Keep the
  controller visible and check Spotify directly when a command is uncertain.
- **Keep iPad Spotify awake** is enabled by default for selected Spotify devices
  whose names contain `iPad`. While visible, idle time, Pause and Stop use a silent
  track instead of leaving Spotify paused; Resume restores the paused tile.
  Disable it in Setup for normal Pause/Stop behavior. Keep Spotify Repeat off;
  queue/Autoplay behavior after leaving the page is not controlled by this mode.
  See [idle playback and its limits](guides/configuration.md#automatic-ipad-idle-silence).
- Public source and site assets are discoverable. `noindex, nofollow` and
  Spotify allowlisting do not provide website authorization.

## Guides

- [Configuration, recovery and troubleshooting](guides/configuration.md)
- [Deployment and forks](guides/deployment.md)
- [Architecture and database compatibility](guides/architecture.md)
- [Custom SQLite runtime build and provenance](guides/runtime-build.md)
- [Development and contributing](CONTRIBUTING.md)
- [Security, privacy and safe reports](SECURITY.md)

Repository guides live outside `docs`, the public Pages asset root. Development
dependencies, synthetic fixtures and browser test artifacts are not site assets.

## License

Original project material, including the shared baseball SVG, is distributed
under [MIT](LICENSE). The [served MIT license](docs/LICENSE.txt) is byte-identical.
Retain the [third-party notices and runtime hashes](docs/THIRD_PARTY_NOTICES.md)
and all complete component notices, including the [sql.js license](docs/vendor/LICENSE.sqljs.txt), with
redistributed assets. A provenance match is not a vulnerability clearance.

The software license does not grant rights to music, Spotify content, trademarks
or imported data. Spotify use remains subject to its
[developer policy](https://developer.spotify.com/policy); this project is intended
for personal/private listening, not Spotify mixing/overlap or public/business playback.
