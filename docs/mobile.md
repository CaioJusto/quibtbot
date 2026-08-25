# Mobile (Expo)

`apps/mobile` is an Expo Router app (iOS + Android) and a client of the same API as web and
Electron — it never runs agent commands on the phone itself.

Two questions frame every screen in this guide, the same as the rest of the product:
**Onde o Quibt fica ligado?** (where the server — API/worker/Postgres — runs: this computer,
your VPS, or a Box VM) and **Onde os bots trabalham?** (where each bot's own computer runs:
Docker, a remote supervisor, E2B, or Box). The phone can connect to a server on any host and,
independently, the bots on that server can use any computer provider.

See [`docs/architecture.md`](./architecture.md) for the full system picture and
[`docs/onboarding.md`](./onboarding.md) for the non-technical walkthrough this app implements.

## Local development

```bash
cp .env.example .env
docker compose -f infra/compose/docker-compose.yml up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev              # API :3100, worker, web :5173, supervisor :7091
```

In another terminal:

```bash
pnpm --filter @quibt/mobile start
```

Scan the QR with Expo Go for a quick UI check, but Expo Go cannot load the native SSH module
(see [EAS / native-SSH requirement](#eas--native-ssh-requirement) below) — remote install over
SSH only works in a custom dev client or a production build. On a physical device, prefer the
computer's Tailscale address (`EXPO_PUBLIC_API_URL=http://100.x.y.z:3100`): the HTTP hop is
inside the encrypted tailnet, while `127.0.0.1` on the phone is the phone itself, not your
laptop. Plain Wi-Fi HTTP is rejected by default. A developer who deliberately needs it can set
both `EXPO_PUBLIC_API_URL=http://<your-lan-ip>:3100` and
`EXPO_PUBLIC_ALLOW_INSECURE_LAN=true` in a development build; never ship that opt-in. Outside
the tailnet, the QR can carry a user-owned HTTPS origin (Cloudflare Tunnel or Tailscale Funnel pointed at
`http://127.0.0.1:5173`, saved from **Settings → Celular → Qualquer rede**). The phone still
probes `/rpc/health` before switching servers.

## Server setup (bringing a server online)

`apps/mobile/lib/server-setup.ts` is the pure catalog of **server** hosts the app can walk
someone through installing — deliberately `"local" | "vps" | "box"`. **E2B is never in this
list**: E2B only ever isolates a bot's desktop, never the API/worker/Postgres, so it cannot
appear as a place to "bring the server online."

The command is aimed at the **destination** machine, never at the phone: a VPS gets
`bootstrapCommand("linux")` (download the Linux `quibtbot` binary, run
`quibtbot install --non-interactive --show-sensitive`), and "my own computer" gets
`INSTALL_SCRIPT_COMMAND` — the `curl …/scripts/install.sh | sh` one-liner the website shows,
which detects Mac/Linux and the CPU, verifies the SHA-256 and runs `quibtbot install`.
Running either prints a pairing URL, a short code, and a deep link/QR, which is what the
claim below consumes. The long "how it works / what it costs" guide sits behind a toggle on
that screen; the first thing the person sees is the question, the choice and the action.

The welcome screen itself is one sentence, one primary button (scan the computer's QR, or
create the account when a Quibt is already reachable), a "Tenho um código" link and three
short rows (VPS from the phone, install on my computer, type the URL). Sign-up asks only
for a name — there is no e-mail or password anywhere in the app; a phone that is not the
first owner goes to the code screen.

## QR / code claim

Two ways to join an existing install without ever typing a password:

1. **Deep link** — `parseBootstrapDeepLink(raw)` parses
   `quibt://bootstrap?api=…&token=…` from a scanned QR or tapped link. The app shows the exact
   destination host; only `confirmBootstrapLink(raw)` saves it after the person taps
   **Confiar neste servidor**.
2. **Manual code** — `claimInstallation(apiBase, code)` posts the short human code to
   `/api/bootstrap/claim`; the server exchanges it for the same enrollment token.

After explicit confirmation, either path calls `saveEnrollmentToken`, which writes to SecureStore, then routes to
`/sign-up`. The token is one-time, expires in minutes, and is never persisted anywhere else
(no cookie, no AsyncStorage, no analytics).

## SecureStore

Every credential the app holds lives in the OS keychain (`expo-secure-store`), never in
AsyncStorage or a cookie a web view could read:

| Key                                                 | Module                          | Contents                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quibt.session_token`                               | `lib/session.ts`                | The signed-in session token (cached in memory too, since every request would otherwise round-trip the keychain).                                                                                                                           |
| `quibt.bootstrap_enrollment`                        | `lib/bootstrap-pairing.ts`      | The one-time enrollment token from QR/code claim, cleared once sign-up succeeds or fails terminally.                                                                                                                                       |
| `quibt.infra.<sha256(host)>` + `quibt.infra._index` | `lib/infrastructure-secrets.ts` | SSH passwords/private keys and Box API keys used for _remote install_, keyed by a hash of the host so the host name itself never sits in a SecureStore key. Reads/writes require Face ID/biometric unlock (`requireAuthentication: true`). |
| `quibt.expo_push_token`                             | `lib/push.ts`                   | The last Expo push token registered with the server, so a rotated token can be unregistered.                                                                                                                                               |

A keychain read failure (corrupt entry, biometric revoked) is treated as "reauth required" and
the stale entry is deleted, never silently reused.

## Remote install security

Installing the server over SSH (or Box) from the phone follows a strict verify-then-connect
order, implemented in `lib/remote-installer.ts` / `lib/ssh-transport.native.ts` /
`lib/box-install-transport.ts`:

1. **Inspect first.** The transport fetches the target's host key fingerprint before any
   credential is sent.
2. **Pin and confirm.** The fingerprint is shown to the user; `connect(expectedFingerprint)`
   refuses to proceed on a mismatch (`fingerprintsMatch`), closing the transport instead of
   silently downgrading.
3. **Credentials only after verification.** `attachCredential` defers loading the
   password/private key until the fingerprint check passes, so a spoofed host never receives
   a secret.
4. **Redact everything that streams back.** `sanitizeInstallerEvent` / `redactInstallerText`
   scrub every installer log line and event message for the loaded secrets before they reach
   the UI, and `parseInstallerOutput` drops lines that look like tokens, deep links, or QR SVG
   markup outright rather than displaying them.
5. **Digest-verified bootstrap.** The remote shell script the transport runs
   (`buildRemoteBootstrapShell`) checks the downloaded `quibtbot` binary's digest before
   executing it.
6. **Box stays `noEnv`.** The Box transport allocates VMs with `noEnv: true`, so the
   operator's own Quibt secrets never enter the VM it just created — a different guarantee
   from the SSH transport, whose target already belongs to the user pairing it.

## EAS / native-SSH requirement

`@dylankenneally/react-native-ssh-sftp` is a native module (`ssh-transport.native.ts`) that is
**not** part of Expo Go's prebuilt binary. It only links into a custom dev client or a
production build produced by `eas build` (`apps/mobile/eas.json`). Two consequences:

- In Expo Go, `loadNativeModule()` returns `null` and remote SSH install is unavailable; the
  web build falls back to `ssh-transport.web.ts` (browser-only, used by `apps/www`'s desktop
  install wizard, not the phone).
- Anyone testing SSH-based remote install on-device needs `eas build --profile development`
  (or `preview`/`production`) at least once after adding or upgrading that dependency, because
  Expo's autolinking only re-runs inside a native build, not inside Expo Go.

Box-based remote install (`box-install-transport.ts`) has no native dependency and works the
same in Expo Go and a native build, since it only calls the Box HTTP API.

## Push notifications

`lib/push.ts` registers an Expo push token after notification permission is granted:
`registerPushToken()` reads the EAS project id (`EXPO_PUBLIC_PROJECT_ID` or
`Constants.easConfig`/`expoConfig.extra.eas.projectId`), calls
`Notifications.getExpoPushTokenAsync`, and sends it to the server via the
`notifications/registerPush` RPC. The previous token (from SecureStore) is unregistered on
rotation so the server never keeps a token nobody can push to. `unregisterPushToken()` runs on
sign-out. A tapped notification's `botId` (`notificationTarget`) opens `/thread` for that bot
directly.

## Computer WebView

`app/computer.tsx` embeds the bot's live screen in a `react-native-webview` pointed at a
signed, short-lived `/novnc/<host>/<port>/<expiresAt>.<sig>` capability URL — the same
capability scheme web and Electron use, never a raw unrestricted port. `lib/computer.ts` holds
the pure logic the screen depends on: `decideScreenUrl` pins the WebView to its current URL
while a session is live (so the 2-second status poll's fresh signature does not force a
reload mid-session) and only swaps/renews when the screen isn't mounted or the capability is
near expiry; `screenBridgeMessage` parses the embedded page's `postMessage` payloads
(`quibt.screen.connected` / `quibt.screen.disconnected`); and `planScreenReconnect` backs off
exponentially (capped at `SCREEN_RECONNECT_MAX_MS`, giving up after
`SCREEN_RECONNECT_LIMIT` attempts) instead of hammering a sandbox that keeps dropping. Taking
control routes pointer/keyboard events through the same RPCs the web app uses; releasing
control returns to read-only streaming.

## Plugins / connections

The phone connects Gmail, Slack and the rest of the Composio catalog itself. It does not
bounce through the website.

`connections.begin` asks Composio to return to `quibt://plugins/callback` (or Expo Go's
`exp://…/--/plugins/callback`). The login opens in an in-app browser session
(`expo-web-browser`); when that session finishes — or when the app comes back to the
foreground — the screen polls `connections.complete` with the same helper the web overlay
uses. Leaving the screen cancels the poll.

The web page at `/plugins/callback?app=1` is only a fallback. If someone still lands there,
it opens the native deep link on its own.

RPC calls retry twice on a dropped network or a 502/503. A 401 is not retried: the stored
session is already gone.

## Test commands

```bash
pnpm --filter @quibt/mobile test    # vitest over apps/mobile/lib — no device/emulator needed
pnpm --filter @quibt/mobile check   # tsc --noEmit
pnpm e2e:mobile                     # apps/mobile e2e — scripted/fake providers, no phone/Expo Go
```

`pnpm e2e:mobile` runs `apps/mobile/e2e/bootstrap-flow.e2e.test.ts` and friends against the
real API/worker with `AGENT_RUNTIME=scripted` and `SANDBOX_PROVIDER=fake`, isolated from the
ambient dev API port — no Maestro, Detox, or Expo Go required.
