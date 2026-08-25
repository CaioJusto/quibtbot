# Self-hosting Quibt Bot

This is **Quibt Bot**: you run the product, you bring the model, you pick the machine. Public site: [quibt.com.br](https://quibt.com.br). Leave `BILLING_ENABLED=false`.

Two separate questions, answered independently: **Onde o Quibt fica ligado?** and **Onde os bots trabalham?**

The first is where the server (API, worker, Postgres) runs: this computer, your VPS, or a Box
VM. The second is where each bot's own computer runs: Docker, a remote supervisor, E2B, or Box.
See [`docs/architecture.md`](./architecture.md) for the full picture.

Onboarding asks for an OpenRouter key, a local Ollama / OpenAI-compatible URL (`http://127.0.0.1:11434`), **or** a ChatGPT / Copilot / SuperGrok subscription. There is no Quibt token plan. The first owner picks the machine from the catalog (Docker, a remote supervisor / BYO VPS, E2B, or Box). E2B/Box and the remote supervisor accept keys and endpoints in the UI (BYOK), not only in `.env`. The pick is saved in `deployment_settings` and the API and worker route new computers to it; `SANDBOX_PROVIDER` stays the fallback for a deploy that never chose. VPS recipes (Hetzner, DigitalOcean, generic) install the Compose stack on **your** account — Quibt does not resell VMs. Plugins can add an HTTP MCP server without Composio.

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, or Box). It is not a static site. The marketing site in `apps/www` can be hosted separately.

## Local (source checkout)

Same as the README quick start on macOS, Windows, or Linux: `.env` from `.env.example`, Postgres via Compose, `pnpm sandbox:build`, and `pnpm dev`. Desktop: `pnpm desktop` or `pnpm dev:desktop` while that stack is up. For a plain browser, run `pnpm owner:code`, open [http://127.0.0.1:5173](http://127.0.0.1:5173), and enter that one-use installer code. See [desktop.md](./desktop.md). The host OS only runs the client and the stack; the bot computer is always Linux (Docker / E2B / Box).

This computer stays on for a locally-hosted server: the API, worker, and Postgres are the
`pnpm dev` processes on it, so closing the laptop or letting it sleep pauses the API for every
client, including a phone on the same account. A phone off this Wi-Fi can still reach a local
PC if the owner pastes their own HTTPS tunnel (Cloudflare Tunnel or Tailscale Funnel, pointed
at `http://127.0.0.1:5173`) in **Settings → Celular → Qualquer rede** — Quibt does not host
that tunnel, and the laptop still has to stay on. Put the server on a VPS or a Box VM (below)
when the API needs to stay reachable while your laptop is off.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and set `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` to long random strings. Quibt Bot refuses placeholder or missing secrets outside `development` / `test` (or when `QUIBT_ALLOW_DEV_SECRETS=1` is set).
2. Set `OPENROUTER_API_KEY` (and `COMPOSIO_API_KEY` if you want Plugins — or paste the Composio key later in **Plugins → Apps**; the deployment owner's key is stored encrypted with `ENCRYPTION_KEY` and applies to every bot. `COMPOSIO_API_KEY` in the env always wins).
3. Build the computer image: `pnpm sandbox:build` (Compose also builds it via the `computer` service).
4. `docker compose -f infra/compose/docker-compose.yml up --build`
5. Run `pnpm owner:code`, open the web origin (`http://127.0.0.1:5173` by default), and enter the one-use code. Only that explicitly enrolled first account becomes the deployment owner.

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and a Vite preview of the web app. Each workspace gets one sibling Linux container (`quibt/computer:local`); bots in it share the filesystem and installed tools while keeping distinct graphical desktop sessions. The API process does not get an unrestricted Docker socket; the supervisor owns lifecycle.

Postgres and the API are published on **loopback only** (`127.0.0.1:5433` and
`127.0.0.1:3100` on the host). Remote clients use the web origin on `:5173`, which proxies
`/api`, `/rpc`, `/files`, and `/novnc`. Do not expose the database or API host ports on a public
VPS. The source Compose file hard-codes development database credentials (`quibt` / `quibt` /
database `quibt`): change `POSTGRES_USER` / `POSTGRES_PASSWORD` together with `DATABASE_URL`,
and keep Postgres on an internal network when you deploy remotely. A volume created with the old
local role must be recreated (`pnpm compose:down` deletes it) or the role renamed in that cluster.

The Docker supervisor is not published. It is authenticated and stays on the internal Compose network because access to it is equivalent to control of the Docker host. Production requires its own credential: set the same `SANDBOX_SUPERVISOR_TOKEN` (a long random string, different from `BETTER_AUTH_SECRET`) on the API, worker, and supervisor, or the three services refuse to boot. Outside production an empty value is accepted and each service derives the token from `BETTER_AUTH_SECRET`, so the session secret itself never reaches the supervisor.

On a VPS, put TLS in front of `:5173` (or serve the web build behind your proxy) and set:

```env
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
```

Cookies and CORS follow those origins. Generated installs default to `SIGNUPS_ENABLED=false`.
Open registration deliberately, and keep `SIGNUP_ALLOWLIST` tight on a public host.
Set `TRUSTED_WEB_ORIGINS` to a comma-separated list only when additional browser origins must call the API. Production does not implicitly trust `localhost` or `127.0.0.1`.
Set `TRUSTED_PROXY_IPS` only to the transport addresses of reverse proxies that overwrite forwarding headers; forwarded client-IP headers are ignored for all other peers.

## Webhooks (waking a bot from another system)

Each bot can expose a webhook so an external system (GitHub, Stripe, your own script) wakes it with a task, without anyone opening the app. Set the deployment's public webhook URL in **Settings → Webhooks** or **Settings → Celular → Qualquer rede** (same owner-only HTTPS origin; a VPS uses that install's own domain, a PC needs a Cloudflare Tunnel or Tailscale Funnel the person configures and pays for themselves — Quibt provides, hosts, and sells no Cloud, relay, or tunnel for this). Behind a reverse proxy, also set `TRUSTED_PROXY_IPS` (above) so the per-IP `/hooks/*` rate limits key off the real client, not the proxy. Full request/response contract, headers, status codes, idempotency, and limits: [docs/webhooks.md](./webhooks.md).

Password reset and verification use Resend. Production requires `RESEND_API_KEY` by default. A billing-disabled self-host may explicitly set `AUTH_EMAIL_DISABLED=true`; reset and verification email will then be unavailable. Billing-enabled production cannot opt out.

Optional:

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker   # or e2b / box. Keep fake only for pnpm verify:fast.
AGENT_RUNTIME=pi          # Keep scripted only for pnpm verify:fast.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause the bot computer after 10 minutes idle
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
BOX_API_KEY=              # when SANDBOX_PROVIDER=box
```

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

## Choosing a computer provider

The catalog in onboarding and **Settings → Máquina** is the picker. After a tap, the app shows a plain-language guide (what to install, where the key lives, how bots share the computer). That copy is `machineGuideFor()` in `@quibt/core`. The long form is [computers.md](./computers.md); the first-run walkthrough is [onboarding.md](./onboarding.md). `SANDBOX_PROVIDER=desktop` is refused because a host process is not an OS sandbox.

- **Docker** is the trusted single-machine implementation: one resource-limited persistent container and home per workspace, plus one X11/noVNC/Chrome session per bot. With `SANDBOX_SCREEN_NETWORK=internal` — what the Compose stack sets — every workspace computer gets a dedicated Docker network separate from Postgres and the application network; without it the computer runs on Docker's default bridge, so set it on any host that also runs the database. Keep the supervisor private. Public or multi-user deployments should use E2B, Box, or a remote supervisor on a dedicated VPS.
- **Remote supervisor / BYO VPS** — paste `https://your-vps:7091` and the supervisor token, or follow a catalog recipe (Hetzner, DigitalOcean, generic `curl | bash` / cloud-init). Quibt does not provision or bill the VM.
- **E2B** keeps its existing one-bot/one-sandbox behavior. Paste `E2B_API_KEY` in the UI (BYOK) or set it in `.env`. Workspace-wide shared files and multi-display sessions are currently the Docker path; they are not emulated by sharing a browser tab in E2B.
- **Box** (`SANDBOX_PROVIDER=box`, box.ascii.dev) gives each bot a persistent Ubuntu cloud VM with a virtual desktop, billed per second on **your** Box account. Paste `BOX_API_KEY` in the UI. User boxes are created with `noEnv: true`, so operator environment variables and credentials are never copied into them. Boxes are created without provider auto-stop; the `SANDBOX_IDLE_MS` scheduler stops (archives) idle boxes and they resume with their disk intact on the next message or Take control. Take control happens through the interactive noVNC desktop stream.
- **Desktop provider** is disabled. Running the Electron client does not run model commands on the host.
- **Fake** is only an emulator for verification.

## Backup

```bash
./scripts/backup.sh
```

This dumps Postgres (`pg_dump`) and archives `data/` into `backups/<stamp>/`.

## Restore

```bash
./scripts/restore.sh backups/<stamp>
```

## Uninstall

```bash
quibtbot uninstall              # compose down --volumes, bot computers (label quibt.managed=true), ghcr.io/quibt/* images, data dir
quibtbot uninstall --keep-data  # everything above except the data dir (Postgres, bot homes, quibt.env)
quibtbot uninstall --keep-images
```

Only what the installer created is removed: the `quibt-desktop` compose project, containers
labelled `quibt.managed=true`, images under `ghcr.io/quibt/`, and the data directory
(`~/Library/Application Support/Quibt` on macOS, `~/.local/share/quibt` on Linux,
`%LOCALAPPDATA%\Quibt` on Windows — or wherever `install` wrote `quibt.env`). Docker, other
projects' containers and volumes are never touched. The command prints what it removed and what,
if anything, it had to leave behind.

## Upgrade

Pull the new source, run `pnpm db:migrate` (the existing `prisma migrate deploy` command), then restart API and worker. This is the only production schema path: do not use `db push` or `migrate dev`. `prisma migrate deploy` applies every checked-in folder under `packages/db/prisma/migrations` that this database has not seen yet, starting at `0001_init`. Product contracts stay compatible across upgrades.

## Production (your VPS)

You host it, users bring a key or a subscription, and you pick the machine.

`apps/www` is the public landing site (Astro, `output: "static"`). Point `PUBLIC_APP_ORIGIN` at the signed-in app.

The product cannot be “pushed live” as a Vercel serverless app. Graphile Worker, Postgres `LISTEN`, Pi runs, and Docker computers need durable processes and a sandbox host.

To run Open Source on a public host (same codebase):

1. Push `main` (this checkout may be ahead of GitHub).
2. Provision managed Postgres 16 and run `pnpm db:migrate`.
3. Run **API** and **worker** as always-on Node 22 services (Fly machines, a VM, ECS, k8s). Not lambda-style request handlers.

### Voice notes are transcribed on the machine

The microphone records a voice note and transcribes it locally: Whisper runs in the browser
(or inside the desktop app) through WebGPU, falling back to WASM. The audio never leaves the
machine and there is no speech API key. The model (~75 MB) is fetched from the Hugging Face
Hub the first time someone records, then cached — that download is the only network call, and
after it the feature works offline. If it fails, the voice note is still sent as audio.

4. Persist `DATA_DIR` (bot homes) and `ARTIFACTS_DIR` (files exchanged in the chat: screenshots, PDFs,
   spreadsheets, voice notes; defaults to `./data/artifacts`). Both are local filesystems today, so attach a
   volume. Object-storage-backed homes are not wired yet.
5. Choose computers: **`SANDBOX_PROVIDER=e2b`** with `E2B_API_KEY` or **`SANDBOX_PROVIDER=box`** with `BOX_API_KEY` for a public or multi-user production service. Each bot keeps one sandbox id (`providerRef`) and a graphical desktop with a browser. Take control, sign in, then release — the bot keeps that session. Idle boxes pause after `SANDBOX_IDLE_MS` (default 10 minutes) and resume on the next message or Take control. Docker remains the local and trusted single-machine default.
6. A Hetzner CX22 (2 vCPU / 4 GB) is enough for API + worker + Postgres when E2B owns the desktops. 2 GB works for a quiet box; 8 GB is only needed if you also run Docker computers on that same machine.
7. Set public HTTPS `WEB_ORIGIN` / `BETTER_AUTH_URL` / `API_URL`, secrets, and an OpenRouter (or other Pi) deployment key if you want to skip per-user model keys.
8. Put the web app behind the same origin as `/api` and `/rpc` (Vite preview proxy, or a reverse proxy). Docker noVNC connections use short-lived signed `/novnc/*` capabilities; do not replace that route with an unrestricted port proxy.
9. Deploy `apps/www` and point the product origin at your API/web host.
10. Turn on `SIGNUP_ALLOWLIST` until you want open registration. Users bring an OpenRouter key or a subscription. Keep `BILLING_ENABLED=false`.

Expo / desktop installers are clients of that origin (`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_WEB_ORIGIN`, `QUIBT_WEB_URL`). The Android build permits cleartext at the OS layer so loopback and Tailscale's encrypted `100.64.0.0/10` overlay can work, but `normalizeApiBase` rejects ordinary LAN and public HTTP origins by default. Plain RFC1918 HTTP is available only in an explicit development build with `EXPO_PUBLIC_ALLOW_INSECURE_LAN=true`. iOS uses `NSAllowsLocalNetworking`. Use a valid HTTPS origin for every VPS or internet-facing deployment. Manually entered endpoints must answer the Quibt health probe; QR/deep links show the exact destination and require explicit confirmation before changing the phone's saved API. The screen URL is issued only to the live control-lease holder.

E-mail verification needs `RESEND_API_KEY`. Without a mailer, password reset still works on the machine itself: `POST /api/local/reset-link` answers only to loopback and only when no mailer is configured, and the browser on that computer shows the link at **Esqueceu a senha?**. Do not expose that route through a reverse proxy.
