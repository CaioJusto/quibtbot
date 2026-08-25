# Provider Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar Docker/remote-supervisor workspace-scoped e E2B/Box estritamente per-bot em todos os caminhos de boot, idle e destroy.

**Architecture:** Um único módulo define escopo e persistência de `providerRef`; boot/API/worker consomem esses helpers. Uma migração idempotente move referências Box legadas para `DesktopSession` sem destruir recursos.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Vitest, adapters de sandbox.

## Global Constraints

- Somente `docker` e `remote-supervisor` compartilham máquina por workspace.
- `e2b` e `box` usam uma sandbox/VM por bot.
- `Computer.providerRef` é canônico somente para providers compartilhados.
- `DesktopSession.providerRef` é canônico para providers per-bot.
- Migração não chama APIs externas nem destrói VMs.
- Todo bug corrigido deve primeiro ser reproduzido por teste falhando.

---

## File Map

- Modify `packages/adapters/src/workspace-computer.ts`: helpers canônicos.
- Modify boot paths in `computer-boot.ts`, `executor.ts`, and `apps/api/src/router.ts`.
- Modify `computer-idle.ts` and `child-bots.ts`: correct stop/destroy reference.
- Modify Box emulator/conformance tests.
- Add one Prisma migration and migration fixture test.
- Update misleading runtime comments.

### Task 1: Canonical provider scope helpers

**Files:**
- Modify: `packages/adapters/src/workspace-computer.test.ts`
- Modify: `packages/adapters/src/workspace-computer.ts`

**Interfaces:**
- Produces:
  - `isWorkspaceScopedSandbox(kind): boolean`
  - `isPerBotSandbox(kind): boolean`
  - `providerRefsFor(kind, providerRef): { computerProviderRef: string | null; desktopProviderRef: string }`
  - `workspaceProviderRef(desktop): string | undefined`

- [ ] **Step 1: Rewrite tests to express product semantics**

```ts
it.each(["docker", "remote-supervisor"])("%s is workspace-scoped", (kind) => {
  expect(isWorkspaceScopedSandbox(kind)).toBe(true);
});

it.each(["e2b", "box"])("%s is per-bot", (kind) => {
  expect(isWorkspaceScopedSandbox(kind)).toBe(false);
  expect(isPerBotSandbox(kind)).toBe(true);
});

it("ignores a legacy computer ref for Box", () => {
  expect(
    workspaceProviderRef({
      providerRef: "box-for-this-bot",
      computer: { kind: "box", providerRef: "legacy-shared-box" },
    }),
  ).toBe("box-for-this-bot");
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/adapters/src/workspace-computer.test.ts`

Expected: Box assertions fail because current helper includes Box in workspace scope.

- [ ] **Step 3: Implement canonical helpers**

`isWorkspaceScopedSandbox` returns true only for Docker family. `providerRefsFor` sets both refs for shared providers and only desktop ref for per-bot providers. Unknown providers default to per-bot safety.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run packages/adapters/src/workspace-computer.test.ts`

Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/workspace-computer.ts packages/adapters/src/workspace-computer.test.ts
git commit -m "fix: define Box as a per-bot provider"
```

### Task 2: Unify provider reference persistence

**Files:**
- Modify: `packages/adapters/src/computer-boot.ts`
- Modify: `packages/adapters/src/executor.ts`
- Modify: `apps/api/src/router.ts`
- Create: `packages/adapters/src/provider-ref-persistence.test.ts`

**Interfaces:**
- Consumes: `providerRefsFor`.
- Produces identical persistence for worker boot, warm boot and API boot.

- [ ] **Step 1: Write failing cross-path tests**

Build table-driven fixtures for Docker and Box. For every path assert:

```ts
expect(saved.box).toEqual({
  computerProviderRef: null,
  desktopProviderRef: "box-bot-a",
});
expect(saved.docker).toEqual({
  computerProviderRef: "container-workspace",
  desktopProviderRef: "container-workspace",
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/adapters/src/provider-ref-persistence.test.ts`

Expected: warm/API Box cases disagree.

- [ ] **Step 3: Replace ad-hoc conditionals**

Every successful provision computes `const refs = providerRefsFor(ref.kind, ref.providerRef)`. Persist `refs.computerProviderRef` on `Computer` and `refs.desktopProviderRef` on the bot session in the same transaction.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run packages/adapters/src/provider-ref-persistence.test.ts packages/adapters/src/computer-boot.test.ts`

Expected: all paths agree.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/computer-boot.ts packages/adapters/src/executor.ts apps/api/src/router.ts packages/adapters/src/provider-ref-persistence.test.ts
git commit -m "fix: unify sandbox reference persistence"
```

### Task 3: Correct idle and bot deletion behavior

**Files:**
- Modify: `packages/adapters/src/computer-idle.test.ts`
- Modify: `packages/adapters/src/computer-idle.ts`
- Modify: `packages/adapters/src/child-bots.test.ts`
- Modify: `packages/adapters/src/child-bots.ts`

- [ ] **Step 1: Add failing multi-bot idle tests**

Cases:

- Box bot A idle with bot B running: `stop` receives only `box-a`.
- Docker bot A idle with bot B running: supervisor session stop is allowed, but shared `destroy` is not called.
- User holding control: no stop.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/adapters/src/computer-idle.test.ts`

Expected: Box uses the legacy computer ref in the current implementation.

- [ ] **Step 3: Implement stop reference selection**

Use canonical session ref for per-bot providers. For shared providers, pass workspace ref and bot ID so supervisor stops only that graphical session. Preserve user-control guard.

- [ ] **Step 4: Add failing deletion tests**

Deleting Box bot A must call `destroy` with `box-a`; Box bot B remains unchanged. Deleting Docker bot A passes the shared ref and relies on supervisor live-session guard.

- [ ] **Step 5: Implement deletion**

Resolve per-bot references only from the target desktop session. Never fall back to `Computer.providerRef` for Box/E2B.

- [ ] **Step 6: Verify**

Run: `pnpm exec vitest run packages/adapters/src/computer-idle.test.ts packages/adapters/src/child-bots.test.ts`

Expected: all cases pass.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/computer-idle.ts packages/adapters/src/computer-idle.test.ts packages/adapters/src/child-bots.ts packages/adapters/src/child-bots.test.ts
git commit -m "fix: isolate provider stop and destroy operations"
```

### Task 4: Make Box emulator and conformance per-bot

**Files:**
- Modify: `packages/adapters/src/fake-sandbox.ts`
- Modify: `packages/adapters/src/managed-sandbox-emulator.ts`
- Modify: `packages/adapters/src/sandbox-conformance.test.ts`
- Modify: `packages/adapters/src/box-sandbox.test.ts`

**Interfaces:**
- Produces a per-bot fake provider where `providerRef = fake-${workspaceId}-${botId}`.

- [ ] **Step 1: Add failing conformance test**

Provision two Box bots in one workspace and assert distinct refs, isolated files and stopping A leaves B running.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/adapters/src/sandbox-conformance.test.ts`

Expected: current Box emulator returns a shared workspace reference.

- [ ] **Step 3: Implement emulator mode**

Add explicit `{ scope: "workspace" | "bot" }` configuration. Docker tests instantiate workspace mode; Box/E2B emulators instantiate bot mode.

- [ ] **Step 4: Add Box adapter assertion**

Two HTTP-backed `provision` calls without a provider ref must issue two `POST /boxes` calls and return different IDs.

- [ ] **Step 5: Verify**

Run: `pnpm exec vitest run packages/adapters/src/sandbox-conformance.test.ts packages/adapters/src/box-sandbox.test.ts`

Expected: per-bot isolation passes.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/fake-sandbox.ts packages/adapters/src/managed-sandbox-emulator.ts packages/adapters/src/sandbox-conformance.test.ts packages/adapters/src/box-sandbox.test.ts
git commit -m "test: model Box isolation per bot"
```

### Task 5: Migrate legacy Box references

**Files:**
- Create: `packages/db/prisma/migrations/20260817030000_box_refs_per_bot/migration.sql`
- Create: `packages/testkit/src/box-ref-migration.pg.test.ts`
- Modify: `infra/compose/start-prod.sh`

- [ ] **Step 1: Write failing PostgreSQL migration fixture**

Seed:

- one Box `Computer.providerRef = "legacy-box"`;
- two desktop sessions, one null and one `"box-b"`;
- one Docker computer.

After migration assert Box computer ref is null, missing session gets `"legacy-box"`, existing `"box-b"` is preserved, Docker is unchanged.

- [ ] **Step 2: Verify RED**

Run against test Postgres: `pnpm exec vitest run packages/testkit/src/box-ref-migration.pg.test.ts`

Expected: FAIL because migration is absent.

- [ ] **Step 3: Add idempotent SQL**

Use `UPDATE ... FROM` to fill only null Box session refs, then clear Box/E2B computer refs. Do not create/delete rows or call external providers.

- [ ] **Step 4: Correct runtime comment**

`start-prod.sh` must state Box is one VM per bot, not one VM per workspace.

- [ ] **Step 5: Verify migration twice**

Run: `pnpm db:migrate && pnpm exec vitest run packages/testkit/src/box-ref-migration.pg.test.ts`

Apply migration test twice and confirm the second run leaves identical state.

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/migrations packages/testkit/src/box-ref-migration.pg.test.ts infra/compose/start-prod.sh
git commit -m "fix: migrate Box references to per-bot sessions"
```
