# Mobile Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar no mobile o bootstrap de servidor, vínculo inicial, onboarding completo e paridade operacional essencial com o web.

**Architecture:** Telas pré-API usam catálogo estático de `@quibt/core`; transports remotos implementam uma interface fail-closed; segredos usam SecureStore; após o vínculo, o app usa os contratos RPC existentes. Lógica pura compartilhada sai das telas e recebe testes unitários.

**Tech Stack:** Expo 57, React Native 0.86, Expo Router, SecureStore, módulo SSH nativo verificado, TypeScript, Vitest.

## Global Constraints

- Fluxo padrão é guia manual; SSH é opção avançada.
- SSH aceita senha ou chave privada com passphrase.
- Nenhuma conexão SSH ocorre sem confirmação/verificação de fingerprint.
- Credenciais ficam somente no SecureStore, protegidas por autenticação do aparelho.
- E2B nunca é oferecido como host do servidor.
- Ordem OSS: modelo → computador dos bots → primeiro bot, após o servidor estar conectado.
- Catálogo de máquina, probe e ativação têm o mesmo contrato no web e mobile.
- Cores, raios e tipografia usam tokens existentes.

---

## File Map

- Add routes `setup-server`, `setup-ssh`, `pair-installation`, `machine-settings`.
- Add pure modules `server-setup`, `infrastructure-secrets`, `remote-installer`, `bootstrap-pairing`.
- Extend model source for OpenRouter/local.
- Extend onboarding with model and full machine catalog/probe.
- Add conversation actions, attachments and bot data settings.
- Add mobile system journey.

### Task 1: Server-first welcome and guided setup

**Files:**
- Create: `apps/mobile/lib/server-setup.ts`
- Create: `apps/mobile/lib/server-setup.test.ts`
- Modify: `apps/mobile/app/welcome.tsx`
- Create: `apps/mobile/app/setup-server.tsx`
- Modify: `apps/mobile/app/_layout.tsx`

**Interfaces:**
- Produces:
  - `ServerHostKind = "local" | "vps" | "box"`
  - `serverHostOptions(): ServerHostOption[]`
  - `bootstrapCommand(platform): string`

- [ ] **Step 1: Write failing option tests**

```ts
it("offers local, VPS and Box but never E2B as a server host", () => {
  expect(serverHostOptions().map((item) => item.kind)).toEqual(["local", "vps", "box"]);
});

it("uses the canonical CLI command", () => {
  expect(bootstrapCommand("linux")).toContain("quibtbot install");
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/mobile/lib/server-setup.test.ts`

Expected: FAIL because module is absent.

- [ ] **Step 3: Implement pure setup catalog**

Return non-technical copy, prerequisites, cost ownership, provider links and bootstrap commands. Reuse machine-guide vocabulary but keep server-host choices distinct from bot computer choices.

- [ ] **Step 4: Update welcome flow**

Primary actions:

- “Conectar a um Quibt existente” → scan/server;
- “Configurar um novo Quibt” → setup-server.

Do not show sign-up until a reachable API or valid bootstrap claim exists.

- [ ] **Step 5: Implement guided screen**

VPS shows copyable command and numbered provider-console steps. Box shows key/account instructions and advanced direct setup action. Local explains that a computer must remain on.

- [ ] **Step 6: Verify**

Run: `pnpm exec vitest run apps/mobile/lib/server-setup.test.ts apps/mobile/lib/onboarding-screen.test.ts && pnpm --filter @quibt/mobile check`

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/welcome.tsx apps/mobile/app/setup-server.tsx apps/mobile/app/_layout.tsx apps/mobile/lib/server-setup.ts apps/mobile/lib/server-setup.test.ts
git commit -m "feat: add mobile server setup flow"
```

### Task 2: Secure infrastructure credentials

**Files:**
- Create: `apps/mobile/lib/infrastructure-secrets.ts`
- Create: `apps/mobile/lib/infrastructure-secrets.test.ts`
- Modify: `apps/mobile/app/account.tsx`
- Modify: `apps/mobile/app.json`

**Interfaces:**
- Produces:
  - `InfrastructureCredential` discriminated union for password, private key and Box API key.
  - `saveInfrastructureCredential(hostId, credential)`
  - `loadInfrastructureCredential(hostId)`
  - `forgetInfrastructureCredential(hostId)`

- [ ] **Step 1: Write failing storage tests**

Inject a fake SecureStore and assert serialized secrets use a key derived from SHA-256 of normalized host, set `requireAuthentication: true`, never return credentials in list metadata, and deletion removes the entry.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/mobile/lib/infrastructure-secrets.test.ts`

- [ ] **Step 3: Implement secure repository**

Do not use AsyncStorage or route params. Configure Face ID usage text and exclude Android backup. If SecureStore invalidates a key, return `{ state: "reauth-required" }`, delete unreadable ciphertext and ask for credentials again.

- [ ] **Step 4: Add account management UI**

Show host label, authentication type and last-used date only. “Esquecer” requires native destructive confirmation.

- [ ] **Step 5: Verify**

Run: `pnpm exec vitest run apps/mobile/lib/infrastructure-secrets.test.ts && pnpm --filter @quibt/mobile check`

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/infrastructure-secrets.ts apps/mobile/lib/infrastructure-secrets.test.ts apps/mobile/app/account.tsx apps/mobile/app.json
git commit -m "feat: secure mobile infrastructure credentials"
```

### Task 3: Verified SSH and Box remote installer

**Files:**
- Create: `apps/mobile/lib/remote-installer.ts`
- Create: `apps/mobile/lib/remote-installer.test.ts`
- Create: `apps/mobile/lib/ssh-transport.native.ts`
- Create: `apps/mobile/lib/ssh-transport.web.ts`
- Create: `apps/mobile/lib/box-install-transport.ts`
- Create: `apps/mobile/app/setup-ssh.tsx`
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Add: pnpm native patch for host-key verification if the selected latest library lacks it.

**Interfaces:**
- Produces:

```ts
export interface RemoteInstallTransport {
  inspectIdentity(): Promise<{ algorithm: string; fingerprint: string }>;
  connect(expectedFingerprint: string): Promise<void>;
  runInstall(onEvent: (event: InstallerEvent) => void): Promise<InstallResult>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write failing fail-closed tests**

Assert missing expected fingerprint prevents credential retrieval and connection; mismatch closes transport; progress sanitizer removes known secrets; successful run extracts URL and bootstrap code only from typed final event.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/mobile/lib/remote-installer.test.ts`

- [ ] **Step 3: Add latest SSH dependency through pnpm**

Run: `pnpm --filter @quibt/mobile add @dylankenneally/react-native-ssh-sftp@latest`

Inspect installed API. Because upstream does not verify host keys, patch Android/iOS native layers to expose fingerprint inspection and verified connect. Register the patch in root `pnpm.patchedDependencies`.

- [ ] **Step 4: Implement SSH adapter**

Fingerprint screen appears before password/private-key retrieval. User must confirm a fingerprint obtained from provider console. `connect` passes the exact expected fingerprint to native code; no permissive fallback exists.

- [ ] **Step 5: Implement Box adapter**

Use the current Box API contract to create/select a persistent no-env VM, wait for ready, execute bootstrap, and stream progress. API key is read from secure repository only for each request.

- [ ] **Step 6: Build setup screen**

Fields: host, port, user, password/key mode, key/passphrase, expected fingerprint, save credential toggle. Show stages and resumable error actions.

- [ ] **Step 7: Verify**

Run:

```bash
pnpm exec vitest run apps/mobile/lib/remote-installer.test.ts
pnpm --filter @quibt/mobile check
pnpm --filter @quibt/mobile exec expo export --platform android
```

Expected: tests/typecheck/export pass; native module never exposes permissive connect.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile pnpm-lock.yaml package.json patches
git commit -m "feat: install Quibt remotely from mobile"
```

### Task 4: Bootstrap pairing and owner enrollment

**Files:**
- Create: `apps/mobile/lib/bootstrap-pairing.ts`
- Create: `apps/mobile/lib/bootstrap-pairing.test.ts`
- Create: `apps/mobile/app/pair-installation.tsx`
- Modify: `apps/mobile/app/scan.tsx`
- Modify: `apps/mobile/app/sign-up.tsx`
- Modify: `apps/mobile/app/_layout.tsx`

**Interfaces:**
- Consumes API from unified installer Task 3.
- Produces `claimInstallation(apiBase, code)` and enrollment-aware sign-up.

- [ ] **Step 1: Write failing claim tests**

Cover URL normalization, Crockford code normalization, enrollment token kept only in SecureStore, expired/replayed errors, and successful redirect to sign-up.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/mobile/lib/bootstrap-pairing.test.ts`

- [ ] **Step 3: Implement claim**

Call public bootstrap claim endpoint, save API base, store enrollment token separately from session token, and clear it immediately after successful or terminally failed sign-up.

- [ ] **Step 4: Extend QR handling**

Recognize `quibt://bootstrap?api=...&token=...` separately from authenticated `quibt://connect`. Bootstrap QR never grants a normal session directly.

- [ ] **Step 5: Verify**

Run: `pnpm exec vitest run apps/mobile/lib/bootstrap-pairing.test.ts apps/mobile/lib/api.test.ts apps/mobile/lib/session.test.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/bootstrap-pairing.ts apps/mobile/lib/bootstrap-pairing.test.ts apps/mobile/app/pair-installation.tsx apps/mobile/app/scan.tsx apps/mobile/app/sign-up.tsx apps/mobile/app/_layout.tsx
git commit -m "feat: claim new Quibt installs from mobile"
```

### Task 5: Model and machine parity

**Files:**
- Modify: `apps/mobile/lib/onboarding-flow.test.ts`
- Modify: `apps/mobile/lib/onboarding-flow.ts`
- Modify: `apps/mobile/app/onboarding.tsx`
- Modify: `apps/mobile/lib/model-source.tsx`
- Create: `apps/mobile/app/machine-settings.tsx`
- Create: `apps/mobile/lib/machine-settings.test.ts`
- Modify: `apps/mobile/app/account.tsx`
- Modify: `apps/mobile/app/_layout.tsx`
- Move shared pure helpers to `packages/core/src/client-onboarding.ts`
- Add: `packages/core/src/client-onboarding.test.ts`

- [ ] **Step 1: Write failing onboarding-order tests**

OSS owner must resolve to `["model", "machine", "bot"]`; non-owner to `["model", "bot"]`. Recipes remain in the catalog.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/mobile/lib/onboarding-flow.test.ts`

- [ ] **Step 3: Extract shared helpers**

Move mode/provider selection, credential readiness and next-step resolution from web/mobile to `@quibt/core`; both clients import the same implementation.

- [ ] **Step 4: Implement model step and account editing**

Support OpenRouter key, Ollama/LM Studio URL, device-code subscriptions and skip. Extend `ModelSourceSection` so all options remain available after onboarding.

- [ ] **Step 5: Require machine probe**

`saveMachine` calls `computers/probe`; activate only when `ok`. Render recipe cards and full machine guide. Add post-onboarding route with the same behavior.

- [ ] **Step 6: Verify**

Run:

```bash
pnpm exec vitest run packages/core/src/client-onboarding.test.ts apps/mobile/lib/onboarding-flow.test.ts apps/mobile/lib/machine-settings.test.ts
pnpm --filter @quibt/mobile check
pnpm --filter @quibt/web check
```

- [ ] **Step 7: Commit**

```bash
git add packages/core apps/mobile apps/web
git commit -m "feat: complete mobile model and machine setup"
```

### Task 6: Conversation attachments and actions

**Files:**
- Modify: `apps/mobile/app/thread.tsx`
- Create: `apps/mobile/lib/attachments.ts`
- Create: `apps/mobile/lib/attachments.test.ts`
- Modify: `apps/mobile/lib/chat.ts`
- Modify: `apps/mobile/lib/chat.test.ts`
- Modify: `apps/mobile/lib/mentions.ts`
- Modify: `apps/mobile/lib/mentions.test.ts`

- [ ] **Step 1: Write failing attachment upload tests**

Assert image/document picker result becomes multipart upload to `/files/:botId`, preserves filename/MIME/size, and `threads/send` receives returned attachment refs. Abort and non-2xx errors are surfaced.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/mobile/lib/attachments.test.ts`

- [ ] **Step 3: Implement upload and composer UI**

Use existing server endpoint and Expo image/document picker. Render outgoing and historical attachment cards; open downloads through platform APIs.

- [ ] **Step 4: Add action tests**

Cover RPC payloads for reply/citation, reaction, edit and branch switch. Add slash command parsing alongside mentions.

- [ ] **Step 5: Implement long-press action sheet**

Actions are capability-driven by message state; optimistic updates roll back on failure.

- [ ] **Step 6: Verify**

Run: `pnpm exec vitest run apps/mobile/lib/attachments.test.ts apps/mobile/lib/chat.test.ts apps/mobile/lib/mentions.test.ts && pnpm --filter @quibt/mobile check`

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/thread.tsx apps/mobile/lib
git commit -m "feat: add mobile conversation attachments and actions"
```

### Task 7: Bot memory, duplicate, export and voice

**Files:**
- Modify: `apps/mobile/app/settings.tsx`
- Create: `apps/mobile/lib/bot-tools.ts`
- Create: `apps/mobile/lib/bot-tools.test.ts`
- Create: `apps/mobile/lib/voice.ts`
- Create: `apps/mobile/lib/voice.test.ts`
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing bot-tool contract tests**

Cover memory list/save, duplicate result navigation, export file naming/share, and permission-denied voice state.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/mobile/lib/bot-tools.test.ts apps/mobile/lib/voice.test.ts`

- [ ] **Step 3: Implement memory and bot actions**

Use existing `memory.*`, `bots.duplicate` and `export.bot` RPCs. Save export to app cache and open native share sheet.

- [ ] **Step 4: Add latest Expo audio/document dependencies**

Use pnpm/Expo install so versions match SDK 57. Record audio only after explicit permission; upload through existing voice/transcription endpoint; show server-not-configured state.

- [ ] **Step 5: Verify**

Run: `pnpm exec vitest run apps/mobile/lib/bot-tools.test.ts apps/mobile/lib/voice.test.ts && pnpm --filter @quibt/mobile check`

- [ ] **Step 6: Commit**

```bash
git add apps/mobile package.json pnpm-lock.yaml
git commit -m "feat: complete mobile bot tools"
```

### Task 8: Mobile system journey

**Files:**
- Create: `apps/mobile/e2e/bootstrap-flow.yaml`
- Create: `apps/mobile/e2e/README.md`
- Modify: `apps/mobile/package.json`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the failing journey**

Journey: launch clean app → configure server → enter bootstrap code → create owner → add model → probe/activate machine → create bot → send scripted message → attach file.

- [ ] **Step 2: Run and capture the initial failure**

Run: `pnpm e2e:mobile`

Expected: FAIL before harness/device configuration is wired.

- [ ] **Step 3: Implement deterministic harness**

Use the project’s scripted model/fake sandbox stack and inject bootstrap code through test setup, not hard-coded app behavior. Keep all production paths unchanged.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @quibt/mobile test
pnpm --filter @quibt/mobile check
pnpm e2e:mobile
```

Expected: unit suite, typecheck and system journey pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/e2e apps/mobile/package.json package.json .github/workflows/ci.yml
git commit -m "test: cover mobile bootstrap journey"
```
