# Self-hosting Quibt Bot

This is **Quibt Bot**: you run the product, you bring the model, you pick the machine. Public site: [quibt.com.br](https://quibt.com.br). Leave `BILLING_ENABLED=false`.

Two separate questions, answered independently: **Onde o Quibt fica ligado?** and **Onde os bots trabalham?**

The first is where the server (API, worker, Postgres) runs: this computer, your VPS, or a Box
VM. The second is where each bot's own computer runs: Docker, a remote supervisor, E2B, Box, or Daytona.
See [`docs/architecture.md`](./architecture.md) for the full picture.

Onboarding asks for an OpenRouter key, a local Ollama / OpenAI-compatible URL (`http://127.0.0.1:11434`), a ChatGPT / Copilot / SuperGrok subscription, **or** a detected authenticated Claude Code / Codex / Grok CLI (or one extra ACP CLI). Host CLIs use no pasted API key, run beside the API/worker, and call the bot computer's existing tools; they do not control the host Mac/Windows. See [cli-engines.md](./cli-engines.md). There is no Quibt token plan. The first owner picks the machine from the catalog (Docker, a remote supervisor / BYO VPS, E2B, Box, or Daytona). E2B, Box, Daytona, and the remote supervisor accept keys and endpoints in the UI (BYOK), not only in `.env`. The pick is saved in `deployment_settings` and the API and worker route new computers to it; `SANDBOX_PROVIDER` stays the fallback for a deploy that never chose. VPS recipes (Hetzner, DigitalOcean, generic) install the Compose stack on **your** account — Quibt does not resell VMs. Plugins can add an HTTP MCP server without Composio.

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Box, or Daytona). It is not a static site. The marketing site in `apps/www` can be hosted separately.

## Local (source checkout)

Same as the README quick start on macOS, Windows, or Linux: `.env` from `.env.example`, Postgres via Compose, `pnpm sandbox:build`, and `pnpm dev`. Desktop: `pnpm desktop` or `pnpm dev:desktop` while that stack is up. For a plain browser, run `pnpm owner:code`, open [http://127.0.0.1:5173](http://127.0.0.1:5173), and enter that one-use installer code. On this source path an empty `BOOTSTRAP_SECRET` is derived from `BETTER_AUTH_SECRET`, same as the API; Compose still requires its own value (below). See [desktop.md](./desktop.md). The host OS only runs the client and the stack; the bot computer is always Linux (Docker / E2B / Box / Daytona).

This computer stays on for a locally-hosted server: the API, worker, and Postgres are the
`pnpm dev` processes on it, so closing the laptop or letting it sleep pauses the API for every
client, including a phone on the same account. A phone off this Wi-Fi can still reach a local
PC if the owner pastes their own HTTPS tunnel (Cloudflare Tunnel or Tailscale Funnel, pointed
at `http://127.0.0.1:5173`) in **Settings → Celular → Qualquer rede** — Quibt does not host
that tunnel, and the laptop still has to stay on. Put the server on a VPS or a Box VM (below)
when the API needs to stay reachable while your laptop is off.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and replace every published placeholder. The Compose services
   pin `NODE_ENV=production` themselves (`environment:` wins over `env_file:`), so the
   `NODE_ENV=development` line the example keeps for `pnpm dev` does **not** reach the stack, and
   the boot is fail-closed: any value that is missing, shorter than 32 characters, or still starts
   with `replace-with-` is refused. Generate each one with `openssl rand -hex 32`:

   ```env
   BETTER_AUTH_SECRET=…        # session cookies
   ENCRYPTION_KEY=…            # model/plugin keys stored in the database
   SANDBOX_SUPERVISOR_TOKEN=…  # own credential, different from BETTER_AUTH_SECRET
   BOOTSTRAP_SECRET=…          # loopback-only first-owner invites
   ```

   Also pick the mailer: set `RESEND_API_KEY`, or set `AUTH_EMAIL_DISABLED=true` to run without
   password-reset e-mail (only with `BILLING_ENABLED=false`). `QUIBT_ALLOW_DEV_SECRETS=1` still
   relaxes all of this on a single development machine; never set it on a server.
2. Set `OPENROUTER_API_KEY` (and `COMPOSIO_API_KEY` if you want Plugins — or paste the Composio key later in **Plugins → Apps**; the deployment owner's key is stored encrypted with `ENCRYPTION_KEY` and applies to every bot. `COMPOSIO_API_KEY` in the env always wins).
3. Build the computer image: `pnpm sandbox:build` (Compose also builds it via the `computer` service).
4. `docker compose -f infra/compose/docker-compose.yml up --build`
5. Run `pnpm owner:code`, open the web origin (`http://127.0.0.1:5173` by default), and enter the one-use code. Only that explicitly enrolled first account becomes the deployment owner.

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and the dedicated Node production server for the web app. Each workspace gets one sibling Linux container (`quibt/computer:local`); bots in it share the filesystem and installed tools while keeping distinct graphical desktop sessions. The API process does not get an unrestricted Docker socket; the supervisor owns lifecycle.

Postgres and the API are published on **loopback only** (`127.0.0.1:5433` and
`127.0.0.1:3100` on the host). Remote clients use the web origin on `:5173`, which proxies
`/api`, `/rpc`, `/files`, and `/novnc`. Do not expose the database or API host ports on a public
VPS. The source Compose file hard-codes development database credentials (`quibt` / `quibt` /
database `quibt`): change `POSTGRES_USER` / `POSTGRES_PASSWORD` together with `DATABASE_URL`,
and keep Postgres on an internal network when you deploy remotely. A volume created with the old
local role must be recreated (`pnpm compose:down` deletes it) or the role renamed in that cluster.

The Docker supervisor is not published. It is authenticated and stays on the internal Compose network because access to it is equivalent to control of the Docker host. Production requires its own credential: set the same `SANDBOX_SUPERVISOR_TOKEN` (a long random string, different from `BETTER_AUTH_SECRET`) on the API, worker, and supervisor, or the three services refuse to boot. The Compose stack always runs as production, so the value must be filled in `.env`. Only outside production — `pnpm dev` on your own machine — an empty value is accepted, and each service then derives the token from `BETTER_AUTH_SECRET`, so the session secret itself never reaches the supervisor.

### Signing in on a LAN or public install

`POST /api/local/session` — the route the local app uses to open the owner's session without a
password — only exists when the install itself is loopback. On a LAN address or a public origin it
answers `404` for every client, on purpose: a neighbour on the same Wi-Fi reaches a published API
port with the same source address as the owner's browser, so an address is never proof of who is at
the keyboard. Entry on such an install is by password, or by a **pairing code** minted in
**Settings → Celular** on a device that is already signed in.

On the machine that runs the stack, the desktop app still signs itself in: it proves it holds the
local `quibt.env` secret with a one-minute, single-use capability. Without that file it sends
nothing and falls back to the normal sign-in. See [desktop.md](./desktop.md).

### Supervisor on another host (opt-in, `supervisor-tls`)

Port 7091 is not published by any default profile: whoever reaches it controls that host's
Docker. To let a Quibt deployment use *another* host as the computer, the operator turns the
profile on **on that computer host**:

```bash
QUIBT_SUPERVISOR_PUBLIC_HOST=quibt-a1b2c3d4.203.0.113.9.sslip.io \
  docker compose -f infra/compose/docker-compose.desktop.yml \
  -f infra/compose/docker-compose.supervisor-tls.yml \
  --profile supervisor-tls up -d supervisor supervisor-tls
```

The service lives in its own file on purpose. Compose interpolates every file it loads before it
looks at `profiles:`, so a required variable in the main file would break `docker compose up` for
every existing install whose `quibt.env` does not have it. The extra `-f` is the opt-in; the
profile keeps it off even then. That file is not shipped inside the desktop/CLI installer bundle
— take it from the repository and keep it next to `quibt.env`.

Caddy terminates TLS for that name and talks to the supervisor over the internal network; the
supervisor still requires `SANDBOX_SUPERVISOR_TOKEN` on every `/computers` route. It binds
80/443, the same ports as the site's `public` profile — do not run both on one host.

In the app, paste the **https** endpoint and the same token. The endpoint is checked before it is
stored: `https` outside loopback, no RFC1918 / CGNAT / link-local literal, no `169.254.169.254`,
no embedded credentials, and a name that resolves into a private network is refused before any
socket is opened. **Testar máquina** now calls an authenticated route (`GET /computers/_probe`),
so a wrong token fails the test instead of failing every later boot.

**The screen does not cross a remote supervisor.** noVNC stays on that host's internal Docker
network, and the app's `/novnc` proxy only accepts loopback, RFC1918 and `quibt-bot-*` targets,
so a public supervisor's screen is unreachable. Commands, files and routines work; the screen
panel stays black. If you want the screen, install the whole stack on that host.

`SANDBOX_SCREEN_HOST` is the host clients use to reach a screen port, and
`SANDBOX_SCREEN_BIND_HOST` is the interface Docker publishes it on (`127.0.0.1` by default).
Set both in the supervisor's env file to reach a screen from another device on a **private**
network. When `SANDBOX_SCREEN_HOST` is set it wins over the internal Docker address. A published
noVNC port is guarded by an 8-character VNC password alone, so do not bind it to a public
interface.

### HTTPS on a VPS, with nobody's domain

`quibtbot install` on a machine with a public IP and free ports 80/443 makes the install
public by itself: it picks a name like `quibt-a1b2c3d4.203.0.113.9.sslip.io` — [sslip.io](https://sslip.io)
is a public DNS that resolves any `<label>.<ip>.sslip.io` to that IP — and starts a Caddy
container (Compose profile `public`) that obtains a Let's Encrypt certificate for that name and
renews it on its own. The phone gets `https://…` in the QR; the web and the API stay bound to
`127.0.0.1` on the host, so only Caddy faces the internet. You bring no domain, Quibt brings no
domain, and there is no relay in the middle.

Why a per-install label instead of the bare IP: Let's Encrypt limits certificates per exact
name, and providers recycle addresses. A fresh label never collides with whoever had the IP before.

The decision is printed during the `environment` step and is **fail-closed**: no public IP, or
80/443 already taken by another site or proxy, and the install stays on `127.0.0.1` and says why.
`quibtbot install --local` forces that even on a clean VPS. The chosen host is stored as
`QUIBT_PUBLIC_HOST` in `quibt.env` and survives reinstalls, so the address the phone saved and
the certificate keep working.

### HTTPS when the server itself runs in Box

The mobile and desktop Box wizards create or recover one persistent `noEnv` Box for the Quibt
server. The CLI initially talks to that VM on `http://127.0.0.1:5173`; that address is valid only
inside the Box and must never be handed to an iPhone. After installation, the wizard makes the web
port listen on `0.0.0.0`, runs Box's documented
[`host 5173 --public`](https://docs.ascii.dev/box/hosting), and receives a stable origin
like `https://<box-subdomain>-5173.on.ascii.dev`. Ascii terminates TLS and proxies that origin to
the Box's port 5173.

The origin is stored as `QUIBT_PUBLIC_PROXY_URL`, and `WEB_ORIGIN`, `BETTER_AUTH_URL`, and
`API_URL` are reconciled to the same value before API/web restart. The app renews the first-owner
invite inside the API container and probes `/rpc/health` through the public HTTPS route before it
shows **Criar minha conta**. Retrying with a saved Box id repairs that same VM in place; it does not
delete the disk or allocate another Box. This server VM is separate from any per-bot Boxes later
created through `SANDBOX_PROVIDER=box`.

### Your own domain, or an existing proxy

If you already run Traefik/Caddy/nginx on 80/443 (the install detected them and stayed local),
or you want your own name, put TLS in front of `:5173` and set:

```env
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
```

`WEB_ORIGIN` must be the origin the browser actually uses. Putting a third-party proxy in front
while `WEB_ORIGIN` stays on loopback is a **misconfiguration, not a shortcut**: a proxy on the same
host reaches the API over a loopback socket, so the deploy still looks local to it and the
loopback-only rule above stops protecting anything.

Cookies and CORS follow those origins. Registration is closed by default on every path
(`SIGNUPS_ENABLED=false` in `.env.example`, generated installs, and the database switch): only the
first owner gets in, through the installer code. To accept more accounts, set `SIGNUPS_ENABLED=true`
in `.env` and restart the API; keep `SIGNUP_ALLOWLIST` tight on a public host.
Set `TRUSTED_WEB_ORIGINS` to a comma-separated list only when additional browser origins must call the API. Production does not implicitly trust `localhost` or `127.0.0.1`.
Set `TRUSTED_PROXY_IPS` only to the transport addresses of reverse proxies that overwrite forwarding headers; forwarded client-IP headers are ignored for all other peers.

## Webhooks (waking a bot from another system)

Each bot can expose a webhook so an external system (GitHub, Stripe, your own script) wakes it with a task, without anyone opening the app. Set the deployment's public webhook URL in **Settings → Webhooks** or **Settings → Celular → Qualquer rede** (same owner-only HTTPS origin; a VPS uses that install's own domain, a PC needs a Cloudflare Tunnel or Tailscale Funnel the person configures and pays for themselves — Quibt provides, hosts, and sells no Cloud, relay, or tunnel for this). Behind a reverse proxy, also set `TRUSTED_PROXY_IPS` (above) so the per-IP `/hooks/*` rate limits key off the real client, not the proxy. Full request/response contract, headers, status codes, idempotency, and limits: [docs/webhooks.md](./webhooks.md).

Password reset and verification use Resend. Production requires `RESEND_API_KEY` by default. A billing-disabled self-host may explicitly set `AUTH_EMAIL_DISABLED=true`; reset and verification email will then be unavailable. Billing-enabled production cannot opt out.

Optional:

```env
SIGNUPS_ENABLED=true      # closed by default; true lets people beyond the first owner sign up
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker   # or e2b / box / daytona. Keep fake only for pnpm verify:fast.
AGENT_RUNTIME=pi          # Keep scripted only for pnpm verify:fast.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause the bot computer after 10 minutes idle
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
DATABASE_TRANSACTION_TIMEOUT_MS=30000 # Prisma interactive transaction deadline
DATABASE_POOL_MAX=16      # Postgres connections per process (API, worker)
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
BOX_API_KEY=              # when SANDBOX_PROVIDER=box
DAYTONA_API_KEY=          # when SANDBOX_PROVIDER=daytona
DAYTONA_API_URL=          # optional: self-hosted/custom Daytona API
DAYTONA_TARGET=           # optional: Daytona target/region
```

The two database values only matter on a busy or large install:

- `DATABASE_TRANSACTION_TIMEOUT_MS` is how long one Prisma transaction may take (default 30000).
  Prisma's own default of 5 s was too short to delete a bot or an account with a long history, and
  the transaction rolled back **after** the computer was already destroyed at the provider. Raise
  it if your database is large and those deletions still hit the deadline.
- `DATABASE_POOL_MAX` is how many Postgres connections each process opens (default 16; the `pg`
  driver ignores `max` in the connection URL, so this is the only way to change it). One
  connection is held by the wake-up `LISTEN` and a single chat screen can fire up to 7 queries at
  once. Raise it when many people use the app at the same time and queries start waiting; lower it
  when your Postgres has a tight `max_connections`, because every API and worker process opens up
  to this number.

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

## Choosing a computer provider

The catalog in onboarding and **Settings → Máquina** is the picker. After a tap, the app shows a plain-language guide (what to install, where the key lives, how bots share the computer). That copy is `machineGuideFor()` in `@quibt/core`. The long form is [computers.md](./computers.md); the first-run walkthrough is [onboarding.md](./onboarding.md). `SANDBOX_PROVIDER=desktop` is refused because a host process is not an OS sandbox.

- **Docker** is the trusted single-machine implementation: one resource-limited persistent container and home per workspace, plus one X11/noVNC/Chrome session per bot. With `SANDBOX_SCREEN_NETWORK=internal` — what the Compose stack sets — every workspace computer gets a dedicated Docker network separate from Postgres and the application network; without it the computer runs on Docker's default bridge, so set it on any host that also runs the database. Keep the supervisor private. Public or multi-user deployments should use E2B, Box, Daytona, or a remote supervisor on a dedicated VPS.
- **Remote supervisor / BYO VPS** — the supported way to use a VPS is to install the whole stack there (catalog recipes: Hetzner, DigitalOcean, generic `curl | bash` / cloud-init). Quibt does not provision or bill the VM. Pointing this deployment at a supervisor that runs on *another* host is opt-in on both sides, and it does not carry the screen — see **Supervisor on another host** below.
- **E2B** keeps its existing one-bot/one-sandbox behavior. Paste `E2B_API_KEY` in the UI (BYOK) or set it in `.env`. Workspace-wide shared files and multi-display sessions are currently the Docker path; they are not emulated by sharing a browser tab in E2B.
- **Box** (`SANDBOX_PROVIDER=box`, box.ascii.dev) gives each bot a persistent Ubuntu cloud VM with a virtual desktop, billed per second on **your** Box account. Paste `BOX_API_KEY` in the UI. User boxes are created with `noEnv: true`, so operator environment variables and credentials are never copied into them. Boxes are created without provider auto-stop; the `SANDBOX_IDLE_MS` scheduler stops (archives) idle boxes and they resume with their disk intact on the next message or Take control. Take control happens through the interactive noVNC desktop stream.
- **Daytona** (`SANDBOX_PROVIDER=daytona`) gives each bot a private sandbox from Daytona's default graphical image. Paste `DAYTONA_API_KEY` in the UI or set it in `.env`; hosted Daytona needs no other setting. `DAYTONA_API_URL` and `DAYTONA_TARGET` are optional for self-hosted/custom control planes and target selection. The panel uses a one-hour signed noVNC preview and Computer Use for input. Quibt stops idle sandboxes, starts the same id on demand, and deletes it when the bot is deleted.
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

4. Persist `DATA_DIR` (bot homes and the encrypted portable-computer snapshots under
   `workspace-checkpoints/`) and `ARTIFACTS_DIR` (files exchanged in the chat: screenshots, PDFs,
   spreadsheets, voice notes; defaults to `./data/artifacts`). Both are local filesystems today, so attach a
   volume. Object-storage-backed homes are not wired yet. See [workspace-checkpoint.md](./workspace-checkpoint.md).
5. Choose computers: **`SANDBOX_PROVIDER=e2b`** with `E2B_API_KEY`, **`SANDBOX_PROVIDER=box`** with `BOX_API_KEY`, or **`SANDBOX_PROVIDER=daytona`** with `DAYTONA_API_KEY` for a public or multi-user production service. Each bot keeps one sandbox id (`providerRef`) and a graphical desktop with a browser. Take control, sign in, then release — the bot keeps that session. Idle boxes pause after `SANDBOX_IDLE_MS` (default 10 minutes) and resume on the next message or Take control. Docker remains the local and trusted single-machine default.
6. A Hetzner CX22 (2 vCPU / 4 GB) is enough for API + worker + Postgres when E2B owns the desktops. 2 GB works for a quiet box; 8 GB is only needed if you also run Docker computers on that same machine.
7. Set public HTTPS `WEB_ORIGIN` / `BETTER_AUTH_URL` / `API_URL`, secrets, and an OpenRouter (or other Pi) deployment key if you want to skip per-user model keys.
8. Put the web app behind the same origin as `/api`, `/rpc`, `/files`, and `/hooks` (the bundled Node server already proxies them; an outer reverse proxy may front it). Docker noVNC connections use short-lived signed `/novnc/*` capabilities; do not replace that route with an unrestricted port proxy.
9. Deploy `apps/www` and point the product origin at your API/web host.
10. Turn on `SIGNUP_ALLOWLIST` until you want open registration. Users bring an OpenRouter key or a subscription. Keep `BILLING_ENABLED=false`.

Expo / desktop installers are clients of that origin (`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_WEB_ORIGIN`, `QUIBT_WEB_URL`). The Android build permits cleartext at the OS layer so loopback and Tailscale's encrypted `100.64.0.0/10` overlay can work, but `normalizeApiBase` rejects ordinary LAN and public HTTP origins by default. Plain RFC1918 HTTP is available only in an explicit development build with `EXPO_PUBLIC_ALLOW_INSECURE_LAN=true`. iOS uses `NSAllowsLocalNetworking`. Use a valid HTTPS origin for every VPS or internet-facing deployment. Manually entered endpoints must answer the Quibt health probe; QR/deep links show the exact destination and require explicit confirmation before changing the phone's saved API. The screen URL is issued only to the live control-lease holder.

E-mail verification needs `RESEND_API_KEY`. Without a mailer, password reset still works on the machine itself: `POST /api/local/reset-link` answers only to loopback and only when no mailer is configured, and the browser on that computer shows the link at **Esqueceu a senha?**. Do not expose that route through a reverse proxy.
