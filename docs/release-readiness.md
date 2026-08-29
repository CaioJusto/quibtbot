# Release readiness

This is the evidence ledger for an open-source Quibt Bot release. A green unit suite is not the
same as a signed installer, a successful VPS install, or a physical-device mobile test.

## Current audit evidence (2026-08-29, `v0.2.9` → `v0.2.17`)

`v0.2.15` stopped in the pre-publication fast suite because the unsigned Mac copy used the word
"notarizado". `v0.2.16` passed the complete release workflow and produced a private draft, but it
was deliberately not published: the desktop Box installer did not recognize a valid no-env response
when `environment` was omitted and did not retry trial accounts with a finite TTL. The Mac notary
profile is also unavailable. `v0.2.17` carries the Box parity fix and is the next source candidate;
`v0.2.14` remains the latest public production release.

| Surface | Evidence | What is still required |
| --- | --- | --- |
| Source | On the `v0.2.17` candidate, lint, 21 package checks, 5 builds, `verify:fast` (329 files; 2,776 tests) and full `verify` (341 files; 2,864 tests; Chromium 4/4; both disposable PostgreSQL migration chains) are green. Focused desktop Box tests prove omitted `environment` and the two-hour trial fallback. The process runner now reports the absolute timeout deterministically when both deadlines become runnable under load | Pass branch CI, then keep the eventual released commit and tag identical |
| Docker computer | The `docker-smoke` CI job builds `quibt/computer:local` on a Linux runner, boots a workspace container and starts a real graphical session. It caught a boot regression on this very tree before release | Runs on `workflow_dispatch` and nightly, not on every push |
| VPS | The `vps-compose-smoke` CI job installs the published Compose stack on an amd64 runner, applies every migration and waits for API/web readiness | It pulls the **published** images, so it validates a release, never an unreleased commit |
| Phone → clean VPS, end to end | On `v0.2.10`: `quibtbot install` on a clean Hetzner VPS chose a `sslip.io` name and obtained a Let's Encrypt certificate; a physical iPhone scanned the pairing QR, reached the server over that HTTPS, consumed the bootstrap invite and created the first owner (2026-08-25 18:36 UTC). The web preview host allowlist fix is in this image, so the phone passes the former 403 | Onboarding after sign-up (model → machine → first bot) on the phone is the next manual check |
| Public HTTPS (no domain) | On a clean Hetzner VPS (Ubuntu 24.04), `quibtbot install` chose `quibt-<id>.<ip>.sslip.io`, Caddy obtained a Let's Encrypt certificate in ~3 s (`issuer=Let's Encrypt`, verified from outside with no TLS exception), and Caddy→web→API answered `/rpc/health` 200. The host allowlist and resume-origin fixes are in the published stack | Repeat the provider-account canary on `v0.2.17` when the Hetzner credential is available |
| Desktop | **`v0.2.9` / `v0.2.10` / `v0.2.14`:** the Apple-silicon DMG is Developer ID signed, notarized and stapled. **`v0.2.16`:** the workflow draft is private and its CI Mac artifact is unsigned. **`v0.2.17`:** not tagged yet. Windows and Linux remain unsigned test builds. | Recreate the `quibt-notary` credential for team `9Q372SFRM8`, build and verify the notarized `v0.2.17` DMG, then update its signing status and checksums. Windows needs an Authenticode certificate. Intel Mac is not published. |
| Mobile | EAS iOS and Android production builds `0.1.2 (6)` finished. The iOS submission `3194620a-28f8-41c7-a483-47a49a41d8c4` finished uploading to App Store Connect. The iOS app was installed on physical iPhone `00008150-000825483C40401C`; launch was denied only because the phone was locked. Android Gradle duplicate checking passed after removing the obsolete Bouncy Castle dependency | Unlock and visibly launch the physical iPhone; verify TestFlight processing; provide a Quibt-owned Google Play service-account key for the internal-track submission |
| Publication | `v0.2.14` is public production. `v0.2.16` has public image tags and a private GitHub draft, but no public release. `v0.2.17` is only a source candidate | Do not publish or deploy the candidate site/OTA until the release manifest has real CLI hashes and the Mac notary gate passes |

## Required gates

| Gate | Evidence required | Current state |
| --- | --- | --- |
| Source quality | format, lint, TypeScript, `verify:fast`, full `verify` | Green locally on the source candidate: 21 package checks; 5 builds; fast 329 files / 2,776 tests; full 341 files / 2,864 tests; Chromium 4/4; both clean PostgreSQL migration chains applied. Branch CI remains the next gate. |
| Security | Standard repository scan; no unresolved critical finding | Scan is sealed; critical finding is fixed locally, while two documented high architectural limits remain |
| Supply chain | versioned CLI + checksums; packaged Docker images pinned by digest | `v0.2.16` draft CLI sidecars and tagged images were verified; `v0.2.17` has no artifacts yet and its embedded manifests remain fail-closed with zero digests |
| Desktop | macOS Apple-silicon DMG, Windows installer, Linux AppImage; signing status attached; `DESKTOP_SIGNING` matches the attached status | `v0.2.17` is not tagged; the Apple notary credential must be restored before public release. Windows and Linux are explicitly unsigned; Intel is not part of this release |
| VPS | install, migration, `/ready`, web `/rpc/health`, first-owner pairing, restart | Release smoke passed; a real provider/account canary remains useful evidence, not a blocker for self-host preview |
| Mobile | TypeScript/tests plus QR, code, thread, attachment, and computer control on a physical phone | Native iOS/Android builds are finished; production OTA and the visible unlocked-device journey remain pending |
| Publication | public repository, source tag equals artifact version, checksums and release notes | Keep `v0.2.16` private; tag `v0.2.17` only after source/CI review, then publish its reviewed assets and real manifest hashes before the production OTA |

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
