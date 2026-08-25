import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { MAX_WORKSPACE_SESSIONS } from "./computer-spec.js";

export type SupervisorErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

/** Error whose message is safe to return to the caller. */
export class SupervisorError extends Error {
  readonly status: SupervisorErrorStatus;

  constructor(message: string, status: SupervisorErrorStatus = 400) {
    super(message);
    this.name = "SupervisorError";
    this.status = status;
  }
}

/**
 * Docker, filesystem and network failures carry host paths and socket names, so only
 * errors raised by the supervisor itself are echoed back to the caller.
 */
export function publicError(error: unknown): {
  status: SupervisorErrorStatus;
  message: string;
} {
  if (error instanceof SupervisorError) return { status: error.status, message: error.message };
  return { status: 500, message: "computer request failed" };
}

/**
 * Compares SHA-256 digests so tokens of different lengths never reach timingSafeEqual
 * (which throws) and no comparison short-circuits on length.
 */
export function isAuthorizedSupervisorRequest(
  authorization: string | undefined,
  token: string,
): boolean {
  if (!token) return false;
  const separator = (authorization ?? "").indexOf(" ");
  if (separator < 0) return false;
  const scheme = (authorization ?? "").slice(0, separator);
  const supplied = (authorization ?? "").slice(separator + 1).trim();
  if (scheme.toLowerCase() !== "bearer" || !supplied) return false;
  const expected = createHash("sha256").update(token, "utf8").digest();
  const candidate = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expected, candidate);
}

// ── Docker endpoint ──────────────────────────────────────────────────────────
// The supervisor used to hardcode `/var/run/docker.sock`. On macOS that file does not
// exist: Docker Desktop, Colima, Rancher Desktop and Podman each publish their own socket
// and the CLI finds it through `DOCKER_HOST` or the active context. The product ships
// "self-host with Docker by default", so the first thing a Mac owner met was a raw ENOENT
// from dockerode while `docker ps` worked fine.

export type DockerEndpointOptions =
  | { socketPath: string }
  | { host: string; port: number; protocol: "http" | "https" };

export interface DockerEndpoint {
  /** Which setting decided this, for the boot error message. */
  source: "DOCKER_HOST" | "DOCKER_SOCKET" | "auto";
  /** Human readable endpoint, e.g. `unix:///var/run/docker.sock`. */
  description: string;
  options: DockerEndpointOptions;
}

export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

/** Sockets to look for when nothing was configured, in the order the CLI would find them. */
export function dockerSocketCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? "";
  const runtimeDir = env.XDG_RUNTIME_DIR ?? "";
  const candidates = [DEFAULT_DOCKER_SOCKET];
  if (home) {
    candidates.push(
      `${home}/.docker/run/docker.sock`, // Docker Desktop (macOS)
      `${home}/.colima/default/docker.sock`, // Colima
      `${home}/.rd/docker.sock`, // Rancher Desktop
    );
  }
  if (runtimeDir) candidates.push(`${runtimeDir}/podman/podman.sock`); // Podman rootless
  return candidates;
}

function endpointFromUrl(raw: string, source: DockerEndpoint["source"]): DockerEndpoint {
  const value = raw.trim();
  const unix = /^(unix|fd):\/\/(.+)$/.exec(value);
  if (unix?.[2]) {
    return {
      source,
      description: `unix://${unix[2]}`,
      options: { socketPath: unix[2] },
    };
  }
  const tcp = /^(tcp|http|https):\/\/([^/:]+)(?::(\d+))?\/?$/.exec(value);
  if (tcp?.[2]) {
    const protocol = tcp[1] === "https" ? "https" : "http";
    const port = Number(tcp[3] ?? (protocol === "https" ? 2376 : 2375));
    return {
      source,
      description: `${tcp[1]}://${tcp[2]}:${port}`,
      options: { host: tcp[2], port, protocol },
    };
  }
  if (value.startsWith("/")) {
    return {
      source,
      description: `unix://${value}`,
      options: { socketPath: value },
    };
  }
  throw new Error(
    `${source}="${raw}" is not a Docker endpoint this supervisor understands. Use unix:///path/to/docker.sock or tcp://host:2375.`,
  );
}

/**
 * `DOCKER_HOST` first (the official knob), then `DOCKER_SOCKET` (ours), then every socket
 * that exists on disk. More than one can exist at once — a machine that ran Docker Desktop
 * and now runs Colima keeps both files — so the caller pings them in order and uses the
 * first daemon that actually answers.
 */
export function dockerEndpointCandidates(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): DockerEndpoint[] {
  const dockerHost = env.DOCKER_HOST?.trim();
  if (dockerHost) return [endpointFromUrl(dockerHost, "DOCKER_HOST")];
  const configured = env.DOCKER_SOCKET?.trim();
  if (configured) return [endpointFromUrl(configured, "DOCKER_SOCKET")];
  const found = dockerSocketCandidates(env).filter((candidate) => exists(candidate));
  const sockets = found.length ? found : [DEFAULT_DOCKER_SOCKET];
  return sockets.map((socketPath) => ({
    source: "auto" as const,
    description: `unix://${socketPath}`,
    options: { socketPath },
  }));
}

/** The endpoint the supervisor tries first; also what a boot failure names. */
export function resolveDockerEndpoint(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): DockerEndpoint {
  const [first] = dockerEndpointCandidates(env, exists);
  if (!first) throw new Error("no Docker endpoint to try");
  return first;
}

/** Boot-time diagnosis: say what was tried and how to fix it, never a bare ENOENT. */
export function dockerUnreachableMessage(
  endpoint: DockerEndpoint,
  env: NodeJS.ProcessEnv,
  detail?: unknown,
): string {
  const reason = detail instanceof Error ? detail.message : detail ? String(detail) : "no answer";
  const tried =
    endpoint.source === "auto"
      ? `Looked for: ${dockerSocketCandidates(env).join(", ")}.`
      : `From ${endpoint.source}.`;
  return [
    `The sandbox supervisor cannot reach the Docker daemon at ${endpoint.description} (${reason}).`,
    tried,
    "Start Docker, or point the supervisor at the endpoint your CLI uses:",
    '  docker context inspect --format "{{.Endpoints.docker.Host}}"',
    "  export DOCKER_HOST=unix:///Users/you/.colima/default/docker.sock",
  ].join("\n");
}

const BASE_EXEC_ENV = [
  "HOME=/home/quibt",
  "PATH=/home/quibt/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "NPM_CONFIG_PREFIX=/home/quibt/.local",
  "PIP_USER=1",
];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_EXEC_ENV_VARS = 64;
export const SESSION_UID_BASE = 10_000;

export function sessionUser(display: number): string {
  if (!Number.isInteger(display) || display < 1 || display > MAX_WORKSPACE_SESSIONS) {
    throw new SupervisorError(`display must be 1..${MAX_WORKSPACE_SESSIONS}`);
  }
  return `${SESSION_UID_BASE + display}:1000`;
}

export function sessionRuntimeDir(display: number): string {
  sessionUser(display);
  return `/run/quibt/sessions/${display}`;
}

/** Preparation state must live beside, never inside, the sandbox-writable home. */
export function homePreparationMarker(root: string, name = "home"): string {
  return path.join(path.dirname(root), `.quibt-${name}-prepared`);
}

/**
 * DISPLAY belongs to the session, never to the request: workspace mates share one
 * container, so an attacker-supplied DISPLAY would drive another bot's screen.
 */
export function execEnvEntries(
  env: Record<string, string> | undefined,
  display: number | undefined,
): string[] {
  const entries = Object.entries(env ?? {});
  if (entries.length > MAX_EXEC_ENV_VARS) {
    throw new SupervisorError(`at most ${MAX_EXEC_ENV_VARS} environment variables are allowed`);
  }
  const extra: string[] = [];
  for (const [key, value] of entries) {
    if (!ENV_NAME.test(key)) throw new SupervisorError(`invalid environment variable name`);
    if (key === "DISPLAY") continue;
    extra.push(`${key}=${value}`);
  }
  return [
    ...BASE_EXEC_ENV,
    ...(display
      ? [`DISPLAY=:${display}`, `XAUTHORITY=${sessionRuntimeDir(display)}/Xauthority`]
      : []),
    ...extra,
  ];
}

export function sandboxTimeoutCommand(argv: string[], timeoutMs: number) {
  return ["/usr/bin/timeout", "--kill-after=1s", `${timeoutMs / 1_000}s`, ...argv];
}

/** Files created by one session stay editable by the other bots in the shared workspace. */
export function withGroupWritableUmask(argv: string[]): string[] {
  return ["bash", "-lc", 'umask 0002; exec "$@"', "quibt-exec", ...argv];
}

/** Rejects NUL bytes, which cannot cross the exec boundary intact. */
export function assertExecArgv(argv: string[]): string[] {
  for (const arg of argv) {
    if (arg.includes("\u0000")) throw new SupervisorError("invalid command argument");
  }
  return argv;
}

/** Bash probe that lists `<botId> <display>` for every live session in the container. */
export const SESSION_PROBE_COMMAND = [
  "bash",
  "-lc",
  // O pidfile sobrevive ao container (a home é bind mount); num container novo o número
  // pode ser de outro processo. Só um Xvfb vivo naquele pid conta como sessão.
  'for d in /quibt-desktops/*/; do [ -f "$d/session.pid" ] || continue; p=$(cat "$d/session.pid" 2>/dev/null); [ -n "$p" ] || continue; kill -0 "$p" 2>/dev/null || continue; [ "$(cat /proc/$p/comm 2>/dev/null)" = Xvfb ] || continue; echo "$(basename "$d") $(cat "$d/display" 2>/dev/null)"; done',
];

/**
 * Can the container's own user write its home?
 *
 * The workspace home is a bind mount, so its ownership comes from the host. The supervisor chowns
 * it to uid 1000 before starting the box, but a supervisor running as a normal user (every macOS
 * self-host, where the daemon lives in a VM) is not allowed to chown and the call fails. The
 * container then cannot create `~/.local` and the graphical session dies reporting
 * "framebuffer failed", which says nothing about permissions.
 */
export const HOME_WRITABLE_PROBE = [
  "bash",
  "-lc",
  "mkdir -p /home/quibt/.local/share 2>/dev/null && test -w /home/quibt && echo writable || echo blocked",
];

/** Preferred root-side repair when the Docker filesystem permits ownership changes. */
export const HOME_REPAIR_COMMAND = ["chown", "-R", "1000:1000", "/home/quibt"];

/**
 * Docker Desktop/Colima can expose a bind mount whose uid is immutable even for container root.
 * The workspace is already isolated per deployment and workspace, so grant the computer user a
 * writable fallback without changing which host path is mounted.
 */
export const HOME_MODE_REPAIR_COMMAND = ["chmod", "-R", "a+rwX", "/home/quibt"];

export function homeIsWritable(probeOutput: string): boolean {
  return probeOutput.includes("writable");
}

export const HOME_NOT_WRITABLE_MESSAGE =
  "the workspace home is not writable by the computer user (uid 1000) and could not be repaired";

type BindMount = {
  Destination?: string;
  Source?: string;
  RW?: boolean;
};

/** Prevents one checkout or DATA_DIR from adopting a same-labelled container from another one. */
export function containerUsesWorkspaceHome(
  mounts: BindMount[] | undefined,
  expectedHomePath: string,
  expectedDesktopPath?: string,
): boolean {
  const expected = path.resolve(expectedHomePath);
  const homeMatches = ["/home/quibt", "/workspace"].every((destination) => {
    const mount = mounts?.find((candidate) => candidate.Destination === destination);
    return (
      mount?.RW !== false && Boolean(mount?.Source) && path.resolve(mount!.Source!) === expected
    );
  });
  if (!homeMatches || !expectedDesktopPath) return homeMatches;
  const desktop = mounts?.find((candidate) => candidate.Destination === "/quibt-desktops");
  return (
    desktop?.RW !== false &&
    Boolean(desktop?.Source) &&
    path.resolve(desktop!.Source!) === path.resolve(expectedDesktopPath)
  );
}

/**
 * `quibt-session start` answers `started display=N ...` or `already-running display=N`. The
 * container is the authority: when a session is already up, the display it reports wins over the
 * one the supervisor asked for, otherwise the screen URL points at a port nobody serves.
 */
/** Bot ids are cuids; anything else must not reach a shell interpolation. */
export const SESSION_BOT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * A API liga o computador compartilhado sob este id, não sob o de um bot: é o
 * container do workspace que ela quer, e a tela de cada bot vem depois, uma por
 * bot. Ids de bot são cuids, então nenhum bot real colide com o sentinela.
 */
export const WORKSPACE_SESSION_SENTINEL = "workspace";

export function isWorkspaceSentinel(botId: string): boolean {
  return botId === WORKSPACE_SESSION_SENTINEL;
}

/**
 * Instalações que ligaram o computador antes desta correção têm uma sessão gráfica
 * viva sob o sentinela: um Xvfb e um Chromium que ninguém vê, ocupando o display 1
 * que o primeiro bot deveria usar. Ela é separada aqui para ser encerrada.
 */
/**
 * Uma tela por vez, por workspace.
 *
 * A alocação de display lê e escreve um mapa em memória em volta de dois `await`
 * (o probe das sessões vivas e o `quibt-session start`). Abrir a tela agora
 * acontece em muito mais lugares — navegador, celular e cada heartbeat —, então
 * duas chamadas simultâneas passavam pelo mesmo buraco: davam o mesmo display a
 * dois bots, ou subiam dois X servers para o mesmo bot, cada um apagando o
 * socket do outro. Tela preta de novo, agora por corrida.
 */
const sessionQueues = new Map<string, Promise<unknown>>();

export function withWorkspaceSessionLock<T>(
  workspaceId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = sessionQueues.get(workspaceId) ?? Promise.resolve();
  const next = previous.then(run, run);
  // A fila guarda só a ordem, nunca o erro: uma falha não pode envenenar a próxima.
  sessionQueues.set(
    workspaceId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export function splitSentinelSessions(probed: Array<[string, number]>): {
  sessions: Array<[string, number]>;
  sentinels: string[];
} {
  const sessions: Array<[string, number]> = [];
  const sentinels: string[] = [];
  for (const [botId, display] of probed) {
    if (isWorkspaceSentinel(botId)) sentinels.push(botId);
    else sessions.push([botId, display]);
  }
  return { sessions, sentinels };
}

/**
 * Restarts websockify inside the container when `/embed.html` no longer answers.
 *
 * The graphical session used to treat a live Xvfb as a live screen. websockify
 * (Debian's) leaks FDs under a reconnect storm and then resets every HTTP/WebSocket
 * accept — black frame, 502 through the Vite proxy — while `quibt-session start`
 * kept saying already-running.
 */
export function novncEnsureCommand(botId: string): string[] {
  if (!SESSION_BOT_ID.test(botId)) {
    throw new SupervisorError("invalid session id");
  }
  return [
    "bash",
    "-lc",
    [
      `dir="/quibt-desktops/${botId}"`,
      'display=$(cat "$dir/display" 2>/dev/null || echo 1)',
      'port=$(cat "$dir/novnc.port" 2>/dev/null || echo $((6080 + display - 1)))',
      "vnc=$((5900 + display - 1))",
      'probe() { python3 -c "import urllib.request; urllib.request.urlopen(\\"http://127.0.0.1:$port/embed.html\\", timeout=2).read()" >/dev/null 2>&1; }',
      "if probe; then echo healthy; exit 0; fi",
      'if [ -f "$dir/novnc.pid" ]; then kill "$(cat "$dir/novnc.pid")" 2>/dev/null || true; sleep 0.2; fi',
      'mkdir -p "$dir/log"',
      'websockify --web=/usr/share/novnc "0.0.0.0:$port" "127.0.0.1:$vnc" >"$dir/log/novnc.log" 2>&1 &',
      'echo $! > "$dir/novnc.pid"',
      'echo "$port" > "$dir/novnc.port"',
      "i=0; while [ $i -lt 15 ]; do if probe; then echo repaired; exit 0; fi; i=$((i + 1)); sleep 0.2; done",
      "echo broken",
      "exit 1",
    ].join("\n"),
  ];
}

export function parseNovncEnsure(output: string): "healthy" | "repaired" | "broken" {
  if (/\bhealthy\b/.test(output)) return "healthy";
  if (/\brepaired\b/.test(output)) return "repaired";
  return "broken";
}

export function parseSessionStart(output: string, requested: number): number {
  const reported = Number(/display=(\d+)/.exec(output)?.[1]);
  if (!Number.isInteger(reported) || reported < 1 || reported > MAX_WORKSPACE_SESSIONS) {
    return requested;
  }
  return reported;
}

/** Parses the probe output into the displays the container is really serving. */
export function parseSessionProbe(output: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const line of output.split("\n")) {
    const [botId, rawDisplay] = line.trim().split(/\s+/);
    const display = Number(rawDisplay);
    if (!botId || !Number.isInteger(display) || display < 1) continue;
    if (display > MAX_WORKSPACE_SESSIONS) continue;
    found.set(botId, display);
  }
  return found;
}

/**
 * A failed probe must never look like "nobody is working here": the caller uses this to
 * decide whether the shared workspace container can be destroyed.
 */
export function hasLiveSessions(probe: Map<string, number> | undefined): boolean {
  return probe === undefined || probe.size > 0;
}

/** Whether the shared workspace container may be removed after a bot session delete. */
export function shouldRemoveSharedContainer(
  preserveComputer: boolean,
  probe: Map<string, number> | undefined,
): boolean {
  return !preserveComputer && !hasLiveSessions(probe);
}

/** Picks a free display, honouring a caller request only when nobody else holds it. */
export function allocateDisplay(
  used: Map<string, number>,
  botId: string,
  requested?: number,
): number {
  const current = used.get(botId);
  if (current) return current;
  const taken = new Set([...used].filter(([id]) => id !== botId).map(([, display]) => display));
  if (requested) {
    if (requested < 1 || requested > MAX_WORKSPACE_SESSIONS) {
      throw new SupervisorError(`display must be 1..${MAX_WORKSPACE_SESSIONS}`);
    }
    if (taken.has(requested)) {
      throw new SupervisorError(`display ${requested} is already assigned`, 409);
    }
    return requested;
  }
  for (let display = 1; display <= MAX_WORKSPACE_SESSIONS; display += 1) {
    if (!taken.has(display)) return display;
  }
  throw new SupervisorError("no free graphical sessions", 409);
}

/**
 * Caches a one-shot async step, but forgets a rejection so a transient image build
 * failure does not brick every later request until the process restarts.
 */
export function retryableOnce<T>(factory: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    if (!inFlight) {
      inFlight = factory().catch((error) => {
        inFlight = undefined;
        throw error;
      });
    }
    return inFlight;
  };
}

/**
 * Docker multiplexes an exec stream in 8-byte frames: `[type, 0, 0, 0, size(BE32)]`, with
 * type 1 = stdout and 2 = stderr. The supervisor used to concatenate every frame, so a
 * command that failed writing only to stderr reached the agent as "no output at all",
 * while the E2B and Box providers do return stderr. This keeps the two apart.
 */
export const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;

const HEADER_BYTES = 8;
const STDERR_FRAME = 2;

export function createDockerStreamDemuxer(limit = MAX_EXEC_OUTPUT_BYTES) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let accepted = 0;
  let truncated = false;
  /** `undefined` until the first byte tells us whether this stream is framed (no TTY). */
  let framed: boolean | undefined;

  function accept(target: Buffer[], payload: Buffer) {
    if (!payload.length) return;
    const room = limit - accepted;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const slice = payload.subarray(0, room);
    target.push(slice);
    accepted += slice.length;
    if (slice.length < payload.length) truncated = true;
  }

  return {
    push(chunk: Buffer) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (framed === undefined) {
        const first = pending[0];
        if (first === undefined) return;
        if (first > STDERR_FRAME) framed = false;
        else if (pending.length >= HEADER_BYTES) framed = true;
        else return; // not enough bytes to tell a header from raw output yet
      }
      if (!framed) {
        accept(stdout, pending);
        pending = Buffer.alloc(0);
        return;
      }
      while (pending.length >= HEADER_BYTES) {
        const size = pending.readUInt32BE(4);
        if (pending.length < HEADER_BYTES + size) break;
        const target = pending[0] === STDERR_FRAME ? stderr : stdout;
        accept(target, pending.subarray(HEADER_BYTES, HEADER_BYTES + size));
        pending = pending.subarray(HEADER_BYTES + size);
      }
    },
    /** Decodes only once, so a UTF-8 character split across frames survives. */
    end() {
      if (pending.length) {
        if (framed && pending.length >= HEADER_BYTES) {
          const target = pending[0] === STDERR_FRAME ? stderr : stdout;
          accept(target, pending.subarray(HEADER_BYTES));
        } else if (!framed) {
          accept(stdout, pending);
        }
        pending = Buffer.alloc(0);
      }
      return {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
      };
    },
  };
}

/** Why a workspace container died before the first process could run. */
export function explainContainerExit(
  exitCode: number | null | undefined,
  log: string,
): SupervisorError {
  const combined = `${log}\n`.toLowerCase();
  if (combined.includes("resource temporarily unavailable") || /\beagain\b/.test(combined)) {
    return new SupervisorError(
      "O computador não ligou: o Docker recusou o processo (EAGAIN). Isso costuma ser RLIMIT_NPROC do uid 1000 no host, não falta de memória.",
      500,
    );
  }
  const snippet = log
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ")
    .slice(0, 240);
  return new SupervisorError(
    snippet
      ? `O computador saiu com código ${exitCode ?? "?"}: ${snippet}`
      : `O computador saiu com código ${exitCode ?? "desconhecido"}.`,
    500,
  );
}
