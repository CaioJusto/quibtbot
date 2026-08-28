export const COMPUTER_IMAGE = process.env.QUIBT_COMPUTER_IMAGE ?? "quibt/computer:local";
export const SCREEN_HOST = process.env.SANDBOX_SCREEN_HOST ?? "127.0.0.1";

/**
 * Interface onde o Docker publica as portas do noVNC. Fica em loopback por padrão;
 * cada sessão também exige uma credencial VNC aleatória. Só abre para a rede quem definir esta variável
 * — necessário, por exemplo, para o app no celular ver a tela de um supervisor que
 * roda em outro aparelho da mesma casa.
 */
export const SCREEN_BIND_HOST = process.env.SANDBOX_SCREEN_BIND_HOST ?? "127.0.0.1";

export const MAX_WORKSPACE_SESSIONS = 32;

/**
 * O container do workspace volta sozinho depois de reiniciar a máquina ou o Docker.
 * `unless-stopped`, e não `always`: um `docker stop` dado de propósito é respeitado até
 * o próximo comando do bot religar (o supervisor faz isso em `/exec` e ao abrir a tela).
 */
export const WORKSPACE_RESTART_POLICY = "unless-stopped";
export const NOVNC_PORT_BASE = 6080;
export const VNC_PORT_BASE = 5900;
export const COMPUTER_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
export const COMPUTER_CPU_NANOS = 2_000_000_000;
export const COMPUTER_PID_LIMIT = 512;

export interface ComputerCreateInput {
  name: string;
  image: string;
  workspaceId: string;
  homePath: string;
  desktopPath: string;
  networkMode?: string;
}

export interface SessionPorts {
  display: number;
  vnc: number;
  novnc: number;
}

export interface PointerInput {
  kind: "pointer";
  x: number;
  y: number;
  button?: "left" | "right";
  // move/click usam x,y absolutos (tela inteira). moveRelative desloca o cursor
  // pelo delta (modo trackpad); tap clica onde o cursor já está, sem mover.
  type: "move" | "moveRelative" | "down" | "up" | "click" | "tap";
}

export type SandboxInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | PointerInput
  | { kind: "clipboard"; text: string };

export function sessionPorts(display: number): SessionPorts {
  if (display < 1 || display > MAX_WORKSPACE_SESSIONS) {
    throw new Error(`display must be 1..${MAX_WORKSPACE_SESSIONS}`);
  }
  const offset = display - 1;
  return {
    display,
    vnc: VNC_PORT_BASE + offset,
    novnc: NOVNC_PORT_BASE + offset,
  };
}

export function sessionPortBindings() {
  const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  const exposed: Record<string, object> = {};
  for (let display = 1; display <= MAX_WORKSPACE_SESSIONS; display += 1) {
    const port = `${sessionPorts(display).novnc}/tcp`;
    exposed[port] = {};
    bindings[port] = [{ HostIp: SCREEN_BIND_HOST, HostPort: "0" }];
  }
  return { ExposedPorts: exposed, PortBindings: bindings };
}

export function containerCreateOptions(input: ComputerCreateInput) {
  const ports = sessionPortBindings();
  return {
    Image: input.image,
    name: input.name,
    Tty: true,
    Env: [
      "HOME=/home/quibt",
      "PATH=/home/quibt/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NPM_CONFIG_PREFIX=/home/quibt/.local",
      "PIP_USER=1",
    ],
    Labels: {
      "quibt.managed": "true",
      "quibt.kind": "workspace",
      "quibt.workspaceId": input.workspaceId,
    },
    ExposedPorts: ports.ExposedPorts,
    HostConfig: {
      Binds: [
        `${input.homePath}:/home/quibt`,
        `${input.homePath}:/workspace`,
        `${input.desktopPath}:/quibt-desktops`,
      ],
      PortBindings: ports.PortBindings,
      ShmSize: 256 * 1024 * 1024,
      Memory: COMPUTER_MEMORY_BYTES,
      MemorySwap: COMPUTER_MEMORY_BYTES,
      NanoCpus: COMPUTER_CPU_NANOS,
      PidsLimit: COMPUTER_PID_LIMIT,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
      Tmpfs: {
        "/tmp": "rw,nosuid,nodev,size=536870912",
        "/run": "rw,nosuid,nodev,size=67108864",
      },
      // PidsLimit (cgroup) is per-container. RLIMIT_NPROC is NOT: without user
      // namespace remapping it counts every thread of this UID on the host. The
      // container user is uid 1000, the same as a typical host login, so nproc=512
      // makes `exec /usr/local/bin/quibt-computer` fail with EAGAIN (exit 255)
      // on a normal Docker Engine host that already has a few hundred threads.
      Ulimits: [
        { Name: "nofile", Soft: 4096, Hard: 4096 },
        // Um crash do Chromium despejava um core de centenas de MB na casa do
        // workspace. Isso enchia o disco, fazia a exportação estourar e deixava o
        // reparo de permissões lento demais para o computador voltar a ligar.
        { Name: "core", Soft: 0, Hard: 0 },
      ],
      ReadonlyPaths: ["/usr/share/novnc"],
      AutoRemove: false,
      // Sem isto o container ficava `Exited` depois de um reboot: todo comando do bot
      // falhava, a tela dizia "ligado" e só `docker start` na mão resolvia.
      RestartPolicy: { Name: WORKSPACE_RESTART_POLICY },
      NetworkMode: input.networkMode ?? "bridge",
    },
    WorkingDir: "/home/quibt",
  };
}

export function containerNameFor(workspaceId: string) {
  return containerNameForWorkspace(workspaceId);
}

export function containerNameForWorkspace(workspaceId: string) {
  const safe = workspaceId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
  return `quibt-ws-${safe || "box"}`;
}

export function workspaceHomePath(dataDir: string, workspaceId: string) {
  const safe = workspaceId.replace(/[^a-zA-Z0-9_.-]/g, "") || "box";
  return `${dataDir.replace(/\/$/, "")}/workspaces/${safe}/home`;
}

/** Persistent graphical profiles live outside the bot-writable workspace home. */
export function workspaceDesktopPath(dataDir: string, workspaceId: string) {
  const safe = workspaceId.replace(/[^a-zA-Z0-9_.-]/g, "") || "box";
  return `${dataDir.replace(/\/$/, "")}/workspaces/${safe}/desktops`;
}

export function screenUrlFor(hostPort: string, host = SCREEN_HOST, password?: string) {
  const url = `http://${host}:${hostPort}/embed.html`;
  return password ? `${url}?password=${encodeURIComponent(password)}` : url;
}

export interface ScreenUrlSources {
  /** IP do container na rede interna do Docker, quando `SANDBOX_SCREEN_NETWORK=internal`. */
  internalAddress?: string;
  /** Porta que o Docker publicou no host para o noVNC desta sessão. */
  hostPort?: string;
  /** Porta do noVNC dentro do container (6080 + display − 1). */
  novncPort: number | string;
  password?: string;
}

/**
 * Qual endereço da tela vai para o cliente.
 *
 * Quem alcança a tela nem sempre é quem roda o supervisor. Com a rede interna ligada a URL
 * era sempre o IP do container (`172.x`), que só vale para containers do mesmo host marcados
 * `quibt.screen-proxy`; sem ela, era o `127.0.0.1` do host do supervisor. Nos dois casos um
 * cliente noutro aparelho via tela preta, e `SANDBOX_SCREEN_HOST` — que existe justamente
 * para dizer "os clientes chegam por aqui" — era ignorado.
 *
 * Agora um `SANDBOX_SCREEN_HOST` declarado ganha da rede interna e usa a porta publicada no
 * host. Ele anda junto com `SANDBOX_SCREEN_BIND_HOST`: sem abrir o bind, não há o que alcançar.
 */
export function resolveScreenUrl(
  sources: ScreenUrlSources,
  env: { SANDBOX_SCREEN_HOST?: string; SANDBOX_SCREEN_NETWORK?: string } = process.env,
): string | undefined {
  const declaredHost = env.SANDBOX_SCREEN_HOST?.trim();
  if (declaredHost && sources.hostPort) {
    return screenUrlFor(sources.hostPort, declaredHost, sources.password);
  }
  if (env.SANDBOX_SCREEN_NETWORK === "internal" && sources.internalAddress) {
    return screenUrlFor(String(sources.novncPort), sources.internalAddress, sources.password);
  }
  if (sources.hostPort) return screenUrlFor(sources.hostPort, SCREEN_HOST, sources.password);
  return undefined;
}

export function xdotoolCommand(input: SandboxInput): string[] {
  if (input.kind === "key") {
    const key = mapKey(input.key);
    const mods = (input.modifiers ?? []).map(mapKey);
    const combo = [...mods, key].join("+");
    return ["xdotool", "key", "--clearmodifiers", combo];
  }
  if (input.kind === "pointer") {
    const btn = input.button === "right" ? "3" : "1";
    if (input.type === "move")
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y)];
    if (input.type === "moveRelative")
      return ["xdotool", "mousemove_relative", "--", String(input.x), String(input.y)];
    if (input.type === "tap") return ["xdotool", "click", btn];
    if (input.type === "down") {
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "mousedown", btn];
    }
    if (input.type === "up") return ["xdotool", "mouseup", btn];
    return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "click", btn];
  }
  return ["xdotool", "type", "--clearmodifiers", "--", input.text];
}

function mapKey(key: string) {
  const lower = key.toLowerCase();
  if (lower === "enter" || lower === "return") return "Return";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "space") return "space";
  if (lower === "tab") return "Tab";
  if (lower === "backspace") return "BackSpace";
  if (lower === "ctrl" || lower === "control") return "ctrl";
  if (lower === "alt") return "alt";
  if (lower === "shift") return "shift";
  if (lower === "meta" || lower === "cmd" || lower === "super") return "super";
  return key;
}
