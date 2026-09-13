# Deployment and forks

The PUBLIC `briandagan/Sarcastaball9000` repository now exists, with GitHub Actions
Pages publishing configured, a `main`-only deployment environment, and private
vulnerability reporting enabled. The intended site is
`https://sarcastaball.briandagan.com/`, with creator Brian Dagan and MIT licensing.
Cloudflare DNS and certificate/HTTPS verification for that hostname are still
pending. The steps below remain the runbook for that setup and future forks;
do not assume that configuring Pages alone makes the custom hostname reachable.

Repository guides stay outside `docs`, the entire deployed static asset root.
Retain `noindex, nofollow`; public repository contents, DNS and certificate records
still make discovery possible. A public website is not owner-only authorization.

## Explicit release checkpoint

Local preparation does **not** authorize Git initialization, commits, repository
creation, pushes, account/DNS changes or deployment. Before public release:

1. Complete authentication remediation and synthetic data-preservation validation.
2. Review current dependencies/provenance, advisories and all required notices.
3. Validate the checks/deployment workflow and exact source and Pages file manifests.
4. Re-scan outgoing files/history with redacted results. Exclude personal libraries,
   account configuration, credentials, real diagnostics and generated artifacts.
5. Obtain a later, explicit approval for the reviewed PUBLIC source/history and
   first publication. Do not infer it from permission to edit local files.

No credentials or live-account tests are needed for local preparation.

After that approval, verify the intended authenticated GitHub account/permissions
and that the new repository does not unexpectedly exist. Never overwrite an
unexpected repository, force-push, or substitute another owner or visibility.

Use the exact verified GitHub-issued noreply address from account email settings.
Configure identity repository-locally with the approved public name, not globally.
Inspect **author, committer and every trailer of all outgoing commits**, not just
Git config; config changes do not sanitize earlier metadata. Review identity
settings for web-created commits and merges too. Do not print personal addresses
or tokens in reports. See [GitHub noreply identities](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference#your-noreply-email-address).

Enable and verify private vulnerability reporting before claiming it is available,
then reconcile [SECURITY.md](../SECURITY.md). No email, SLA or passing badge is implied.

## Checks-gated GitHub Actions

The local workflow definitions are:

- [`checks.yml`](../.github/workflows/checks.yml), workflow **Checks**:
  read-only PR checks and reusable validation.
- [`pages.yml`](../.github/workflows/pages.yml), workflow **Pages**:
  recheck `main`, package it, then deploy separately.

| Workflow | Job ID | Configured display name |
| --- | --- | --- |
| Checks | `validate` | Validate |
| Pages | `checks` | Main checks, calling the reusable Checks workflow |
| Pages | `package` | Package Pages |
| Pages | `deploy` | Deploy Pages |

These are YAML names, not verified live required-check contexts. Configure
required checks using actual emitted names from a verified run, including any
reusable-workflow name prefix. The configured main validation is expected as
`Main checks / Validate`; verify that name after approved bootstrap rather than
assuming it has already been emitted. Reconcile this table if the workflow
changes. The presence of YAML alone does not mean CI or protections are working.

Both validation paths require locked installation, syntax checks, Node regressions,
`npm run check:publication` and isolated Chromium regressions. The local definitions
select Node.js 24, Python 3.12 and Ubuntu 24.04. Both Node setup steps use
`check-latest: true` to request the latest available 24.x release. Linux CI
explicitly installs Chromium's OS dependencies with
`npx playwright install --with-deps chromium`. Actions use full-commit-SHA pins;
their provenance/review and actual execution still belong to the release
validation gate.

| Stage | Required trust boundary |
| --- | --- |
| PR checks | `pull_request`, `contents: read`, no account/deployment secrets |
| Main checks | Validate the actual `main` commit again; PR success is not substituted |
| Package | Clean checkout of that same checked commit; approved `docs` files only |
| Deploy | Separate main-only job, successful checks/package dependencies, job-scoped `pages: write` and `id-token: write` only |

Disable persisted checkout credentials. Never use `pull_request_target`,
privileged follow-up execution of PR code, fork/PR artifact promotion,
`continue-on-error`, `always()` or an unconditional path to bypass failed checks.
Keep checkout/install/app/test execution out of the deployment-permission job.

Packaging must reject unexpected files and symlinks and exclude databases,
environment/account files, logs, credentials, tests, `node_modules`, browser
profiles and generated reports. Publish only the explicitly reviewed static
assets, including the unchanged complete sql.js license, the custom runtime's
complete component notices, `LICENSE.txt` and `THIRD_PARTY_NOTICES.md`. The current
reviewed manifest contains sixteen files. Recheck root/served MIT byte equality.

### Default-off bootstrap gate

Keep publishing disabled until Pages and the **main-restricted `github-pages`
environment** are configured. The nonsecret repository variable
`PAGES_PUBLISH_ENABLED` uses the canonical value `true` to enable packaging and
deployment. GitHub expression string comparisons are case-insensitive; this is
not a case-sensitive literal guard. Leave the variable unset or set to `false`
to skip packaging/artifact upload and deployment; main validation still runs.
This is a bootstrap switch, not a credential or a bypass around checks.

Enable the switch only at the later release checkpoint after repository/Pages
and environment setup. Then run fresh validation of the actual main commit.
Do not deploy an earlier fork/PR artifact just because it passed once.

No Cloudflare API token, personal access token or Spotify credentials belong in
workflow secrets. Use the platform's narrowly scoped Pages/OIDC permissions.
See [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

### Serialization and safe retries

The whole release uses concurrency group `pages-main-publication` with
`cancel-in-progress: false`, so a deployment in flight is not canceled by another
release. Before packaging, a read-only main-tip check rejects a checked commit
that is no longer the current `main`.

Successful validation and packaging record their run attempt. Package/deploy
gates require those outputs to match the current `github.run_attempt`, and the
artifact name includes the run ID and attempt. A deploy-only or failed-jobs retry
must not reuse an earlier attempt's checks or main-tip guard.

**Retry all jobs or start a fresh Pages `workflow_dispatch` on `main`.** If
`main` has advanced since the original run, use a fresh dispatch to validate its
new commit. Do not weaken the attempt/main checks or promote an old artifact to
make a partial retry deploy.

## Manual domain setup, in order

These are later owner-operated steps. Preserve every unrelated DNS/SSL setting.
The domain is bound by GitHub repository settings; a DNS CNAME routes traffic.
They are different controls.

### 1. Verify domain ownership before routing traffic

Request verification for `sarcastaball.briandagan.com` in the owning GitHub
account's **Settings -> Pages**. The owner manually enters the generated TXT
record in Cloudflare's `briandagan.com` zone:

| Type | Name within the zone | Content | TTL |
| --- | --- | --- | --- |
| TXT | `_github-pages-challenge-briandagan.sarcastaball` | Copy the exact generated value directly from GitHub | Auto |

Use GitHub's displayed challenge name if different. Verify ownership in GitHub
and retain the TXT. Do not put the generated value in source or reports.

### 2. Bind the repository domain before the traffic CNAME

In the new repository, choose **Settings -> Pages -> Source -> GitHub Actions**.
Save **Custom domain: `sarcastaball.briandagan.com`** before routing traffic there.
Keep publishing gated until the main-restricted environment and other release
prerequisites are ready.

For custom Actions publishing, a repository `CNAME` file is ignored/not required.
Do not create a root CNAME file as a substitute for the Pages setting. See
[custom-domain management](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

### 3. Add only the scoped, DNS-only traffic record

The owner manually enters:

| Type | Name | Target | Proxy | TTL |
| --- | --- | --- | --- | --- |
| CNAME | `sarcastaball` | `briandagan.github.io` | DNS only / gray cloud | Auto |

The target has no scheme, repository name or URL path. Leave apex, `www`, mail,
unrelated TXT, wildcard, nameserver, redirect and zone-wide SSL settings unchanged.
Stop for a scoped decision if conflicting records, restrictive effective CAA or
unexpected flattening appear; do not make speculative broad changes.

References: [GitHub domain verification](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages),
[Cloudflare subdomain records](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-subdomain/).

## GitHub certificate and HTTPS

With DNS-only records, GitHub serves the website and TLS. GitHub Pages
automatically provisions the certificate. **No purchased certificate, Cloudflare
Origin CA certificate, Cloudflare API token or Universal SSL change is needed.**
Do not disable/change certificates used by other sites.

Once the release gate and hosting prerequisites are satisfied, enable publishing,
run fresh main validation and confirm the expected artifact was deployed. When
GitHub's DNS/certificate checks succeed, enable **Enforce HTTPS**.

Do not add a zone-wide Cloudflare Always Use HTTPS rule: DNS-only traffic does
not traverse that HTTP proxy. GitHub's Enforce HTTPS supplies the site redirect.
See [GitHub HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
and [Cloudflare proxy status](https://developers.cloudflare.com/dns/proxy-status/).

## Later live verification and owner-only Spotify setup

Only after separately approved publication, verify:

- Valid TLS without certificate-bypass flags, HTTP-to-HTTPS redirection and the
  canonical custom hostname.
- The default github.io project's custom-domain redirect. Observe actual behavior
  rather than assuming a fixed redirect hop count.
- Every expected static asset, About/source/license links, retained
  noindex/nofollow, CSP/no-referrer and absence of mixed content.
- Actual check success, deployment/environment restrictions and private reporting.

Use a fresh unauthenticated profile for website checks, not a personal browser
profile or a library-bearing automated fixture. Real-account/device checks are
separate owner-assisted work without collecting private logs or screenshots.

After HTTPS passes, the owner registers `https://sarcastaball.briandagan.com/`
as the exact Spotify callback, retaining `http://127.0.0.1:8000/` if local use
continues. Keep only the intended account in the owner's Development Mode
allowlist; it restricts API use, not public website access.

The owner signs in and imports their own Sports Audio DJ export at the new
origin once. **Do not erase localhost data.** Subsequent same-origin reloads
must preserve valid stored auth, settings, database and edits. Only explicit
confirmed logout/reset may clear all app data; auth/PKCE/network failures and
ordinary credential updates are not permission to reset it.

## Forks and rollback

Forks use their own repository settings, Pages environment/gate, public links,
DNS/domain verification and Spotify app/Client ID/callbacks/device. They do not
inherit upstream credentials or permission to claim the upstream hostname.
Changing a CNAME file alone cannot configure an Actions site. Preserve required
copyright/license attribution and supply your own library.

Rollback functional code through a reviewed revert and successful checks, not
an unchecked manual/fork artifact. Turning off publishing stops future deployments;
it does not remove already published content or erase anyone's browser data.

For decommissioning, remove traffic DNS before dropping the GitHub domain binding
so DNS is not left dangling. Retain ownership verification where appropriate and
do not touch unrelated records or certificates.

Public source may be copied once published. Deleting a repository cannot undo
that disclosure; exposed credentials require provider-side revocation/rotation.
