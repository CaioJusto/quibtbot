<p align="center">
  <img src="docs/assets/mascots.png" alt="Quibt Bot mascots" width="720" />
</p>

<h1 align="center">Quibt Bot</h1>

<p align="center">
  Persistent AI bots with a real computer — desktop, web, and mobile.<br />
  Local-first. Bring your own models. Apache-2.0.
</p>

<p align="center">
  <a href="https://quibt.com.br">quibt.com.br</a>
  ·
  <a href="https://github.com/CaioJusto/quibtbot">GitHub</a>
</p>

<p align="center">
  <a href="https://github.com/CaioJusto/quibtbot/actions/workflows/ci.yml"><img src="https://github.com/CaioJusto/quibtbot/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.19-brightgreen.svg" alt="Node.js >= 22.19" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/pnpm-9-F69220.svg" alt="pnpm 9" /></a>
  <a href="https://github.com/CaioJusto/quibtbot/releases/latest"><img src="https://img.shields.io/badge/release-v0.2.11-brightgreen.svg" alt="v0.2.11" /></a>
</p>

Each bot has one thread, one computer, memory, routines, and history. You run the stack on your machine. Packages live under `@quibt/*`. This repository is the complete product.

> **Where this is:** `v0.2.11` is published and running. What that means concretely: the
> Apple-silicon DMG is Developer ID signed **and** notarized (`spctl` reports
> `accepted / source=Notarized Developer ID`), the three container images are public and
> multi-architecture, and CI proves the Linux path on every run — a real Docker host boots a bot
> computer and the VPS Compose stack comes up and answers.
>
> What is **not** covered yet: the Windows installer and the Linux AppImage are unsigned previews
> (Intel Macs run from source), and a public multi-user deployment still needs the isolation and TLS
> choices in [Security model](#security-model) — Docker and `remote-supervisor` assume one trusted
> owner. The evidence behind each claim is in the
> [release-readiness ledger](docs/release-readiness.md).

## Download

The desktop app wraps the same UI the browser shows. The API, worker, and bot computer still run on
**your** machine — the app is a window, not a service in someone else's cloud.

| Platform | Installer | One sentence |
| --- | --- | --- |
| macOS (Apple silicon) | [`QuibtBot.dmg`](https://github.com/CaioJusto/quibtbot/releases/download/v0.2.11/QuibtBot.dmg) | Developer ID signed **and notarized** by Apple: it opens without the "unidentified developer" warning. |
| macOS (Intel) | — | Not supported yet: run from source (`pnpm dev` + `pnpm desktop`). |
| Windows (64-bit) | [`QuibtBot-setup.exe`](https://github.com/CaioJusto/quibtbot/releases/download/v0.2.11/QuibtBot-setup.exe) | Unsigned preview installer: SmartScreen warns (**More info → Run anyway**), and you install Docker Desktop yourself. |
| Linux (x64) | [`QuibtBot.AppImage`](https://github.com/CaioJusto/quibtbot/releases/download/v0.2.11/QuibtBot.AppImage) | Unsigned preview AppImage: needs `libfuse2`, mark it executable and run it. |
| Linux / macOS (server) | `quibtbot` CLI | The one-line install below; no desktop app involved. |

The file names above never change; the version lives in the release tag. Details and the
signing status of each installer are in [`docs/desktop.md`](docs/desktop.md).

The `v0.2.11` release publishes those three desktop installers, standalone macOS/Linux/Windows
`quibtbot` binaries, matching SHA-256 files, and public multi-architecture Docker images from
the same tag. Use the immutable, version-matched command below:

```bash
release=0.2.11
curl -fsSL "https://raw.githubusercontent.com/CaioJusto/quibtbot/v${release}/scripts/install.sh" \
  | QUIBT_RELEASE="${release}" sh
```

`scripts/install.sh` picks the `quibtbot` release binary for the machine, checks its SHA-256,
puts it on the PATH and runs `quibtbot install`: it detects Docker (and Compose), generates
secrets, runs Compose, and prints a URL plus a short code/QR for the mobile app's "Conectar a
um Quibt existente" flow. The binary carries the Compose manifest inside it, so it also works
when downloaded by hand:

On mobile, **Scan the computer QR** is always the first action; server address, VPS and local
installation are secondary paths below it. A packaged desktop install publishes API port `3100`
to the host LAN so the QR address is actually reachable. Set `QUIBT_API_BIND_HOST=127.0.0.1`
before starting Compose to disable LAN access. On iPhone, allow **Local Network** when iOS asks;
without that native permission iOS blocks even a healthy `192.168.x.x` server.

The QR always follows the server currently open in the desktop app. If Electron is connected to
`https://your-vps.example`, the phone connects directly to that VPS; it does not route through the
laptop. Only a desktop using its local stack offers the LAN / user-owned HTTPS tunnel choice.

```bash
release=0.2.11
curl -fsSL "https://github.com/CaioJusto/quibtbot/releases/download/v${release}/quibtbot-linux-x64" -o /tmp/quibtbot
curl -fsSL "https://github.com/CaioJusto/quibtbot/releases/download/v${release}/quibtbot-linux-x64.sha256" -o /tmp/quibtbot.sha256
echo "$(awk '{print $1}' /tmp/quibtbot.sha256)  /tmp/quibtbot" | sha256sum -c -
chmod +x /tmp/quibtbot
/tmp/quibtbot install --non-interactive --show-sensitive
```

See [`docs/self-host.md`](docs/self-host.md) for the VPS/Box walkthroughs.

Leaving is one command too. Installing puts containers, one computer container per workspace, three
images and a data directory on the machine; deleting the app alone leaves all of that behind.

```bash
quibtbot uninstall                # services, bot computers, images and the data dir
quibtbot uninstall --keep-data    # keep the database and bot homes for a later reinstall
```

In the desktop app the same thing is **Quibt Bot → Desinstalar o Quibt Bot…** (it asks once,
can keep your data, and moves the app to the Trash). Docker itself stays; bots on a VPS, E2B or
Box are not touched.

From a source checkout, after the local stack is up:

```bash
pnpm desktop            # open the Electron app
pnpm dev:desktop        # wait for the stack, then open
pnpm desktop:pack:mac   # Apple silicon .dmg → apps/desktop/out/
pnpm desktop:pack:win   # 64-bit NSIS → apps/desktop/out/
pnpm desktop:pack:linux # x64 AppImage → apps/desktop/out/
```

## What you get

| | |
| --- | --- |
| **A bot** | One thread, one graphical Linux desktop of its own, memory, routines, history. Talk to it in the app; it browses, downloads, writes files and runs commands on that desktop. |
| **Your model** | An OpenRouter key, a local Ollama / LM Studio URL, or the ChatGPT / Copilot / SuperGrok subscription you already pay for. Quibt sells no tokens and takes no cut. |
| **Your machine** | Docker on this computer (default), your own VPS, E2B, or Box. The choice is made in onboarding and can change later in Ajustes → Máquina. |
| **Three clients** | Web, desktop (Electron, macOS/Windows/Linux) and phone (iOS/Android) — all clients of the same API, so a bot started on the laptop keeps working from the phone. |
| **Your data** | Postgres and the bot home directories live on the machine you installed onto. Uninstall takes them with it if you want. |

## Run locally

**Requirements for source development:** Node.js >= 22.19, pnpm 9, and Docker Desktop or Engine (Postgres + the graphical bot computer). The packaged macOS app detects Docker Desktop, Colima, and Homebrew even when launched from Finder; if no Docker engine exists, it downloads the official architecture-matched Docker Desktop DMG, validates Docker Inc.'s signature and Apple notarization, asks for the macOS administrator password once, opens Docker, and resumes the Quibt installation automatically. The app you open is native to the host; the bot computer is always a Linux desktop (Docker / E2B / Box), not your Mac or Windows session.

```bash
cp .env.example .env
```

Set `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` to long random strings. Put an OpenRouter key in `OPENROUTER_API_KEY`, or skip it and paste a key (or sign in with a subscription) during onboarding. Optional: `COMPOSIO_API_KEY` for Plugins — or paste your Composio key later in **Plugins → Apps** inside the app (the owner only; it is stored encrypted). Computer default: `SANDBOX_PROVIDER=docker`.

```bash
docker compose -f infra/compose/docker-compose.yml up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
```

`pnpm dev` starts the API (`:3100`), Graphile Worker, Vite web app (`:5173`), and sandbox supervisor (`:7091`). This computer (or whichever VPS/Box VM you install onto) has to keep running for that API: turning it off pauses the API, the worker, and every bot until you turn it back on.

For the native source flow, open another terminal and run `pnpm dev:desktop`; the app securely carries the installer's one-use invitation into the first-owner signup. For a plain browser, run `pnpm owner:code`, open [http://127.0.0.1:5173](http://127.0.0.1:5173), and enter the displayed eight-character code. The first account asks for your name only — no e-mail, no password ([why](docs/entrar-sem-senha.md)). Create a bot and send a message. The computer pane is a live Linux desktop with a browser.

```bash
curl -s http://127.0.0.1:3100/health
curl -s http://127.0.0.1:3100/ready
```

`/health` should show `"runtime":"pi"`, `"sandbox":"docker"`, and `"wakeup":"graphile"`. `/ready` checks that Postgres answers.

Product defaults are Pi + Docker + Graphile. `pnpm verify:fast` pins emulators (`AGENT_RUNTIME=scripted`, `SANDBOX_PROVIDER=fake`, `WAKEUP_DRIVER=memory`) so default tests never call live models or Composio.

If this Postgres was created with `prisma db push` before checked-in migrations existed, mark the baseline once:

```bash
pnpm --filter @quibt/db exec prisma migrate resolve --applied 0001_init
```

For every production install and upgrade, `pnpm db:migrate` (`prisma migrate deploy`) is the only schema-change path.

## Computer

The app you open and the computer provider are separate. Web, Electron, and mobile are clients of the same API — Electron does not run agent commands as your macOS or Windows user.

| `SANDBOX_PROVIDER` | Where commands run | Best fit |
| --- | --- | --- |
| `docker` (default) | One resource-limited Linux container per workspace, **one graphical desktop per bot** | Local and trusted single-machine self-host |
| `remote-supervisor` | Same Docker supervisor on a host you already run, **one graphical desktop per bot** | BYO VPS (`SANDBOX_REMOTE_SUPERVISOR_URL` or Settings → Máquina) |
| `e2b` | Remote E2B sandbox, **one sandbox per bot** | Public or multi-user (env or BYOK); bot computer only, never a server host |
| `box` | Persistent Ubuntu VM, **one VM per bot** | Public or multi-user (env or BYOK) |
| `desktop` / `fake` | Disabled / in-process emulator | Tests only |

You can pick Docker, E2B, or Box in onboarding. Keys can be pasted directly in the UI (BYOK) at
Settings → Máquina, or set once in `.env` for E2B (`E2B_API_KEY`) and Box (`BOX_API_KEY`) so
every deploy inherits them — the UI path does not require editing `.env` at all. The choice is
saved in `deployment_settings`; `SANDBOX_PROVIDER` is the fallback.

With `SANDBOX_SCREEN_NETWORK=internal` (what `infra/compose` sets) each workspace computer gets a dedicated Docker network and cannot join the database/application network. Plain `pnpm dev` leaves it on Docker's default bridge. Keep the supervisor private.

## Security model

- Packaged releases pin the three Quibt container images by immutable digest. Source checkout
  Compose builds the code in the checkout. The API host port is loopback-only; browsers and phones
  reach `/api`, `/rpc`, and `/novnc` through the web origin.
- Generated self-host environments keep registration closed (`SIGNUPS_ENABLED=false`) until the
  owner explicitly opens it. Never expose Postgres, the supervisor, or port `3100` publicly.
- Docker and `remote-supervisor` are for a trusted, single-owner workspace. Bots in one workspace
  share a Unix/container boundary. Use one sandbox/VM per bot (E2B or Box) when bots or tenants are
  mutually untrusted.
- Use HTTPS for every VPS or internet-facing endpoint. Same-Wi-Fi HTTP pairing is a convenience,
  not protection against a hostile LAN; prefer a valid HTTPS origin or Tailscale.
- Remote pages loaded by Electron do not receive native file, infrastructure, secret, uninstall,
  or media privileges. Those capabilities are restricted to the bundled local app.

Please report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).

## Verify

```bash
pnpm verify:fast       # unit, property, and in-process contract tests
pnpm verify            # Postgres via Testcontainers, emulators, API, Playwright
pnpm verify:providers  # optional live OpenRouter / E2B canaries
```

## Stack

```
apps/     web  api  worker  desktop  mobile  www
packages/ @quibt/core  contracts  db  auth  memory  ui-web  adapter-kit  adapters  testkit
infra/    compose  sandboxes
```

| Layer | What |
| --- | --- |
| Runtime | Node.js 22, pnpm, Turbo |
| API / worker | Hono + oRPC, Graphile Worker, Prisma, Postgres |
| Clients | Vite + React (web), Electron (desktop), Expo (mobile) |
| Site | Astro (`apps/www`) at [quibt.com.br](https://quibt.com.br) |
| Computer | Docker (default), E2B, or Box |

`apps/www` is the public site. The signed-in product is `apps/web`.

## Docs

| Doc | What it covers |
| --- | --- |
| [`docs/onboarding.md`](docs/onboarding.md) | First run in plain language (install, model, machine, first bot) |
| [`docs/computers.md`](docs/computers.md) | Docker, VPS, E2B, Box — what to do, how bots share a computer |
| [`docs/desktop.md`](docs/desktop.md) | Mac DMG / Windows installer, local-first desktop |
| [`docs/mobile.md`](docs/mobile.md) | Expo app: server setup, QR/code claim, off-LAN HTTPS tunnel, SecureStore, remote install security |
| [`docs/self-host.md`](docs/self-host.md) | Run Quibt Bot on your machine or VPS |
| [`docs/release-readiness.md`](docs/release-readiness.md) | What is verified, what is release-blocking, and what remains architectural |
| [`docs/entrar-sem-senha.md`](docs/entrar-sem-senha.md) | Sign in with a short code instead of e-mail and password: why, and how it is kept safe |
| [`docs/architecture.md`](docs/architecture.md) | Clients, server stack, computer providers, trust boundaries, network flow |
| [`docs/webhooks.md`](docs/webhooks.md) | Wake a bot from another system: URLs, auth, retries, limits |
| [`CLAUDE.md`](CLAUDE.md) | Current purpose and computer model for Claude Code / agents |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to work in this repo |
| [`SECURITY.md`](SECURITY.md) | How to report vulnerabilities |
| [`LICENSE`](LICENSE) / [`NOTICE`](NOTICE) | Apache-2.0 and third-party attribution |

---

Apache-2.0. Copyright 2026 Caio Justo. Required third-party notices live in `LICENSE` and `NOTICE`.
