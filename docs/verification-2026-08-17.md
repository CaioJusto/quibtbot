# Unified install flow — final verification (2026-08-17)

Branch `cursor/unified-install-flow-707a`, HEAD `dde7c10` (plus the two small same-branch
fixes described below). This is Release Task 6: a from-scratch run of every command in
the task brief, with exact pass/fail counts and no fabricated evidence for anything that
could not run.

## Environment

- Node `v22.19.0`, pnpm `9.15.0`, Ubuntu 24.04.4 LTS, x86_64.
- Postgres 16 at `127.0.0.1:5433` (this workspace's local cluster; CI uses 5432).
  `DATABASE_URL` from `.env`: `postgres://quibt:quibt@127.0.0.1:5433/quibt`.
- **Docker is not installed in this VM** (`docker`, `dockerd`, `/var/run/docker.sock` all
  absent). Every Docker-dependent step below is recorded as skipped, not faked.
- GitHub Actions CI could not be checked as a live baseline: the last several pushes to
  this branch (`gh run list --workflow ci.yml`) all failed in ~4s with "recent account
  payments have failed" — every job (`check`, `lint`, `verify-fast`, `e2e`,
  `migrations-and-journeys`, `desktop-pack`, `public-clients`, `docker-smoke`) was never
  started. This verification is therefore the only evidence available for this push.

## Step 1 — static and automated verification

| Command | Result |
| --- | --- |
| `pnpm lint` | **Fails**: 172 errors, 52 warnings, 5 infos across 643 files (see "Known pre-existing issues") |
| `pnpm check` | **Passes**: 21/21 workspace `check` tasks (after one same-branch fix, see below) |
| `pnpm build` | **Passes**: 5/5 build tasks (`@quibt/cli`, `@quibt/web`, `@quibt/desktop`, `@quibt/www`, and one cached) |
| `pnpm verify:fast` | **228/230 test files, 1608/1624 tests pass**, 11 failing tests in 2 files, 5 skipped (see "Known pre-existing issues") |
| `pnpm verify:installer` | **Passes**: 17/17 files, 95/95 tests |
| `pnpm --filter @quibt/mobile test` | **Passes**: 29/29 files, 235/235 tests |
| `pnpm --filter @quibt/mobile check` | **Passes** (tsc clean) |
| `pnpm --filter @quibt/www build` | **Passes**: 9 pages built |
| `pnpm --filter @quibt/desktop build` | **Passes**: `dist/main.js` (176.0kb) bundled |

Two of `pnpm check`'s failures were real TypeScript regressions introduced earlier on this
branch (by release-task commits `bed1f45` and `3a31a90`/`252a05c`), not pre-existing. Per
the brief's allowance for a tiny same-branch follow-up, both are fixed here instead of
just documented:

- `apps/cli/src/main.ts` — the `switch` had `case "help": case "version": return 0;` after
  two earlier `if` returns for the same literals, so `tsc` narrowed those out and flagged
  the cases as unreachable (TS2678). Removed the two dead cases
  (commit `5955938`).
- `packages/testkit/src/installer-smoke.harness.ts` — reached into
  `../../installer/src/*.js` directly, which violates testkit's `tsconfig.json` `rootDir`
  (TS6059), and typed its fake `fetch` too narrowly for `OrchestratorDeps["fetch"]`.
  Exported `apiReadyUrl` from `@quibt/installer`'s index, added `@quibt/installer` as a
  real workspace dependency of `@quibt/testkit`, and switched the harness to import the
  package instead of its internals (commit `0abbdc8`, plus a biome formatting pass in
  `dde7c10`). Re-verified: `pnpm exec vitest run packages/testkit/src/installer-smoke.test.ts`
  → 3/3 passed; full `pnpm verify:installer` → 95/95; full `pnpm check` → 21/21.

## Step 2 — stateful/system verification

| Command | Result |
| --- | --- |
| `pnpm db:migrate` | **Passes**: 26 migrations found, none pending |
| `pnpm exec vitest run --no-file-parallelism packages/testkit/src/journeys.test.ts packages/testkit/src/run-lease.pg.test.ts` | **Passes**: 22/22 tests, 2/2 files |
| `pnpm e2e` (Playwright, `apps/web`) | **1/4 tests pass** on the shared 2-worker run; see below |
| `AGENT_RUNTIME=scripted SANDBOX_PROVIDER=fake WAKEUP_DRIVER=memory pnpm e2e:mobile` | **Passes**: 1/1 test |
| `pnpm smoke:installer` | **Passes**: 3/3 tests; "docker compose config skipped (docker unavailable)" — the script's own honest degrade path, not something this task faked |

### `pnpm e2e` detail

Ran with the API/worker started the same way CI's `e2e` job does
(`AGENT_RUNTIME=scripted SANDBOX_PROVIDER=fake WAKEUP_DRIVER=graphile`, `pnpm --filter
@quibt/api start` / `@quibt/worker start`), then `pnpm --filter @quibt/web exec playwright
install chromium` (no browsers were pre-installed) and `pnpm e2e`.

- `golden.spec.ts > two users are isolated and a bot completes durable work` — **passes**,
  every run.
- `arquivos-smoke.spec.ts > arquivo sobe, volta e aparece no fio` — **fails under the
  default 2-worker run** ("sem bot": the onboarding flow didn't finish in time before the
  test read the bot list) but **passes in isolation** (`--retries=2`, 1 worker): a resource
  contention flake under parallel workers, not a correctness bug. Pre-existing (the file's
  last change, `00431b7`, predates this release's task base `dc9ea4f`).
- `golden.spec.ts > takeover, routine, plugins, and export are reachable` — **fails
  reliably**, including in isolation with 2 retries. Root cause found by inspecting the
  failure screenshot: the account-menu item the test expects
  (`getByRole('button', { name: /Ferramentas e skills/ })`) is now labelled **"Plugins"**
  in `apps/web/src/pages/AccountSheet.tsx`, a copy change the test was never updated for.
  Pre-existing (the spec's last change, `d836546`, predates `dc9ea4f`); **not fixed** here
  per the brief ("do not fix unrelated product bugs... prefer documenting").
- `golden.spec.ts > a bot group can be created and talked to` — did not run: the file uses
  `test.describe.configure({ mode: "serial" })`, so it is skipped after the prior test's
  failure.

## Step 3 — Docker smoke

**Skipped, not faked.** Docker is not installed in this VM (no `docker` binary, no
`dockerd`, no `/var/run/docker.sock`, and `infra/sandboxes/supervisor` explicitly reports
"cannot reach the Docker daemon" when started). Per the task brief, this is recorded as an
external limitation rather than worked around with invented image digests:

- `quibt/computer:local`, `ghcr.io/quibt/quibt-stack:*`, `ghcr.io/quibt/quibt-computer:*`,
  `ghcr.io/quibt/quibt-supervisor:*`, `postgres:16` — **not built / not pulled**, no digests
  to report.
- Image-only compose (`infra/compose/docker-compose.desktop.yml`), `/ready`, owner
  bootstrap, worker processing, and clean-restart-with-unchanged-data were **not
  exercised**.

## Step 4 — manual GUI walkthroughs

The API/worker/web dev servers were run with `AGENT_RUNTIME=scripted`,
`SANDBOX_PROVIDER=fake`, `WAKEUP_DRIVER=graphile` (same emulator profile as CI's `e2e`
job) because Docker and a real model key are both unavailable here. A pre-existing
`pnpm dev` stack (real `AGENT_RUNTIME=pi`/`SANDBOX_PROVIDER=docker`, left running from an
earlier session on this VM) was stopped first so these walkthroughs exercise a
known-working configuration instead of one that would just fail on Docker anyway.

This subagent session has no interactive computer-use tool available, so "manual" GUI
walkthroughs were done by scripting the real app with Playwright's `chromium`/`_electron`
launchers (headed, on the VM's existing X11 display `:1`) and recording the screen — the
same product, same real HTTP calls, same real Electron process, just driven by a short
script instead of a mouse.

- **Web: onboarding → machine settings → computer screen** — full pass. Signed up, walked
  the real onboarding (model step skipped, machine step "Manter o padrão", bot named
  "Chief"), landed in `/app`, opened the account menu → **Máquina** (shows the real
  Docker/VPS/E2B/Box picker copy), closed it, then opened the bot's **computador** panel
  (shows the desktop preview / "Assumir controle" / routine creation, panel state from the
  fake sandbox provider).
  <video src="/opt/cursor/artifacts/web_onboarding_machine_settings_computer_screen.mp4" controls></video>
- **Electron: clean first boot → install → Docker check** — partial, honestly bounded by
  two real findings, not faked:
  1. With no local stack reachable, the app correctly renders "Vamos ligar o Quibt Bot" /
     "O stack local não responde." — the genuine clean-boot state.
  2. Clicking **"Instalar neste computador"** does nothing: `apps/desktop/setup.html`
     never attaches a click listener to `#choose-local` (only `#choose-remote` has one —
     confirmed by grepping the file). This is a real, reproducible bug in the shipped
     wizard, pre-existing on this branch (`setup.html`'s relevant history, e.g. `a4b53a2`,
     predates `dc9ea4f`) and **not fixed** here per the brief's scope. To still exercise
     the install path this bug blocks, the script directly toggled the same DOM classes
     the button was supposed to toggle (documented inline in the throwaway test script,
     which was deleted afterward, not committed) and clicked the real **"Começar
     instalação"** button. `runInstall()` then correctly ran its own real Docker
     requirements check and failed with: *"Install Docker Engine for ubuntu using your
     package manager, enable the docker service, and ensure your user can run 'docker
     info'. Automatic install was not attempted."* — the expected, honest outcome given
     Docker is absent. The QR/ready screen past this point was not reached.
  <video src="/opt/cursor/artifacts/electron_clean_boot_install_docker_missing.mp4" controls></video>
- **Mobile: URL/code → owner → model → machine → bot → message** — **blocked, not
  attempted.** No Android SDK/emulator, no iOS simulator (Linux VM), and no physical
  device are available in this environment; `apps/mobile`'s own docs
  (`docs/mobile.md`) already note the SSH module needs an EAS/dev-client build, so even
  Expo Go could not stand in. This matches the brief's explicit guidance not to invent a
  mobile video.

## Known pre-existing issues (found, not fixed — out of this task's scope)

All items below predate this release's task base (`dc9ea4f`, the parent of task 1's
`1ac36b7`), confirmed with `git merge-base --is-ancestor <commit> dc9ea4f` for each cited
commit. None are caused by release tasks 1–5, so none were changed here.

1. **`pnpm lint`: 172 errors** (mostly `assist/source/organizeImports` and `format`, plus a
   few `noUnusedImports`/`noUnusedVariables`), spread across many files accumulated since
   before this release's tasks began (the merge-base with local `main`,
   `0b767129`, already has 9 lint errors on its own — this branch's longer, separate
   history of mobile/provider work added the rest). Too broad for a "tiny follow-up"; left
   as a known cleanup item.
2. **`apps/api/src/env.test.ts` — 3 failing tests** (`loads real secrets in production`,
   `accepts a configured Resend sender in production`, `allows a self-hosted production
   deployment to disable auth email`). `resolveBootstrapSecret` (added in `e88a1c0`, before
   `dc9ea4f`) now throws in production unless `BOOTSTRAP_SECRET` is set explicitly, but
   these three tests never set it and expect a derived fallback to work.
3. **`apps/api/src/router-takeover.test.ts` — 8 failing tests**, all
   `TypeError: prisma.desktopSession.findUnique is not a function`. The hand-written fake
   `prisma` in that test's `harness()` only implements `desktopSession.updateMany`/`update`;
   `onControlLeaseGranted` (wired into the router by `3d782a6`, before `dc9ea4f`) now also
   calls `desktopSession.findUnique`, which the fixture never mocked.
4. **Electron setup wizard: dead "Instalar neste computador" button** — see Step 4 above.
5. **`golden.spec.ts`'s "takeover" e2e test expects a stale account-menu label** — see Step
   2 detail above.

## Summary

- Static/automated: `check`, `build`, `verify:fast` (minus 2 pre-existing files),
  `verify:installer`, mobile `test`/`check`, `www build`, `desktop build` all pass.
  `lint` fails on pre-existing debt (172 errors), unrelated to this release's tasks.
- Stateful: migrations, journeys/run-lease, `e2e:mobile`, and `smoke:installer` all pass.
  Web `e2e` has one flaky-under-parallelism pass and one reliably-failing pre-existing test
  (stale copy expectation).
- Docker smoke: skipped honestly (Docker absent from this VM).
- GUI: web onboarding → machine settings → computer screen fully demonstrated on video;
  Electron demonstrated up to the real, correct "Docker missing" failure (found and
  documented a real dead-button bug along the way); mobile GUI blocked by missing
  device/emulator, documented rather than faked.
- Two real, same-branch TypeScript regressions were fixed (`5955938`, `0abbdc8`, plus the
  formatting follow-up `dde7c10`) so `pnpm check` is fully green; all other findings above
  are pre-existing and documented, not fixed, per the task's scope.
