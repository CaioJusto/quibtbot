# Mobile system journey

`pnpm e2e:mobile` runs a deterministic, headless system journey for the mobile app. It is
**not** a device or emulator test: there is no Maestro, no Detox, no Expo Go, and no
iOS/Android simulator involved, because this environment and the CI Ubuntu runners have
neither. Instead, it drives the real client code in `apps/mobile/lib/*` (the same
functions the screens under `apps/mobile/app/*` call) against a real API app booted with
the scripted / fake emulator stack:

- `AGENT_RUNTIME=scripted` — the model runtime used by `packages/testkit/src/journeys.test.ts`.
- `SANDBOX_PROVIDER=fake` — `FakeSandboxProvider`, no Docker/E2B/Box/Daytona required.
- `WAKEUP_DRIVER=memory` — no Graphile/queue worker required.

## What it covers

`bootstrap-flow.yaml` is the journey spec. The harness (`bootstrap-flow.e2e.test.ts`)
reads it and runs one step per entry, in order:

1. **launch_clean_app** — no stored session, API base, or bootstrap enrollment token.
2. **configure_server** — reads the server host catalog and the copyable bootstrap
   command (`apps/mobile/lib/server-setup.ts`).
3. **enter_bootstrap_code** — claims a bootstrap code (`apps/mobile/lib/bootstrap-pairing.ts`).
4. **create_owner** — signs up the first account with the enrollment token from the claim.
5. **add_model** — connects the scripted model credential (`models/connect` + `models/setDefault`).
6. **probe_activate_machine** — probes and activates a machine from the catalog
   (`apps/mobile/lib/machine-settings.ts`).
7. **create_bot** — creates the first bot (`bots/create`).
8. **send_scripted_message** — sends a message and waits for the scripted run to finish.
9. **attach_file** — uploads a file and sends it into the thread
   (`apps/mobile/lib/attachments.ts`).

The harness asserts the executed steps match `bootstrap-flow.yaml` exactly, so the spec
and the run cannot silently drift apart.

## How the bootstrap code is injected

The harness — not any app code — mints the bootstrap code in test setup, by POSTing to
`/api/bootstrap/invites` with the `x-quibt-bootstrap-secret` header (the same private
mint endpoint the CLI installer uses locally). It then claims that code through
`claimInstallation()`, exactly like scanning the QR code or typing it on
`/pair-installation`. No production invite is hard-coded, and no app code branches on
being under test.

## Why machine activation resets itself

Real deployments cannot revert the machine picker to the process env default from the
UI — there is no catalog entry for "fake". So after step 6 proves `computers/probe` and
`computers/activate` work end-to-end, the harness resets `deploymentSettings` back to no
saved machine and invalidates the routing sandbox's cache, the same way
`packages/testkit/src/journeys.test.ts` resets deployment state between its own
scenarios. This keeps the rest of the journey on the deterministic fake computer.

## Running it

```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
pnpm e2e:mobile
```

The suite starts its own disposable PostgreSQL 16 container, applies all migrations, and
removes the container after the journey. It never reads or mutates the developer's
`DATABASE_URL` database. Docker Desktop, Colima, or Docker Engine must be available.

Equivalent to `pnpm --filter @quibt/mobile e2e`, which runs a dedicated Vitest config
(`e2e/vitest.config.mts`) so this system journey never runs as part of the fast unit suite
(`pnpm --filter @quibt/mobile test`, `pnpm verify:fast`).
