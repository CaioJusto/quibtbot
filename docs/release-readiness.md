# Release readiness

This is the evidence ledger for an open-source Quibt Bot release. A green unit suite is not the
same as a signed installer, a successful VPS install, or a physical-device mobile test.

## Current audit evidence (2026-08-25, `v0.2.9`)

| Surface | Evidence | What is still required |
| --- | --- | --- |
| Source | `pnpm lint`, `pnpm check` (21 packages), `pnpm build`, `pnpm verify:fast`: 2.034 tests, 0 failures. Full `pnpm verify` (Postgres via Testcontainers + 4/4 Chromium journeys) green on this tree | Keep the released commit and the tag identical |
| Docker computer | The `docker-smoke` CI job builds `quibt/computer:local` on a Linux runner, boots a workspace container and starts a real graphical session. It caught a boot regression on this very tree before release | Runs on `workflow_dispatch` and nightly, not on every push |
| VPS | The `vps-compose-smoke` CI job installs the published Compose stack on an amd64 runner, applies every migration and waits for API/web readiness | It pulls the **published** images, so it validates a release, never an unreleased commit |
| Desktop | The Apple-silicon `v0.2.9` DMG is Developer ID signed, notarized and stapled: `spctl -a -t open` answers `accepted / source=Notarized Developer ID`, and `stapler validate` passes | Windows and Linux desktop packages are not published; Windows needs an Authenticode certificate. Notarization happens on the maintainer Mac, never in CI |
| Mobile | iOS builds and installs on device from this tree; SSH to a modern server works after libssh2 was upgraded to 1.11 (the shipped NMSSH pod only spoke `ssh-rsa`/`ssh-dss`, which OpenSSH 8.8+ refuses) | The visible QR/thread/attachment/computer journey on a physical phone is still a manual check |
| Publication | The repository is public with a single initial commit. Container images are public and multi-architecture; release artifacts and their SHA-256 files are attached to the tag | Older history lives only in the maintainer's private archive |

## Required gates

| Gate | Evidence required | Current state |
| --- | --- | --- |
| Source quality | format, lint, TypeScript, `verify:fast`, full `verify` | Green on the final tree: 275 test files plus 4/4 browser journeys |
| Security | Standard repository scan; no unresolved critical finding | Scan is sealed; critical finding is fixed locally, while two documented high architectural limits remain |
| Supply chain | versioned CLI + checksums; packaged Docker images pinned by digest | CLI sidecars verified; tagged image, CLI, Windows, Linux, and VPS jobs passed before the account-level Actions billing hold |
| Desktop | macOS Apple-silicon DMG, Windows installer, Linux AppImage; signing status attached | Mac is signed/notarized; Windows is explicitly unsigned; Intel is not part of this release |
| VPS | install, migration, `/ready`, web `/rpc/health`, first-owner pairing, restart | Release smoke passed; a real provider/account canary remains useful evidence, not a blocker for self-host preview |
| Mobile | TypeScript/tests plus QR, code, thread, attachment, and computer control on a physical phone | Production OTA is published; visible physical-device journey remains blocking for a device-level claim |
| Publication | public repository, source tag equals artifact version, checksums and release notes | Assets can be published now; repository visibility is still private |

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
