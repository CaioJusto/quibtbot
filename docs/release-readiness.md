# Release readiness

This is the evidence ledger for an open-source Quibt Bot release. A green unit suite is not the
same as a signed installer, a successful VPS install, or a physical-device mobile test.

## Current audit evidence (2026-08-31, `v0.2.9` → `v0.2.18`)

`v0.2.15` stopped in the pre-publication fast suite because the unsigned Mac copy used the word
"notarizado". `v0.2.16` passed the complete release workflow and produced a private draft, but it
was deliberately not published: the desktop Box installer did not recognize a valid no-env response
when `environment` was omitted and did not retry trial accounts with a finite TTL. The Mac notary
profile is also unavailable. `v0.2.18` carries the Box parity fix and was published on 2026-08-31
as the latest public release; its desktop installers are unsigned and its DMG is not notarized, so
`v0.2.14` still carries the newest notarized Mac build.

| Surface | Evidence | What is still required |
| --- | --- | --- |
| Source | On the `v0.2.18` candidate, lint, 21 package checks and 5 builds are green. After the Box public-HTTPS fix, `verify:fast` passed 2,828 tests (93 skipped) and full `verify` passed 2,916 tests (5 skipped), Chromium 4/4 and both disposable PostgreSQL migration chains. The 37 focused Box/mobile/config tests also prove preservation/recovery and block the stale SaúdeSat submission identifiers. | Pass branch CI, then keep the eventual released commit and tag identical |
| Docker computer | The `docker-smoke` CI job builds `quibt/computer:local` on a Linux runner, boots a workspace container and starts a real graphical session. It caught a boot regression on this very tree before release | Runs on `workflow_dispatch` and nightly, not on every push |
| VPS | The `vps-compose-smoke` CI job installs the published Compose stack on an amd64 runner, applies every migration and waits for API/web readiness | It pulls the **published** images, so it validates a release, never an unreleased commit |
| Phone → clean VPS, end to end | On `v0.2.10`: `quibtbot install` on a clean Hetzner VPS chose a `sslip.io` name and obtained a Let's Encrypt certificate; a physical iPhone scanned the pairing QR, reached the server over that HTTPS, consumed the bootstrap invite and created the first owner (2026-08-25 18:36 UTC). The web preview host allowlist fix is in this image, so the phone passes the former 403 | Onboarding after sign-up (model → machine → first bot) on the phone is the next manual check |
| Public HTTPS (no domain) | On a clean Hetzner VPS (Ubuntu 24.04), `quibtbot install` chose `quibt-<id>.<ip>.sslip.io`, Caddy obtained a Let's Encrypt certificate in ~3 s (`issuer=Let's Encrypt`, verified from outside with no TLS exception), and Caddy→web→API answered `/rpc/health` 200. The host allowlist and resume-origin fixes are in the published stack | Repeat the provider-account canary on `v0.2.18` when the Hetzner credential is available |
| Phone → Box server | The physical iPhone installed the complete stack on an existing Box, but the returned `http://127.0.0.1:5173` could only work inside that Box and the first-owner action failed from the phone. The installer now preserves/reuses the allocated Box, binds only the web service externally, asks Box for its stable public HTTPS proxy, writes that origin into the stack, mints a fresh invite and refuses to finish until the public `/rpc/health` succeeds. Focused mobile/desktop/core/installer tests cover an existing install, a fresh install, a pending release manifest, malformed URLs, secret redaction and recovery without a second VM. | Install the fixed build on the unlocked physical iPhone, repeat **Instalar no Box**, create the first owner and send one real task. Do not delete the existing Box while doing this. |
| Desktop | **`v0.2.9` / `v0.2.10` / `v0.2.14`:** the Apple-silicon DMG is Developer ID signed, notarized and stapled. **`v0.2.16`:** the workflow draft is private and its CI Mac artifact is unsigned. **`v0.2.18`:** published with an unsigned, non-notarized CI DMG (`signing-status-mac.json` attached). Windows and Linux remain unsigned test builds. | Recreate the `quibt-notary` credential for team `9Q372SFRM8`, build and verify the notarized `v0.2.18` DMG, then replace the published artifact and update its signing status and checksums. Windows needs an Authenticode certificate. Intel Mac is not published. |
| Mobile | The earlier EAS upload is **not** valid Quibt release evidence: it targeted the SaúdeSat Apple organization. Source config now pins Apple team `9Q372SFRM8` (CAIO JUSTO), removes the stale App Store Connect app ID, and has a regression test rejecting both SaúdeSat identifiers. A local Release build for physical iPhone `00008150-000825483C40401C` succeeded with `Authority=Apple Development: Caio Justo`, `TeamIdentifier=9Q372SFRM8`, and the device present in the embedded profile. | The iPhone is currently unavailable to CoreDevice. Reconnect/unlock it, install and visibly replay the fixed Box journey. Before a new TestFlight submission, create/select the Quibt app inside organization CAIO JUSTO and put only that organization’s numeric App Store Connect ID back into the submit profile. Provide a Quibt-owned Google Play service-account key for Android submission. |
| Publication | `v0.2.18` is public production (published 2026-08-31) with CLI binaries, checksums and digest-pinned images from the same tag. `v0.2.16` has public image tags and a private GitHub draft, but no public release. | Replace the unsigned `v0.2.18` DMG with a notarized build; hold the production OTA until the visible physical-device journey passes |

## Required gates

| Gate | Evidence required | Current state |
| --- | --- | --- |
| Source quality | format, lint, TypeScript, `verify:fast`, full `verify` | Green locally on the source candidate: 21 package checks; 5 builds; fast 334 files passed / 13 skipped and 2,828 tests passed / 93 skipped; full 346 files passed / 1 skipped and 2,916 tests passed / 5 skipped; Chromium 4/4; both clean PostgreSQL migration chains applied. Branch CI remains the next gate. |
| Security | Standard repository scan; no unresolved critical finding | Scan is sealed; critical finding is fixed locally, while two documented high architectural limits remain |
| Supply chain | versioned CLI + checksums; packaged Docker images pinned by digest | `v0.2.18` published CLI binaries with SHA-256 sidecars, an aggregate `checksums-0.2.18.txt`, and multi-architecture images pinned by digest in the release notes |
| Desktop | macOS Apple-silicon DMG, Windows installer, Linux AppImage; signing status attached; `DESKTOP_SIGNING` matches the attached status | `v0.2.18` shipped all three installers with `signing-status-*.json` attached and every platform explicitly unsigned; the Apple notary credential must be restored to replace the DMG. Intel is not part of this release |
| VPS | install, migration, `/ready`, web `/rpc/health`, first-owner pairing, restart | Release smoke passed; a real provider/account canary remains useful evidence, not a blocker for self-host preview |
| Mobile | TypeScript/tests plus QR, code, thread, attachment, and computer control on a physical phone | Native iOS/Android builds are finished; production OTA and the visible unlocked-device journey remain pending |
| Publication | public repository, source tag equals artifact version, checksums and release notes | `v0.2.18` is tagged and public with checksums and release notes; keep `v0.2.16` private and hold the production OTA until the physical-device journey passes |

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
