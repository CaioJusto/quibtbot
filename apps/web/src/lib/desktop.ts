export type RemoteAccess =
  | { kind: "off"; reason: "missing" | "logged-out" | "not-serving" }
  | { kind: "on"; url: string };

export interface QuibtDesktop {
  platform: string;
  reloadApp?: () => Promise<void>;
  startStack?: () => Promise<{ ok: boolean; message: string; log?: string }>;
  lanInfo?: () => Promise<{ api: string | null; remote?: RemoteAccess }>;
  remoteAccess?: (enabled?: boolean) => Promise<RemoteAccess>;
  grantFolder: () => Promise<string | null>;
  listGrants: () => Promise<string[]>;
  /** Desinstalar o Quibt deste computador (o app pergunta antes). Só no desktop. */
  uninstall?: () => Promise<void>;
  window: {
    close: () => Promise<void>;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    state: () => Promise<{ minimized: boolean; maximized: boolean; fullScreen: boolean }>;
  };
}

declare global {
  interface Window {
    quibtDesktop?: QuibtDesktop;
  }
}

export function desktopBridge(): QuibtDesktop | undefined {
  if (typeof window === "undefined") return undefined;
  return window.quibtDesktop;
}

/**
 * No macOS a janela do app é sem moldura, com os três botões do sistema flutuando
 * sobre o conteúdo. Qualquer camada que cubra o topo — a tela do computador em
 * tela cheia, por exemplo — precisa deixar essa faixa livre, senão o título nasce
 * embaixo dos botões e ninguém lê nem clica direito.
 */
export const MAC_TRAFFIC_LIGHT_INSET = 84;

export function trafficLightInset(desktop = desktopBridge()): number {
  return desktop?.platform === "darwin" ? MAC_TRAFFIC_LIGHT_INSET : 0;
}

export function windowChromeKind(desktop?: QuibtDesktop): "spacer" | "darwin" | "controls" {
  if (!desktop) return "spacer";
  if (desktop.platform === "darwin") return "darwin";
  return "controls";
}
