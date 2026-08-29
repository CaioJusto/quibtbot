# Quibt Bot desktop (local-first)

The Mac `.dmg`, Windows installer, and Linux AppImage wrap the same web UI in Electron. Work still runs on **your** machine: Postgres, API, worker, and the bot computer (Docker by default).

**Onde o Quibt fica ligado?** This machine, by default: the desktop app boots the same
Postgres/API/worker stack a source checkout would, on the computer you installed it on.
**Onde os bots trabalham?** Docker on that same machine unless you pick E2B, Box, or a VPS in
onboarding — a separate choice from where the server itself runs. See
[`docs/architecture.md`](./architecture.md).

Public site: [quibt.com.br](https://quibt.com.br).

## Download

Landing buttons point at GitHub Releases. The release attaches only the stable names
(`DESKTOP_ARTIFACT_NAMES` in `scripts/release-version.mjs`); the version lives in the tag, so the
URL is `https://github.com/CaioJusto/quibtbot/releases/download/v<version>/<name>`:

- macOS Apple silicon: `QuibtBot.dmg` — on `v0.2.16`, check the attached `signing-status-mac.json`; until the CI build is replaced by the notarized build, macOS warns the first time, **right-click → Open**
- macOS Intel: no installer yet; run from source (`pnpm dev` + `pnpm desktop`)
- Windows 64-bit: `QuibtBot-setup.exe` — unsigned test installer (one-click NSIS, no admin); SmartScreen warns, choose **More info → Run anyway**; install Docker Desktop yourself
- Linux x64: `QuibtBot.AppImage` — unsigned test build; needs `libfuse2`, mark it executable and run it; install Docker (Engine or Desktop) yourself

The sentence shown next to each button comes from `DESKTOP_SIGNING` in
`packages/installer/src/compose.ts` (site, README and this page follow it). It is filled at
release time from the `signing-status-*.json` files attached to the tag — see the gate in
[`release-readiness.md`](./release-readiness.md#release-rule).

Until a release is published, build the artifacts locally (below) and open the installer from `apps/desktop/out/`.

## Run from source

```bash
cp .env.example .env
# set BETTER_AUTH_SECRET and ENCRYPTION_KEY
docker compose -f infra/compose/docker-compose.yml up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
```

In another terminal:

```bash
pnpm desktop
# or
pnpm dev:desktop
```

`QUIBT_WEB_URL` (default `http://127.0.0.1:5173`) is the origin the window loads.

Those two secrets are enough for `pnpm dev`, where Compose only starts Postgres. Running the whole
stack in Compose is different: the services pin `NODE_ENV=production`, so the boot refuses a
missing secret and any value still starting with `replace-with-`, and it also needs
`SANDBOX_SUPERVISOR_TOKEN`, `BOOTSTRAP_SECRET`, and either `RESEND_API_KEY` or
`AUTH_EMAIL_DISABLED=true`. The full list is step 1 of
[`self-host.md`](./self-host.md). The packaged installer writes all of them for you.

The app icon is the Quibt mascot on the blue field (`apps/desktop/assets/icon.png`, macOS squircle in `icon-macos.png` / `icon.icns`, Windows `icon.ico`), generated from `apps/mobile/assets/icon.png` so every platform ships the same mark. The window is the same signed-in product as the web app: inbox of bots, thread, computer panel, plugins, and account. The desktop chrome uses glass header pills, a growing composer (Enter sends, Shift+Enter newline, Enter while the bot works queues the next message), right-click menus with icons, and shortcuts — `⌘K` / `Ctrl+K` search bots, groups and actions, `⌘N` / `Ctrl+N` new bot, `⌘1–9` jump, `⌘⇧[` / `⌘⇧]` previous/next. `⌘K` works from inside the composer too: arrows move, Enter opens, Esc closes. Characters stay the Quibt mascots.

## Pack installers

```bash
pnpm desktop:pack:mac
pnpm desktop:pack:win
pnpm desktop:pack:linux
pnpm desktop:pack
```

These run through Node (`scripts/pack-desktop.mjs`), so they work in macOS Terminal, Windows PowerShell/cmd, and Linux. Outputs land in `apps/desktop/out/`. The pack script also writes the stable names the landing uses (`QuibtBot.dmg`, `QuibtBot-setup.exe`, `QuibtBot.AppImage`).

## Host OS vs bot computer

| Layer                             | macOS                       | Windows                     | Linux                       |
| --------------------------------- | --------------------------- | --------------------------- | --------------------------- |
| Desktop app (Electron)            | Apple silicon `.dmg`        | 64-bit NSIS                 | x64 AppImage                |
| Local stack (`pnpm dev` + Docker) | Docker Desktop              | Docker Desktop (WSL2)       | Docker Engine / Desktop     |
| Bot computer                      | Linux container or cloud VM | Linux container or cloud VM | Linux container or cloud VM |

The bot does **not** click your host desktop. Navigation inside the computer pane is a Linux graphical session (Xvfb + noVNC + Chromium + xdotool). That is not [Cua](https://cua.ai/) / `cua-driver`. Cua is a native Mac/Windows/Linux computer-use driver; Quibt keeps the agent inside a Linux VM so the same computer works from any host OS.

## Signing and notarization

| Platform | Release status                                                                                                                  | What is still missing                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | The `v0.2.16` pipeline first creates an unsigned Apple-silicon `QuibtBot.dmg`. The final status is the attached `signing-status-mac.json`. The `v0.2.14`, `v0.2.10` and `v0.2.9` DMGs are Developer ID signed, notarized and stapled. | Replace the `v0.2.16` DMG, `signing-status-mac.json` and checksums with the notarized build, then set `DESKTOP_SIGNING.mac` to `true`. Intel (x64) is not published; Apple silicon only. |
| Windows  | `QuibtBot-setup.exe` is published as an **unsigned test build**; `signing-status-win.json` says `signed: false`. SmartScreen warns: **More info → Run anyway**. | Authenticode certificate. Until it exists, SmartScreen calls the installer an unknown publisher.              |
| Linux    | `QuibtBot.AppImage` is published as an **unsigned test build**; `v0.2.16` also ships the x64/arm64 `quibtbot` CLI binaries for server installs.   | No store signature. Needs `libfuse2`; mark the download executable before running it; Docker Engine or Desktop is installed by the user. |

For a maintainer release on macOS, the project-local hooks sign both the app and DMG, submit each
to Apple, wait for acceptance, and staple the tickets:

```bash
CSC_NAME='Caio Justo (9Q372SFRM8)' \
QUIBT_NOTARIZE=1 \
QUIBT_NOTARY_PROFILE=quibt-notary \
node scripts/pack-desktop.mjs mac
```

The Electron builder's built-in notarizer remains disabled because the project hooks also verify
the DMG container and write `out/signing-status.json`. Never describe a different build as signed
or notarized unless its attached status and Gatekeeper checks confirm it.

## First launch

1. Open Quibt Bot. On macOS the setup wizard detects Docker Desktop, Colima and Homebrew outside Finder's reduced `PATH`. If Docker is truly absent, the wizard downloads the official DMG for the Mac architecture, validates Docker Inc.'s code signature and Apple notarization, asks for administrator authorization once, launches Docker and waits for the daemon before continuing. Windows still requires Docker Desktop and Linux requires Docker Engine/Desktop.
2. The wizard generates secrets and runs Compose when the compose file is available (source checkout or bundled `extraResources`). Images already on this machine are skipped, so the free-space check, the announced size and the “image 2 of 4” counter only ever describe what is still missing (10 GB free is required only when nothing is downloaded yet, never less than 2 GB). It shows a progress bar per image (layers done/total) and, because `docker pull` without a TTY prints nothing while a layer transfers, a heartbeat every 10 s (“baixando a camada 3 de 9 há 1m20s…”). A download is only given up on after 15 minutes with no output at all (one hour per image, absolute) and is retried up to three times; already-downloaded layers stay cached, so re-running the wizard only fetches what is missing. `quibtbot update` downloads with the same progress, patience and retries. You can also point `QUIBT_WEB_URL` at a remote deploy.
3. **Second launch.** When the stack is installed but stopped (after a reboot, or after quitting Docker), the app does not show the install wizard again: it opens Docker Desktop if needed, downloads any image that disappeared (a “Clean / Purge data”, a `docker system prune -a`) with the same progress bar, runs `docker compose up --wait` itself and shows “Ligando o Quibt Bot…” with the current step, then opens the product. Restarting never installs Docker Desktop and never asks for the Mac password: if Docker Desktop is gone, the screen says so and goes back to install mode with the button and the Docker terms in sight. If it fails for another reason, the real error and a **Tentar de novo** button appear. `quibtbot install` on a machine that is already installed does the same and prints “já instalado e no ar em <URL>”.
4. Sign up, bring an OpenRouter key, a local Ollama / OpenAI-compatible URL, or a ChatGPT / Copilot / SuperGrok subscription. Pick the machine (Docker, your VPS, E2B, Box) in onboarding or **Settings → Máquina**. Each choice opens a short guide: what to install, where to copy the key, and whether bots share one computer or each get their own. See [onboarding.md](./onboarding.md) and [computers.md](./computers.md).
5. Connect the phone. **Settings → Celular** shows a QR with the server URL (`quibt://connect?api=…`), and a **Liberar entrada por 2 minutos** button. Press it and the QR also carries a one-time pairing code, so the phone signs in without a password; leave it unpressed and the QR only points the phone at this server, which then asks for the account. The code is minted from the session on this computer, expires in two minutes, works once, and dies when the screen closes. The phone talks to that API — not to the Electron window. On this computer the private QR uses the machine's Tailscale address, so the HTTP hop stays inside the encrypted tailnet; ordinary same-Wi-Fi HTTP is not advertised. **Qualquer rede** puts a user-owned HTTPS origin in the QR instead — a Cloudflare Tunnel or Tailscale Funnel you run yourself, pointed at `http://127.0.0.1:5173` (the Quibt window, which already proxies `/api`, `/rpc` and `/novnc`). Quibt does not host or sell that tunnel; if it is paid, you pay the provider. The laptop still has to stay on. If the Quibt server runs on a VPS, remote supervisor, or Box VM — not on this laptop — the phone keeps working when the laptop is off, without a tunnel.

### How the app signs you in

The window shows the same signed-in product the browser shows, so it needs a session. On the
machine that runs the stack the app gets one by itself, by proving it holds the local secret — not
by its position on the network:

- The app reads `BETTER_AUTH_SECRET` from the local `quibt.env`, derives a key used for this one
  job (label `quibt-bot/desktop-local-session/v1`), and signs a short capability. It travels in the
  `x-quibt-desktop-session` header, only on `POST /api/local/session`, and only when the window
  points at a loopback origin.
- The capability lives for one minute, works once, and is tied to that method and that path. A
  value copied from disk and replayed later is refused.
- With no `quibt.env`, or no `BETTER_AUTH_SECRET` inside it, the app sends no header, the API
  answers `404`, and the app falls back to the normal sign-in screen. That is deliberate: it never
  invents trust it cannot prove.
- Pointed at a remote server (`QUIBT_WEB_URL` of a VPS), the app sends nothing derived from this
  machine's secret. You sign in there like any other client.

The network path stays loopback-only. If the install itself is not loopback — a LAN address or a
public origin — `POST /api/local/session` does not exist at all (`404`) for every client, and entry
is by password or by a pairing code minted on a device that is already signed in. A neighbour on
the same Wi-Fi reaches a published API port with the same source address as the owner's browser, so
an address on its own is never accepted as proof of who is at the keyboard.

Keys are separated by job. `BETTER_AUTH_SECRET` signs the session cookie only; the bot screen, the
internal web→API proxy and this desktop capability each use a key derived from it under their own
label, so a leaked screen URL is not an oracle for the session key.

The desktop app does **not** run model commands as your macOS, Windows, or Linux user unless you explicitly choose the `desktop` sandbox (refused in production). Default local computer is Docker.

## Uninstall

Dragging the app to the Trash leaves the Docker containers, the bot computers, ~10 GB of images
and the data directory behind — and the next launch finds the install state complete, so the
app relaunches that stack by itself instead of showing the setup wizard. Use **Quibt Bot → Desinstalar o Quibt Bot…** instead: it
confirms once, offers to keep your data (database and bot homes) and/or the Docker images for
a faster reinstall, removes everything else the installer created (`docker compose down --volumes`, containers labelled
`quibt.managed=true`, `ghcr.io/quibt/*` images, `~/Library/Application Support/Quibt Bot`),
moves the app to the Trash and quits. Docker stays. Headless installs do the same with
`quibtbot uninstall` ([self-host.md](./self-host.md#uninstall)).
