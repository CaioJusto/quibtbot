# Public Release and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alinhar site, documentação, CI e releases ao produto OSS instalável por `quibtbot install`.

**Architecture:** O site importa uma única configuração versionada de downloads; CI valida cada superfície explicitamente; workflow de release constrói imagens, CLI e instaladores em matriz, gera checksums e publica somente após smoke.

**Tech Stack:** Astro, GitHub Actions, Docker Buildx, Electron Builder, pnpm, Vitest.

## Global Constraints

- O caminho público não contém waitlist, hospedagem Quibt ou CTA Cloud.
- CTA principal é download/instalação OSS.
- README, site e artefatos usam a mesma versão.
- Release não é marcada como validada se assinatura/notarização externa estiver ausente.
- Docs explicam separadamente servidor Quibt e computador dos bots.
- CI deve validar build mobile e Astro explicitamente.

---

## File Map

- Modify `apps/www` landing/header/site tests and remove public waitlist links.
- Add release metadata/checksum script.
- Add GitHub release workflow and strengthen CI.
- Create `docs/architecture.md` and `docs/mobile.md`.
- Update all onboarding/computer/self-host/desktop docs and canonical copy.

### Task 1: Public OSS landing

**Files:**
- Modify: `apps/www/src/site.ts`
- Modify: `apps/www/src/site.test.ts`
- Modify: `apps/www/src/components/LandingPage.astro`
- Modify: `apps/www/src/components/Header.astro`
- Modify: `apps/www/src/i18n.ts`
- Modify: `apps/www/src/styles/global.css`

- [ ] **Step 1: Replace waitlist assertions with failing OSS assertions**

```ts
it("exposes the open-source install path", () => {
  expect(publicSurface).toContain("quibtbot install");
  expect(publicSurface).toContain(MAC_DOWNLOAD_URL);
  expect(publicSurface).toContain(WIN_DOWNLOAD_URL);
  expect(publicSurface).toContain(LINUX_DOWNLOAD_URL);
  expect(publicSurface).not.toMatch(/waitlist|lista-de-espera|Quibt Cloud/i);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/www/src/site.test.ts`

Expected: current waitlist-first landing fails.

- [ ] **Step 3: Implement install-first landing**

Hero CTA scrolls to download/install section. Render OS-specific buttons and copyable `quibtbot install` bootstrap. “Como funciona” uses: instalar servidor → trazer modelo → escolher computador → criar bot.

- [ ] **Step 4: Remove public waitlist navigation**

Waitlist service may remain as unlinked operator code, but no public page/header/SEO/sitemap points to it.

- [ ] **Step 5: Verify**

Run: `pnpm exec vitest run apps/www/src/site.test.ts apps/www/src/seo.test.ts && pnpm --filter @quibt/www build`

- [ ] **Step 6: Commit**

```bash
git add apps/www
git commit -m "feat: publish the open-source install path"
```

### Task 2: Explicit CI coverage

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`

- [ ] **Step 1: Add workflow policy test**

Create `packages/testkit/src/ci-config.test.ts` and assert CI contains:

- `pnpm --filter @quibt/mobile check`;
- `pnpm --filter @quibt/www build`;
- `pnpm verify:installer`;
- Electron `--dir` package build;
- mobile E2E command in its supported environment.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/testkit/src/ci-config.test.ts`

Expected: FAIL because jobs are absent.

- [ ] **Step 3: Add jobs**

Use Node `22.19.0`, pnpm cache and bounded timeouts. Keep provider-live tests opt-in. Upload reports only on failure. Avoid commands that silently skip unsupported platforms.

- [ ] **Step 4: Verify local equivalents**

Run:

```bash
pnpm --filter @quibt/mobile check
pnpm --filter @quibt/www build
pnpm verify:installer
pnpm --filter @quibt/desktop build
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml package.json packages/testkit/src/ci-config.test.ts
git commit -m "ci: validate every public client"
```

### Task 3: Versioned images and CLI binaries

**Files:**
- Create: `scripts/release-version.mjs`
- Create: `scripts/release-version.test.ts`
- Create: `scripts/build-cli-binary.mjs`
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Modify: `apps/www/src/site.ts`
- Modify: Docker build definitions under `infra/compose` and `infra/sandboxes`

**Interfaces:**
- Produces `releaseManifest(version)` with exact image and artifact names.

- [ ] **Step 1: Write failing version consistency test**

Assert root, desktop, CLI, site and image tags resolve from one git tag version; artifact names remain `QuibtBot.dmg`, `QuibtBot-setup.exe`, `QuibtBot.AppImage` and platform-specific `quibtbot` binaries.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run scripts/release-version.test.ts`

- [ ] **Step 3: Implement release manifest**

Reject dirty/invalid semver release input. Emit JSON consumed by image and package jobs. Do not hard-code a second desktop version in site source.

- [ ] **Step 4: Build standalone CLI per runner**

Use Node 22 single-executable packaging on each target runner. Embed JS blob, manifest and release version; bootstrap scripts verify SHA-256 before installation.

- [ ] **Step 5: Verify**

Run: `pnpm exec vitest run scripts/release-version.test.ts && node scripts/release-version.mjs 0.2.0`

Expected: one consistent manifest.

- [ ] **Step 6: Commit**

```bash
git add scripts package.json apps/desktop/package.json apps/www/src/site.ts infra
git commit -m "build: unify release artifacts and versions"
```

### Task 4: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `packages/testkit/src/release-workflow.test.ts`
- Modify: `scripts/pack-desktop.mjs`

- [ ] **Step 1: Write failing workflow test**

Parse YAML and assert:

- trigger is tags `v*`;
- permissions include `contents: write` and `packages: write`;
- image job precedes smoke;
- publication depends on smoke;
- matrix contains Ubuntu, macOS and Windows;
- checksums are generated;
- draft release is used until all jobs pass.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/testkit/src/release-workflow.test.ts`

- [ ] **Step 3: Implement workflow**

Jobs:

1. validate version and full fast suite;
2. build/push three GHCR images with immutable version and digest;
3. smoke image-only compose using published digests;
4. build CLI binaries on each OS;
5. build Electron installers on each OS;
6. create checksum file;
7. publish draft GitHub Release artifacts.

Signing steps run only when corresponding secrets exist and annotate release metadata when unsigned.

- [ ] **Step 4: Verify workflow structure**

Run: `pnpm exec vitest run packages/testkit/src/release-workflow.test.ts && pnpm exec actionlint .github/workflows/release.yml`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml packages/testkit/src/release-workflow.test.ts scripts/pack-desktop.mjs
git commit -m "ci: publish versioned Quibt releases"
```

### Task 5: Architecture and mobile documentation

**Files:**
- Create: `docs/architecture.md`
- Create: `docs/mobile.md`
- Modify: `README.md`
- Modify: `docs/self-host.md`
- Modify: `docs/desktop.md`
- Modify: `docs/computers.md`
- Modify: `docs/onboarding.md`
- Modify: `packages/core/src/machine-onboarding.ts`
- Modify: `packages/core/src/machine-onboarding.test.ts`

- [ ] **Step 1: Add failing documentation policy tests**

Assertions:

- README links architecture/mobile docs;
- public docs contain `quibtbot install`;
- E2B is never listed as server host;
- docs state laptop requirement for local API;
- Box computer copy says one VM per bot;
- no public waitlist/Cloud CTA.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/core/src/machine-onboarding.test.ts packages/testkit/src/docs-policy.test.ts`

- [ ] **Step 3: Write architecture document**

Cover clients, server stack, computer providers, persistence, trust boundaries, network flow, pairing and deployment modes with one canonical diagram.

- [ ] **Step 4: Write mobile document**

Cover local development, server setup, QR/code claim, SecureStore, remote install security, EAS/native SSH requirement, push, computer WebView and test commands.

- [ ] **Step 5: Align existing docs and copy**

Every guide uses the two questions “Onde o Quibt fica ligado?” and “Onde os bots trabalham?”. Correct stale key-in-env, restart and Box-sharing statements.

- [ ] **Step 6: Verify**

Run:

```bash
pnpm exec vitest run packages/core/src/machine-onboarding.test.ts packages/testkit/src/docs-policy.test.ts
pnpm --filter @quibt/www build
```

- [ ] **Step 7: Commit**

```bash
git add README.md docs packages/core/src/machine-onboarding.ts packages/core/src/machine-onboarding.test.ts packages/testkit/src/docs-policy.test.ts
git commit -m "docs: document unified self-hosted architecture"
```

### Task 6: Final full-story verification

**Files:**
- Create: `docs/verification-2026-08-17.md`
- Create artifacts outside the repository under `/opt/cursor/artifacts`.

- [ ] **Step 1: Run static and automated verification**

```bash
pnpm lint
pnpm check
pnpm build
pnpm verify:fast
pnpm verify:installer
pnpm --filter @quibt/mobile test
pnpm --filter @quibt/mobile check
pnpm --filter @quibt/www build
pnpm --filter @quibt/desktop build
```

- [ ] **Step 2: Run stateful/system verification**

```bash
pnpm db:migrate
pnpm exec vitest run --no-file-parallelism packages/testkit/src/journeys.test.ts packages/testkit/src/run-lease.pg.test.ts
pnpm e2e
pnpm e2e:mobile
pnpm smoke:installer
```

- [ ] **Step 3: Run Docker smoke**

Build/pull the computer, supervisor and stack images; run image-only compose; assert `/ready`, owner bootstrap, worker processing and clean restart with unchanged data.

- [ ] **Step 4: Perform manual GUI walkthroughs**

Record:

- Electron clean first boot → install → ready → QR;
- mobile URL/code → owner → model → machine → bot → message;
- machine settings and computer screen.

Save only successful concise videos and review them before referencing.

- [ ] **Step 5: Write verification report**

Record commands, exact pass counts, platforms, image digests and external limitations. Do not claim Apple/Windows signing or live Box/E2B without credentials/evidence.

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: record unified flow verification"
```
