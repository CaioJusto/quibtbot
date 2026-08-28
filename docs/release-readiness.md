# Release readiness

This is the evidence ledger for an open-source Quibt Bot release. A green unit suite is not the
same as a signed installer, a successful VPS install, or a physical-device mobile test.

## Current audit evidence (2026-08-28, `v0.2.9` → `v0.2.14`)

| Surface | Evidence | What is still required |
| --- | --- | --- |
| Source | `pnpm lint`, `pnpm check` (21 tasks), `pnpm build`; full `pnpm verify`: 2,858 tests plus 4/4 Chromium journeys against two disposable PostgreSQL databases; 189 installer tests and the 3-step installer smoke are green on the release candidate | Keep the released commit and tag identical |
| Docker computer | The `docker-smoke` CI job builds `quibt/computer:local` on a Linux runner, boots a workspace container and starts a real graphical session. It caught a boot regression on this very tree before release | Runs on `workflow_dispatch` and nightly, not on every push |
| VPS | The `vps-compose-smoke` CI job installs the published Compose stack on an amd64 runner, applies every migration and waits for API/web readiness | It pulls the **published** images, so it validates a release, never an unreleased commit |
| Phone → clean VPS, end to end | On `v0.2.10`: `quibtbot install` on a clean Hetzner VPS chose a `sslip.io` name and obtained a Let's Encrypt certificate; a physical iPhone scanned the pairing QR, reached the server over that HTTPS, consumed the bootstrap invite and created the first owner (2026-08-25 18:36 UTC). The web preview host allowlist fix is in this image, so the phone passes the former 403 | Onboarding after sign-up (model → machine → first bot) on the phone is the next manual check |
| Public HTTPS (no domain) | On a clean Hetzner VPS (Ubuntu 24.04), `quibtbot install` chose `quibt-<id>.<ip>.sslip.io`, Caddy obtained a Let's Encrypt certificate in ~3 s (`issuer=Let's Encrypt`, verified from outside with no TLS exception), and Caddy→web→API answered `/rpc/health` 200. Two bugs found on that run are fixed with tests: health probed the https origin before Caddy was up, and a resumed install handed the phone `http://127.0.0.1` | The web preview's host allowlist fix ships in the **next** stack image; until it is published, the phone reaches the API only through the fixed image. Re-run the clean-VPS install on that image before calling the path released |
| Desktop | **`v0.2.9` / `v0.2.10`:** the Apple-silicon DMG is Developer ID signed, notarized and stapled. **`v0.2.11` / `v0.2.12`:** the CI DMGs are unsigned. **`v0.2.14`:** the release workflow initially publishes an unsigned CI build and records the real status in `signing-status-mac.json`. Windows and Linux remain unsigned test builds. | `v0.2.14` Mac DMG: replace it with the maintainer's notarized build, update its signing status and checksums, then flip `DESKTOP_SIGNING.mac`. Windows needs an Authenticode certificate. Intel Mac is not published. |
| Mobile | iOS builds and installs on device from this tree; SSH to a modern server works after libssh2 was upgraded to 1.11 (the shipped NMSSH pod only spoke `ssh-rsa`/`ssh-dss`, which OpenSSH 8.8+ refuses) | The visible QR/thread/attachment/computer journey on a physical phone is still a manual check |
| Publication | The repository is public with a single initial commit. Container images are public and multi-architecture; release artifacts and their SHA-256 files are attached to the tag | Older history lives only in the maintainer's private archive |

## Required gates

| Gate | Evidence required | Current state |
| --- | --- | --- |
| Source quality | format, lint, TypeScript, `verify:fast`, full `verify` | Green on the final candidate: 339 test files passed, 1 skipped; 2,858 tests passed, 4 skipped; Chromium 4/4; focused PostgreSQL 13/13; installer 189/189; smoke 3/3. |
| Security | Standard repository scan; no unresolved critical finding | Scan is sealed; critical finding is fixed locally, while two documented high architectural limits remain |
| Supply chain | versioned CLI + checksums; packaged Docker images pinned by digest | CLI sidecars verified; tagged image, CLI, Windows, Linux, and VPS jobs passed before the account-level Actions billing hold |
| Desktop | macOS Apple-silicon DMG, Windows installer, Linux AppImage; signing status attached; `DESKTOP_SIGNING` matches the attached status | `v0.2.14`: Mac DMG is the unsigned CI build until the notarized replacement is uploaded; Windows and Linux are explicitly unsigned; Intel is not part of this release |
| VPS | install, migration, `/ready`, web `/rpc/health`, first-owner pairing, restart | Release smoke passed; a real provider/account canary remains useful evidence, not a blocker for self-host preview |
| Mobile | TypeScript/tests plus QR, code, thread, attachment, and computer control on a physical phone | Production OTA is published; visible physical-device journey remains blocking for a device-level claim |
| Publication | public repository, source tag equals artifact version, checksums and release notes | Publish the tag-generated assets and replace the embedded provisional CLI digests with the real v0.2.14 checksums before the production OTA |

## Known architectural limits

- The Docker/remote-supervisor provider uses one computer container per workspace. Separate bot
  desktops are not hostile process boundaries; use E2B or Box for mutually untrusted bots.
- An already-open noVNC connection is bounded by its short-lived capability but is not yet revoked
  synchronously when a control lease is released. This remains a release-hardening item.
- Same-LAN HTTP pairing is not safe against an active hostile network. Prefer HTTPS or Tailscale.
- Installers are not called signed or notarized unless the attached per-platform signing status says
  so.

## Release rule

Do not overwrite an existing tag with different binaries. Fix the source, bump the version, let the
release workflow build every artifact from that tag, review the draft and its signing-status files,
then publish it. GitHub source publication, container publication, installer publication, and an
authenticated/device test are separate claims.

**Signing gate for the public copy.** Only point `INSTALL_RELEASE` (and with it the site, README
and docs) at a tag after downloading that tag's `signing-status-mac.json` / `signing-status-win.json`
and copying their values into `DESKTOP_SIGNING` in `packages/installer/src/compose.ts`. The
landing page picks the Mac sentence from that constant (`apps/www/src/site.test.ts` checks the
rendered sentence against it), so a tag whose DMG is the unsigned CI build ships with
"right-click → Open" instead of "notarized". When the maintainer later replaces the DMG by the
notarized one (as on `v0.2.9`), re-read the status file and flip the constant in the same commit
as the README / `docs/desktop.md` / `docs/onboarding.md` wording.
