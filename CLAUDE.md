# Quibt Bot — Claude Code

This repository is **Quibt Bot**: an open-source, local-first product. Persistent AI bots with a real computer (desktop, web, mobile). You run the stack. You bring the model. You pick the machine. Apache-2.0. Packages live under `@quibt/*`.

The public product is **not** a hosted Cloud. Website, README, and onboarding present only the open-source path: install, sign up, bring a model, pick where the computer runs.

## Purpose (current)

1. **Install** the app (Mac / Windows / Linux) or run from source.
2. **Bring a model** — OpenRouter key, local Ollama / LM Studio URL, or a ChatGPT / Copilot / SuperGrok subscription. There is no Quibt token plan on the public path.
3. **Pick the machine** — Docker on this computer (default), your VPS, E2B, or Box. Keys and the supervisor URL are pasted in the UI (BYOK).
4. **Create a bot.** Each bot has one thread, one computer screen, memory, routines, and history.

Non-technical people are a first-class audience. Machine onboarding must say what to install, where to click, what they will pay, and how bots share a computer. Copy lives in `packages/core/src/machine-onboarding.ts` and is rendered after a machine is selected.

## Computer model (what actually runs)

The app you open and the computer provider are separate. Web, Electron, and mobile are clients of the same API. Electron does **not** run agent commands as the macOS / Windows user.

| Choice | What it is | Several bots |
| --- | --- | --- |
| `docker` (default) | One resource-limited Linux container per workspace (`quibt/computer:local`) | Same computer, **one graphical desktop per bot** (Xvfb + noVNC + Chrome). Not a browser tab. Shared home and optional shared Chromium cookies. Same image; each session has its own display. |
| `remote-supervisor` / VPS | Same Docker supervisor on a host you already run | Same as Docker. Phone keeps working when the laptop is off. |
| `e2b` | Official E2B Desktop sandbox (one stream per sandbox, pause on idle) | **One sandbox per bot.** Isolated. Not shared files, not multi-display, not a tab. |
| `box` | Official Box Ubuntu VM (`ttlSeconds: null`, `noEnv: true`, stop archives disk) | **One VM per bot.** Persistent. Not the Docker image. |
| `desktop` / `fake` | Disabled / emulator | Tests only. `SANDBOX_PROVIDER=desktop` is refused. |

Crocbot (sometimes called “Croc Pot”) is a different product: isolated Docker sandboxes per agent **or** Chrome tab control via a dedicated profile / extension. Quibt Docker is “one office PC, one monitor per bot.” It does not attach to the user’s Chrome tabs.

Details and the non-technical walkthrough: [docs/computers.md](docs/computers.md), [docs/onboarding.md](docs/onboarding.md).

## Run locally

Node.js >= 22.19, pnpm 9, Docker Desktop.

```bash
cp .env.example .env
# BETTER_AUTH_SECRET, ENCRYPTION_KEY; optional OPENROUTER_API_KEY
docker compose -f infra/compose/docker-compose.yml up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
```

Open http://127.0.0.1:5173. `pnpm desktop` / `pnpm dev:desktop` wrap the same UI in Electron.

`pnpm verify:fast` uses emulators (`AGENT_RUNTIME=scripted`, `SANDBOX_PROVIDER=fake`, `WAKEUP_DRIVER=memory`). Default product path is Pi + Docker + Graphile.

## Product rules

- Do not add Cloud waitlists, dual-edition marketing, or a hosted CTA to README, `apps/www`, or onboarding.
- Keep `BILLING_ENABLED=false` in `.env.example` and self-host docs.
- Billing and `QUIBT_EDITION` still exist in the API for operators. Do not delete that engine; do not offer it in UX.
- If you change onboarding, sandbox choice, or the desktop app, update README, `docs/self-host.md`, `docs/desktop.md`, `docs/computers.md`, `docs/onboarding.md`, and `packages/core/src/machine-onboarding.ts`.
- The product has one light visual system, described in [docs/design-system.md](docs/design-system.md). Colour, radius and text size come from the `--qb-*` tokens in `packages/ui-tokens`; never hardcode a hex for chrome, and never add a dark surface. Bot mascot colours and status greens are content, not chrome, and stay outside the tokens.

## Layout

```
apps/     web  api  worker  desktop  mobile  www
packages/ @quibt/core  contracts  db  auth  memory  ui-web  adapter-kit  adapters  testkit
infra/    compose  sandboxes
```

Public site: `apps/www` (Astro) at quibt.com.br. Signed-in product: `apps/web`.
