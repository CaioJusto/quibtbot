# Unified Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar `quibtbot install`, o manifesto image-only, o vínculo inicial por código e o bootstrap funcional do Electron.

**Architecture:** `@quibt/installer` contém a máquina de estados idempotente e adapters de processo/arquivos; `@quibt/cli` fornece o binário `quibtbot`; API e banco emitem o convite inicial; Electron consome o mesmo orquestrador. O compose de desenvolvimento permanece separado.

**Tech Stack:** TypeScript, Node.js 22.19, pnpm 9, Hono/oRPC, Prisma/PostgreSQL, Docker Compose, Electron, Vitest.

## Global Constraints

- O comando público é exatamente `quibtbot install`.
- Nenhum caminho de produção depende de checkout, Node ou pnpm no host após o binário ser instalado.
- Imagens e manifesto usam uma única versão fixada.
- Instalações são idempotentes e nunca substituem segredos ou volumes implicitamente.
- Convites iniciais duram dez minutos, têm uso único, no mínimo 40 bits e são armazenados somente como hash.
- Logs nunca incluem segredos, credenciais, código de pareamento ou token opaco.
- O caminho público é OSS: `QUIBT_EDITION=oss` e `BILLING_ENABLED=false`.

---

## File Map

- Create `packages/installer/`: estado, execução, env, manifesto e sanitização.
- Create `apps/cli/`: parser e comandos `install`, `status`, `doctor`, `pair`, `update`.
- Create `infra/compose/docker-compose.desktop.yml`: stack baseada em imagens.
- Modify `packages/contracts/src/rpc.ts`: contrato do vínculo inicial.
- Modify `packages/db/prisma/schema.prisma` and create one migration: bootstrap invitations/deployment claim.
- Modify `apps/api/src/router.ts` and auth bootstrap path: emissão e consumo.
- Modify `apps/desktop/src/stack.ts`, `main.ts`, `setup.html`, `package.json`: packaged runtime.
- Add focused tests beside every unit and a journey in `packages/testkit`.

### Task 1: Installer state machine and CLI entry point

**Files:**
- Create: `packages/installer/package.json`
- Create: `packages/installer/tsconfig.json`
- Create: `packages/installer/src/index.ts`
- Create: `packages/installer/src/state.ts`
- Create: `packages/installer/src/state.test.ts`
- Create: `packages/installer/src/redact.ts`
- Create: `packages/installer/src/redact.test.ts`
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/main.ts`
- Create: `apps/cli/src/main.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `InstallStep = "requirements" | "environment" | "images" | "services" | "database" | "health" | "pairing"`
  - `InstallState { version: 1; release: string; completed: InstallStep[]; updatedAt: string }`
  - `nextInstallStep(state): InstallStep | null`
  - `redactInstallerText(text, secrets): string`
  - executable bin name `quibtbot`

- [ ] **Step 1: Write failing state and redaction tests**

```ts
import { describe, expect, it } from "vitest";
import { nextInstallStep } from "./state.js";
import { redactInstallerText } from "./redact.js";

describe("installer state", () => {
  it("resumes at the first incomplete step", () => {
    expect(
      nextInstallStep({
        version: 1,
        release: "0.2.0",
        completed: ["requirements", "environment"],
        updatedAt: "2026-08-17T00:00:00.000Z",
      }),
    ).toBe("images");
  });

  it("redacts exact secrets and credential-shaped assignments", () => {
    expect(
      redactInstallerText(
        "TOKEN=visible\nssh password hunter2\nBETTER_AUTH_SECRET=abc",
        ["hunter2", "abc"],
      ),
    ).toBe("TOKEN=visible\nssh password [REDACTED]\nBETTER_AUTH_SECRET=[REDACTED]");
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm exec vitest run packages/installer/src/state.test.ts packages/installer/src/redact.test.ts`

Expected: FAIL because `state.ts` and `redact.ts` do not exist.

- [ ] **Step 3: Implement the ordered state machine and sanitizer**

```ts
export const INSTALL_STEPS = [
  "requirements",
  "environment",
  "images",
  "services",
  "database",
  "health",
  "pairing",
] as const;

export type InstallStep = (typeof INSTALL_STEPS)[number];

export interface InstallState {
  version: 1;
  release: string;
  completed: InstallStep[];
  updatedAt: string;
}

export function nextInstallStep(state: InstallState): InstallStep | null {
  return INSTALL_STEPS.find((step) => !state.completed.includes(step)) ?? null;
}
```

Implement `redactInstallerText` with escaped exact-secret replacement and assignment-name replacement for keys ending in `SECRET`, `TOKEN`, `PASSWORD`, `PRIVATE_KEY`, `API_KEY` or `PASSPHRASE`.

- [ ] **Step 4: Add CLI parser tests**

```ts
import { expect, it } from "vitest";
import { parseCli } from "./main.js";

it("uses install as the explicit public command", () => {
  expect(parseCli(["install"])).toEqual({ command: "install", nonInteractive: false });
  expect(parseCli(["install", "--non-interactive"])).toEqual({
    command: "install",
    nonInteractive: true,
  });
});
```

- [ ] **Step 5: Implement CLI dispatch**

`parseCli` must accept only `install`, `status`, `doctor`, `pair`, `update`, `--version` and `--help`; unknown commands exit `2`. `package.json` must expose:

```json
{
  "name": "@quibt/cli",
  "type": "module",
  "bin": { "quibtbot": "./dist/main.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run --root ../.. apps/cli packages/installer"
  },
  "dependencies": {
    "@quibt/installer": "workspace:*"
  }
}
```

- [ ] **Step 6: Verify GREEN**

Run: `pnpm exec vitest run packages/installer apps/cli && pnpm --filter @quibt/installer check && pnpm --filter @quibt/cli check`

Expected: all focused tests pass and both typechecks exit `0`.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml packages/installer apps/cli
git commit -m "feat: add quibtbot installer state machine"
```

### Task 2: Image-only manifest and idempotent environment

**Files:**
- Create: `infra/compose/docker-compose.desktop.yml`
- Create: `packages/installer/src/environment.ts`
- Create: `packages/installer/src/environment.test.ts`
- Create: `packages/installer/src/compose.ts`
- Create: `packages/installer/src/compose.test.ts`
- Modify: `packages/testkit/src/compose-config.test.ts`

**Interfaces:**
- Consumes: `InstallState`, fixed release string.
- Produces:
  - `ensureInstallEnvironment(dataDir, publicUrl): { path; created; values }`
  - `composeInvocation(mode, composeFile, envFile): string[]`

- [ ] **Step 1: Write failing idempotency tests**

The tests create a temporary directory, call `ensureInstallEnvironment` twice, and assert that `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SANDBOX_SUPERVISOR_TOKEN`, `BOOTSTRAP_SECRET` and `DATABASE_PASSWORD` are unchanged; mode is `0600`; `DATA_DIR` is absolute.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/installer/src/environment.test.ts`

Expected: FAIL because the environment module is missing.

- [ ] **Step 3: Implement environment generation**

Generate 32-byte hexadecimal secrets with `randomBytes`. Write atomically via a sibling temporary file followed by rename. Existing files are parsed and preserved; missing required keys are appended without changing existing values.

- [ ] **Step 4: Write failing manifest tests**

Assertions:

```ts
expect(manifest.services.postgres.image).toMatch(/^postgres:16@sha256:/);
expect(manifest.services.api.build).toBeUndefined();
expect(manifest.services.worker.build).toBeUndefined();
expect(manifest.services.web.build).toBeUndefined();
expect(manifest.services.supervisor.build).toBeUndefined();
expect(manifest.services.computer.build).toBeUndefined();
expect(allQuibtImages(manifest)).toEqual([
  `ghcr.io/quibt/quibt-stack:${release}`,
  `ghcr.io/quibt/quibt-supervisor:${release}`,
  `ghcr.io/quibt/quibt-computer:${release}`,
]);
```

- [ ] **Step 5: Implement image-only compose**

Use YAML interpolation `${QUIBT_STACK_VERSION:?}` and `${DATA_DIR:?}`. API, worker and web share `ghcr.io/quibt/quibt-stack:${QUIBT_STACK_VERSION}` with distinct commands. Containers consume `/run/quibt/quibt.env`; Postgres uses `DATABASE_PASSWORD`; supervisor is internal except its API-to-worker network; web/API expose configured ports.

- [ ] **Step 6: Implement compose command modes**

Packaged mode executes `docker compose ... pull` then `docker compose ... up -d --wait`; source mode keeps `up -d --build`. No packaged invocation contains `--build`.

- [ ] **Step 7: Verify GREEN and policy tests**

Run: `pnpm exec vitest run packages/installer packages/testkit/src/compose-config.test.ts`

Expected: tests pass with no build context in the desktop manifest.

- [ ] **Step 8: Commit**

```bash
git add infra/compose/docker-compose.desktop.yml packages/installer packages/testkit/src/compose-config.test.ts
git commit -m "feat: add image-only Quibt stack manifest"
```

### Task 3: Initial owner invitation

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260817020000_bootstrap_invites/migration.sql`
- Modify: `packages/contracts/src/rpc.ts`
- Create: `packages/core/src/bootstrap-invite.ts`
- Create: `packages/core/src/bootstrap-invite.test.ts`
- Modify: `apps/api/src/router.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/bootstrap-auth.test.ts`
- Modify: `packages/testkit/src/journeys.test.ts`

**Interfaces:**
- Produces:
  - `BootstrapInvite { id; codeHash; tokenHash; expiresAt; consumedAt; createdAt }`
  - `POST /api/bootstrap/invites` restricted to loopback + `X-Quibt-Bootstrap-Secret`
  - `POST /api/bootstrap/claim` accepting `{ code }`
  - claim output `{ enrollmentToken, expiresAt }`
  - first-owner signup accepts `X-Quibt-Enrollment`

- [ ] **Step 1: Write failing entropy/expiry tests**

Test `createBootstrapInvite(now, randomBytes)` returns an eight-character Crockford Base32 code, opaque token, SHA-256 hashes only, and expiry exactly ten minutes after `now`.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/core/src/bootstrap-invite.test.ts`

Expected: FAIL because helper is absent.

- [ ] **Step 3: Implement pure invite helpers**

Implement code generation from five random bytes, SHA-256 hashing, timing-safe comparison, expiry and one-time checks. The clear code/token exist only in the return value used for immediate response.

- [ ] **Step 4: Add schema and migration**

Add a singleton deployment claim record and invite table with unique hashes and indexed expiry. Migration must be additive and preserve all existing auth rows.

- [ ] **Step 5: Write failing API tests**

Cover:

1. remote request cannot mint an invite;
2. wrong bootstrap secret returns `401`;
3. valid local mint never returns bootstrap secret;
4. wrong code is rate-limited;
5. valid code yields enrollment token once;
6. replay fails;
7. first signup without enrollment fails while unclaimed;
8. enrollment creates deployment owner and marks claimed.

- [ ] **Step 6: Implement API flow**

Use existing rate-limit infrastructure. Store only hashes. Enrollment token must be scoped to `first-owner`, expire in ten minutes, and be consumed transactionally with owner creation.

- [ ] **Step 7: Add journey**

Extend `journeys.test.ts` with clean database → local invite → mobile claim → owner signup → authenticated `me`.

- [ ] **Step 8: Verify GREEN**

Run: `pnpm db:generate && pnpm exec vitest run packages/core/src/bootstrap-invite.test.ts apps/api/src/bootstrap-auth.test.ts`

Then with PostgreSQL: `pnpm exec vitest run --no-file-parallelism packages/testkit/src/journeys.test.ts`

Expected: all invitation and journey scenarios pass.

- [ ] **Step 9: Commit**

```bash
git add packages/db packages/contracts packages/core apps/api packages/testkit/src/journeys.test.ts
git commit -m "feat: add secure first-owner pairing"
```

### Task 4: Complete CLI install, status, doctor, pair and update

**Files:**
- Create: `packages/installer/src/orchestrator.ts`
- Create: `packages/installer/src/orchestrator.test.ts`
- Create: `packages/installer/src/doctor.ts`
- Create: `packages/installer/src/doctor.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/main.test.ts`

**Interfaces:**
- Consumes: environment, compose adapter, invitation endpoint.
- Produces: structured `InstallerEvent { step; status; message; detail? }`.

- [ ] **Step 1: Write failing resume test**

Inject a fake process runner. First run fails during images; second run begins at images, does not rewrite env, completes health and returns pairing output. Assert no event contains known secrets.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/installer/src/orchestrator.test.ts`

Expected: FAIL because orchestrator is missing.

- [ ] **Step 3: Implement orchestrator**

Each step writes state only after its postcondition passes. Requirements install Docker Engine only on supported Linux distributions; macOS/Windows return an actionable Docker Desktop instruction. Health polls `/ready` with bounded backoff.

- [ ] **Step 4: Implement commands**

- `status`: read state, `docker compose ps --format json`, probe health.
- `doctor`: Docker version, ports, filesystem permissions, manifest/version, service health.
- `pair`: mint initial invite only while unclaimed; otherwise print instruction to approve pairing from an authenticated client.
- `update`: create DB backup, pull target version, migrate, health-check, retain previous image tags for rollback.

- [ ] **Step 5: Verify**

Run: `pnpm exec vitest run packages/installer apps/cli && pnpm --filter @quibt/cli build`

Expected: tests pass and executable build exits `0`.

- [ ] **Step 6: Commit**

```bash
git add packages/installer apps/cli
git commit -m "feat: complete quibtbot installation commands"
```

### Task 5: Electron packaged stack runtime

**Files:**
- Modify: `apps/desktop/src/stack.test.ts`
- Modify: `apps/desktop/src/stack.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/setup.html`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: bundled `docker-compose.desktop.yml`, installer package.
- Produces `StackResolution` with `"source-build" | "packaged-images" | "remote"`.

- [ ] **Step 1: Replace the old packaged rejection test with RED packaged-mode tests**

Assert `resourcesPath/compose/docker-compose.desktop.yml` resolves to `packaged-images`; args contain `pull`/`up --wait` and never `--build`; env/data paths are under Electron `userData`.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/desktop/src/stack.test.ts`

Expected: FAIL because current `isBuildableCompose` rejects the package.

- [ ] **Step 3: Implement stack resolution**

Remove the packaged rejection from `main.ts`. Keep source compose for checkout, use bundled desktop compose in packaged mode, and call installer orchestration with progress events over IPC.

- [ ] **Step 4: Update setup UI**

Show explicit choices “Instalar neste computador” and “Conectar a outro servidor”; render step events; never auto-click installation; preserve retry state.

- [ ] **Step 5: Bundle the usable manifest**

`extraResources` copies `docker-compose.desktop.yml` to `compose/docker-compose.desktop.yml`. Include the stack version in app metadata.

- [ ] **Step 6: Verify**

Run: `pnpm exec vitest run apps/desktop/src && pnpm --filter @quibt/desktop check && pnpm --filter @quibt/desktop build`

Expected: all desktop tests pass and build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop infra/compose/docker-compose.desktop.yml
git commit -m "feat: bootstrap packaged desktop stack"
```

### Task 6: Desktop remote VPS and Box setup

**Files:**
- Create: `apps/desktop/src/remote-installer.ts`
- Create: `apps/desktop/src/remote-installer.test.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.cjs`
- Modify: `apps/desktop/setup.html`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces:
  - `inspectSshHost(input): Promise<{ algorithm; fingerprint }>`
  - `installOverVerifiedSsh(input, expectedFingerprint, onEvent)`
  - `installOnBox(input, onEvent)`

- [ ] **Step 1: Write failing host-verification tests**

Inject a fake SSH client and assert credentials are not passed before fingerprint inspection, a mismatch aborts, the exact expected fingerprint is supplied to `hostVerifier`, and event logs are sanitized.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/desktop/src/remote-installer.test.ts`

Expected: FAIL because the transport is absent.

- [ ] **Step 3: Add the latest maintained SSH dependency**

Run: `pnpm --filter @quibt/desktop add ssh2@latest` and add matching latest type declarations as a development dependency. Use only its `hostHash`/`hostVerifier` path; no permissive callback is allowed.

- [ ] **Step 4: Implement VPS transport**

Support password and private-key/passphrase authentication. Inspect host identity first, require user confirmation in `setup.html`, then download/checksum the CLI and execute `quibtbot install --non-interactive`.

- [ ] **Step 5: Implement Box transport**

Create/select a persistent Box server VM through the user’s API key, execute the same CLI, and return URL/bootstrap output. Keep the key in Electron secure credential storage and never send it to the Quibt API.

- [ ] **Step 6: Wire setup UI**

“Conectar a outro servidor” offers existing URL, guided VPS, SSH VPS and Box. Progress uses the same typed installer events as local setup.

- [ ] **Step 7: Verify**

Run: `pnpm exec vitest run apps/desktop/src/remote-installer.test.ts apps/desktop/src/stack.test.ts && pnpm --filter @quibt/desktop check && pnpm --filter @quibt/desktop build`

- [ ] **Step 8: Commit**

```bash
git add apps/desktop pnpm-lock.yaml
git commit -m "feat: configure remote Quibt servers from desktop"
```

### Task 7: Installer integration smoke

**Files:**
- Create: `packages/testkit/src/installer-smoke.test.ts`
- Create: `scripts/smoke-installer.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing smoke contract**

The test verifies release/version interpolation, generated env, command order, ready probe, rerun idempotency and sanitized failure logs using a fake Docker executable.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/testkit/src/installer-smoke.test.ts`

Expected: FAIL until the smoke harness is connected.

- [ ] **Step 3: Implement harness and root script**

Add `"verify:installer": "vitest run packages/testkit/src/installer-smoke.test.ts"` and `"smoke:installer": "node scripts/smoke-installer.mjs"`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm verify:installer && pnpm smoke:installer`

Expected: fake-process smoke passes; when Docker is available, the script also validates `docker compose config`.

- [ ] **Step 5: Commit**

```bash
git add packages/testkit/src/installer-smoke.test.ts scripts/smoke-installer.mjs package.json
git commit -m "test: add unified installer smoke coverage"
```
