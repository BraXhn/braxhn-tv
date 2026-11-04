# Security policy

*Svenska: rapportera säkerhetsbrister privat enligt nedan – inte som ett öppet ärende. Svenska eller engelska går bra.*

BraXhn TV is built to be reachable from the internet, so security reports are taken seriously and handled before anything else.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: **[Report a vulnerability](https://github.com/BraXhn/braxhn-tv/security/advisories/new)** (the *Security* tab → *Advisories* → *Report a vulnerability*). Only the maintainers can see the report.

Please include:

- what an attacker can do, and from where (internet, home network, signed in as a regular user, a kids profile, a music app …),
- the steps or a minimal proof of concept,
- the BraXhn TV version (image tag or `sha-…`) and how the server is reached (direct, reverse proxy, VPN),
- whether you want to be credited, and under which name.

Don't include real passwords, tokens or personal data – test against your own server.

## What happens next

- You get an answer within **7 days**, usually much sooner.
- We confirm the problem, agree on a fix and a date, and keep you updated.
- The fix is released as a new image (`latest`), described in [CHANGELOG.md](CHANGELOG.md) and published as a GitHub security advisory. We ask you to wait with publishing details until the fix is out, normally at most **90 days**.

## Supported versions

Only the latest release (`ghcr.io/braxhn/braxhn-tv:latest`) and the `beta`/`edge` channels get security fixes. Update via *Docker → Check for updates* in Unraid.

## Scope

In scope: the server (`server/`), the web app (`web/`), the Docker image and the Unraid templates, and the apps in `apps/`. For example: bypassing sign-in, 2FA, age limits or library permissions; reading files outside the libraries; stream/image tokens that give more than one title; XSS, CSRF or injection; secrets leaking into logs, URLs or the diagnostics bundle.

Out of scope: problems that require an administrator account on the home network, denial of service by flooding, self-XSS, missing security headers without a concrete attack, vulnerabilities in your own reverse proxy, VPN or Unraid, and reports from automated scanners without a demonstrated impact.

## Hardening tips

See *Security* in [README.en.md](README.en.md#security) (or *Säkerhet* in [README.md](README.md#säkerhet)): HTTPS, 2FA or passkeys on every administrator, *Require 2FA away from home*, administration only from home, and *Administration → Security check*.
