# Security

## Reporting vulnerabilities

Email **caio@liaforschool.com.br** only. Do not open public GitHub issues for security bugs.

Please include:

- Steps to reproduce
- Impact (what an attacker could do)
- Whether the issue is already public

We will acknowledge your report and work on a fix. Please do not file a public issue for unfixed vulnerabilities.

## Other contact

- General support: **caio@liaforschool.com.br**
- Maintainer: **caio@liaforschool.com.br**

## Scope

This policy covers **this repository**: the open-source Quibt Bot product.

Out of scope:

- Third-party AI models and their APIs
- Composio, E2B, and other external services
- Operator misconfiguration (exposed secrets, open databases, weak passwords)

## How the product protects itself

Short list of the guarantees the code enforces, so a report can point at the one that broke:

- **One key per job.** `BETTER_AUTH_SECRET` signs the session cookie only. The bot screen
  capability, the internal web→API proxy proof, and the desktop app's local-session capability each
  use a key derived from it under its own label. A leaked screen URL is not an oracle for the
  session key.
- **Local auto-login is loopback-only.** `POST /api/local/session` answers `404` unless the install
  itself is loopback. On a LAN or public install the route does not exist, and entry is by password
  or by a pairing code. A private forwarded address is never accepted as proof of physical
  presence.
- **The desktop app proves possession, not position.** It signs a capability with the
  `BETTER_AUTH_SECRET` of the local `quibt.env`: one minute, single use, bound to the method and
  path. Without that file it sends nothing and falls back to the normal sign-in.
- **Fail-closed boot.** The Compose services run as production (`NODE_ENV=production`) and refuse a
  secret that is missing, shorter than 32 characters, or still starting with `replace-with-`. The
  source Compose also needs `SANDBOX_SUPERVISOR_TOKEN`, `BOOTSTRAP_SECRET`, and either
  `RESEND_API_KEY` or `AUTH_EMAIL_DISABLED=true`.
- **Model endpoints are restricted.** `models.connect` only reaches an explicit local target
  (`127.0.0.0/8`, `localhost`, `host.docker.internal`) or a public address. Private ranges and
  cloud metadata (`169.254.169.254`) are refused before any socket, by name and by resolved IP, and
  every failure returns the same message, so the probe is not a port scanner.
- **Registration is closed by default** (`SIGNUPS_ENABLED=false`), and the supervisor is never
  published.

## Supported versions

We support security fixes on the current `main` branch and the latest release (beta).

There is no bug bounty program at this time.
