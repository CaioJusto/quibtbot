import { controlUntilLabel } from "@quibt/core";

export const COMPUTER_HEARTBEAT_MS = 60_000;
export const COMPUTER_STATUS_POLL_MS = 2_000;
export const COMPUTER_CONTROL_POLL_MS = 800;
// O trackpad em si (soma de deltas por quadro, soltar = clique) mora no core, junto com
// a versão da web; aqui só o que é do app.
export {
  createPointerMoveCoalescer,
  type PointerDelta,
  TRACKPAD_CLICK_SLOP_PX,
  trackpadReleaseAction,
  withControlLease,
} from "@quibt/core";

export function computerPollMs(hasControl: boolean) {
  return hasControl ? COMPUTER_CONTROL_POLL_MS : COMPUTER_STATUS_POLL_MS;
}

export type ComputerStatus = {
  state: string;
  controlHolder: string;
  /** Até quando o lease vale (ISO). O prazo anda com o uso: cada tecla e cada heartbeat renovam. */
  controlLeaseExpiresAt?: string | null;
  screenAvailable: boolean;
  screenUrl?: string | null;
};

/** Provider diagnostics belong in logs; this is the sentence shown on the black computer screen. */
export function computerFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
  if (/trial_auto_stop_required|free-trial boxes cannot run without auto-stop/i.test(message)) {
    return "A sua conta Box está no trial e exige pausa automática. O Quibt usa o limite de 2 horas e preserva o disco para retomar depois. Tente ligar novamente.";
  }
  if (/box api\b.*\b(?:401|403)\b|invalid_api_key/i.test(message)) {
    return "A Box recusou a chave salva. Atualize a chave em Máquina dos bots e tente novamente.";
  }
  if (/box api\b.*\b429\b|rate_limit/i.test(message)) {
    return "A sua conta Box atingiu o limite de máquinas agora. Aguarde um pouco ou confira o plano da Box.";
  }
  if (/^box api\b/i.test(message)) {
    return "A Box não conseguiu ligar este computador. Tente novamente; se continuar, confira a conta e a chave Box.";
  }
  if (/^rpc computer\/(?:boot|status) failed/i.test(message)) return fallback;
  return message;
}

/** Skip the extra screenUrl RPC when status already carried it or the viewer is pinned. */
export function needsScreenUrlRpc(input: {
  status: ComputerStatus;
  pinnedUrl: string | null;
}): boolean {
  if (input.status.screenUrl) return false;
  if (input.pinnedUrl) return false;
  if (input.status.controlHolder !== "user") return false;
  return input.status.state === "running" || input.status.state === "booting";
}

export function isLocalHostname(hostname: string) {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** Point a loopback noVNC URL at the same host the app uses for the API. */
export function embeddableScreenUrl(url: string | null, apiBase: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const api = new URL(apiBase);
    if (isLocalHostname(parsed.hostname) && !isLocalHostname(api.hostname)) {
      parsed.hostname = api.hostname;
      // A signed /novnc/ capability on loopback must follow the API origin so a
      // phone off this Wi-Fi can reuse the same HTTPS tunnel as the QR.
      if (parsed.pathname.startsWith("/novnc/")) {
        parsed.protocol = api.protocol;
        parsed.port = api.port;
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function previewPlaceholder(
  state: string | undefined,
  booting: boolean,
  name: string,
): string {
  if (state === "booting" || booting) return `Abrindo a tela de ${name} no seu computador`;
  if (state === "running") return "Assuma o controle para ver a tela";
  if (state === "suspended") return "Seu computador está dormindo — assuma o controle pra acordar";
  if (state === "error") return "Seu computador não conseguiu ligar";
  return "Seu computador está parado";
}

/**
 * O que a tela cheia mostra quando não há imagem, e o que o botão faz.
 *
 * A API só assina a URL do desktop para quem tem o controle, então "sem controle" é o
 * caso comum — e a tela cheia escrevia só "Tela de Fulano" sobre o preto, sem dizer o
 * motivo nem oferecer saída. Cada estado agora tem uma frase e uma ação.
 */
export type ScreenNoticeAction = "retry" | "take-control" | "wake" | "boot" | null;

export function screenNotice(input: {
  state: string | undefined;
  booting: boolean;
  hasControl: boolean;
  error: string | null;
  lost: boolean;
  name: string;
}): { title: string; body?: string; action: ScreenNoticeAction; actionLabel?: string } {
  if (input.error) {
    return {
      title: "A tela não abriu",
      body: input.error,
      action: "retry",
      actionLabel: "Tentar de novo",
    };
  }
  if (input.lost) {
    return {
      title: "A tela caiu",
      body: "A conexão com o computador se perdeu.",
      action: "retry",
      actionLabel: "Reconectar",
    };
  }
  if (input.booting || input.state === "booting") {
    return { title: `Abrindo a tela de ${input.name}…`, action: null };
  }
  if (input.state === "suspended") {
    return {
      title: "O computador está dormindo",
      body: "Ele acorda quando você assume o controle.",
      action: "wake",
      actionLabel: "Acordar e assumir",
    };
  }
  if (input.state === "running" && !input.hasControl) {
    return {
      title: "Assuma o controle para ver a tela",
      body: "Enquanto o bot trabalha, a imagem fica com ele. Ao assumir, o bot espera você devolver.",
      action: "take-control",
      actionLabel: "Assumir controle",
    };
  }
  if (input.state === "error") {
    return {
      title: "O computador não conseguiu ligar",
      action: "boot",
      actionLabel: "Tentar de novo",
    };
  }
  if (input.state === "running") {
    return { title: "Conectando à tela…", action: null };
  }
  return { title: "O computador está parado", action: "boot", actionLabel: "Ligar o computador" };
}

export function controlLabel(computer: ComputerStatus | null, name: string, now?: Date) {
  if (computer?.controlHolder === "user") {
    // "até 14:35": a pessoa sabe até quando é dela sem precisar se surpreender depois.
    const until = controlUntilLabel(computer.controlLeaseExpiresAt, now);
    return until ? `Você tem o controle ${until}` : "Você tem o controle";
  }
  if (computer?.state === "suspended") return "Dormindo";
  return `tela de ${name}`;
}

/**
 * The screen URL is a signed capability (`/novnc/<host>/<port>/<expiresAt>.<sig>[.<mode>]`) and the
 * status poll asks for a new one every couple of seconds. The WebView reloads whenever its
 * URL changes, so feeding it every refresh reconnects noVNC mid-session. The signature only
 * guards the handshake, so the URL is pinned while the screen is on and a fresh one is
 * taken only when the screen is not showing (a (re)mount needs a capability that is still
 * valid) or when it points at a different screen. Twin of `apps/web/src/lib/screen-url.ts`.
 */
export const SCREEN_URL_RENEW_MARGIN_MS = 15_000;

const CAPABILITY_PATH =
  /^\/novnc\/([A-Za-z0-9_-]+)\/(\d+)\/(\d+)\.([A-Za-z0-9_-]+)(?:\.(view|control))?(\/.*)?$/;

export function screenUrlCapability(url: string | null) {
  if (!url) return null;
  const scheme = url.indexOf("://");
  const slash = scheme < 0 ? -1 : url.indexOf("/", scheme + 3);
  const origin = scheme < 0 ? "" : slash < 0 ? url : url.slice(0, slash);
  const path = scheme < 0 ? url : slash < 0 ? "/" : url.slice(slash);
  const match = CAPABILITY_PATH.exec(path);
  if (!match) return null;
  const expiresAt = Number(match[3]);
  if (!Number.isFinite(expiresAt)) return null;
  const mode = match[5] ? `.${match[5]}` : "";
  return { target: `${origin}/${match[1]}/${match[2]}${mode}${match[6] ?? ""}`, expiresAt };
}

function sameScreen(a: string, b: string) {
  if (a === b) return true;
  const left = screenUrlCapability(a);
  const right = screenUrlCapability(b);
  return Boolean(left && right && left.target === right.target);
}

export type ScreenUrlDecision = {
  url: string | null;
  action: "keep" | "swap" | "renew" | "reconnect";
};

export function decideScreenUrl(input: {
  current: string | null;
  next: string | null;
  /** Instant the screen was shown, or `null` while it is not on screen. */
  mountedAt: number | null;
  now: number;
  /** The embedded viewer reported that its connection died. */
  disconnected?: boolean;
  renewMarginMs?: number;
}): ScreenUrlDecision {
  const { current, next, mountedAt, now } = input;
  const margin = input.renewMarginMs ?? SCREEN_URL_RENEW_MARGIN_MS;
  // Pinning protects a *live* session; a dead one has to be remounted, otherwise the user
  // stares at a frozen screen until they leave the route and come back.
  if (input.disconnected) return { url: null, action: "reconnect" };
  if (current && mountedAt !== null) {
    // A missing next URL is the API saying this actor no longer holds the lease.
    // Keeping the last signed capability would leave an interactive socket up.
    if (!next) return { url: null, action: "reconnect" };
    if (sameScreen(current, next)) return { url: current, action: "keep" };
    return { url: next, action: "swap" };
  }
  const fresh = (url: string | null) => {
    if (!url) return false;
    const capability = screenUrlCapability(url);
    return !capability || capability.expiresAt - now > margin;
  };
  if (fresh(next)) return { url: next, action: next === current ? "keep" : "swap" };
  if (fresh(current)) return { url: current, action: "keep" };
  return { url: null, action: "renew" };
}

/**
 * The embedded noVNC page (`infra/sandboxes/computer/embed.html`) reports connection drops.
 * A WebView only has the string bridge, so the payload arrives as JSON text.
 */
export const SCREEN_MESSAGE = {
  connected: "quibt.screen.connected",
  disconnected: "quibt.screen.disconnected",
} as const;

export function screenBridgeMessage(raw: unknown): "connected" | "disconnected" | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    if (parsed?.type === SCREEN_MESSAGE.disconnected) return "disconnected";
    if (parsed?.type === SCREEN_MESSAGE.connected) return "connected";
    return null;
  } catch {
    return null;
  }
}

/** How many times the screen is remounted before the user is told it will not come back. */
export const SCREEN_RECONNECT_LIMIT = 4;
export const SCREEN_RECONNECT_BASE_MS = 500;
export const SCREEN_RECONNECT_MAX_MS = 8_000;

export type ScreenReconnectPlan = { retry: boolean; delayMs: number; nextAttempt: number };

/** Backoff for a screen that keeps dropping, so a broken sandbox is not hammered. */
export function planScreenReconnect(attempt: number): ScreenReconnectPlan {
  const attempts = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  if (attempts >= SCREEN_RECONNECT_LIMIT) {
    return { retry: false, delayMs: 0, nextAttempt: attempts };
  }
  return {
    retry: true,
    delayMs: Math.min(SCREEN_RECONNECT_MAX_MS, SCREEN_RECONNECT_BASE_MS * 2 ** attempts),
    nextAttempt: attempts + 1,
  };
}

/**
 * A tela do bot é um noVNC servido por um endereço só. Prender a WebView a ele fecha a
 * porta para uma navegação que saia dali: a URL chega assinada pela API, mas quem
 * decide para onde a página vai depois é a própria página, e um clique levado para
 * fora abriria um host qualquer dentro da moldura que a pessoa lê como "a tela do bot".
 * `about:blank` e `data:` continuam liberados porque o próprio WebView os usa ao montar.
 */
export function allowScreenNavigation(target: string, screenUrl: string | null): boolean {
  if (!screenUrl) return false;
  if (target === "about:blank" || target.startsWith("data:")) return true;
  try {
    return new URL(target).origin === new URL(screenUrl).origin;
  } catch {
    return false;
  }
}
