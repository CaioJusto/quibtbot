import { type BrowserWindow, Notification, WebContentsView } from "electron";
import {
  allowedBotBrowserUrl,
  botBrowserPartition,
  parseBotBrowserAttach,
  parseBotBrowserId,
  takeoverOsNotification,
} from "./bot-browser.js";

export type BotBrowserState = {
  botId: string;
  partition: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
};

type HostWindow = Pick<BrowserWindow, "contentView" | "webContents" | "isDestroyed">;

export class BotBrowserHost {
  private readonly views = new Map<string, WebContentsView>();
  private visibleBotId: string | null = null;

  constructor(
    private readonly notify: (payload: {
      title: string;
      body: string;
    }) => void = showOsNotification,
  ) {}

  attach(win: HostWindow, raw: unknown): { partition: string } | { error: string } {
    const parsed = parseBotBrowserAttach(raw);
    if (!parsed) return { error: "Pedido inválido para o navegador do bot." };
    const view = this.ensureView(parsed.botId, parsed.partition);
    win.contentView.addChildView(view);
    view.setBounds(parsed.bounds);
    this.visibleBotId = parsed.botId;
    this.emitState(win, parsed.botId);
    return { partition: parsed.partition };
  }

  setBounds(_win: HostWindow, raw: unknown): { ok: true } | { error: string } {
    const parsed = parseBotBrowserAttach(raw);
    if (!parsed) return { error: "Pedido inválido para o navegador do bot." };
    const view = this.views.get(parsed.botId);
    if (!view) return { error: "Navegador deste bot ainda não foi aberto." };
    view.setBounds(parsed.bounds);
    return { ok: true };
  }

  hide(win: HostWindow, raw: unknown): { ok: true } {
    const botId = parseBotBrowserId(raw);
    if (botId) {
      const view = this.views.get(botId);
      if (view) win.contentView.removeChildView(view);
      if (this.visibleBotId === botId) this.visibleBotId = null;
    }
    return { ok: true };
  }

  loadUrl(win: HostWindow, raw: unknown): { ok: true } | { error: string } {
    const botId = parseBotBrowserId(raw);
    const url = raw && typeof raw === "object" ? (raw as { url?: unknown }).url : undefined;
    if (!botId || typeof url !== "string" || !allowedBotBrowserUrl(url)) {
      return { error: "Este navegador só abre páginas http ou https." };
    }
    const view = this.ensureView(botId, botBrowserPartition(botId));
    void view.webContents.loadURL(url);
    this.emitState(win, botId);
    return { ok: true };
  }

  go(
    win: HostWindow,
    raw: unknown,
    action: "back" | "forward" | "reload",
  ): { ok: true } | { error: string } {
    const botId = parseBotBrowserId(raw);
    if (!botId) return { error: "botId inválido para o navegador embutido" };
    const view = this.views.get(botId);
    if (!view) return { error: "Navegador deste bot ainda não foi aberto." };
    if (action === "back") view.webContents.goBack();
    else if (action === "forward") view.webContents.goForward();
    else view.webContents.reload();
    this.emitState(win, botId);
    return { ok: true };
  }

  state(botIdRaw: unknown): BotBrowserState | { error: string } {
    const botId = parseBotBrowserId(botIdRaw);
    if (!botId) return { error: "botId inválido para o navegador embutido" };
    const view = this.views.get(botId);
    return this.snapshot(botId, view);
  }

  notifyTakeover(raw: unknown): { ok: true } | { error: string } {
    if (!raw || typeof raw !== "object") return { error: "Pedido de aviso inválido." };
    const input = raw as Record<string, unknown>;
    if (typeof input.botName !== "string") return { error: "Pedido de aviso inválido." };
    this.notify(
      takeoverOsNotification({
        botName: input.botName,
        reason: typeof input.reason === "string" ? input.reason : "",
      }),
    );
    return { ok: true };
  }

  private ensureView(botId: string, partition: string): WebContentsView {
    const existing = this.views.get(botId);
    if (existing) return existing;
    const view = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (allowedBotBrowserUrl(url)) void view.webContents.loadURL(url);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      if (allowedBotBrowserUrl(url)) return;
      event.preventDefault();
    });
    void view.webContents.loadURL("about:blank");
    this.views.set(botId, view);
    return view;
  }

  private snapshot(botId: string, view: WebContentsView | undefined): BotBrowserState {
    return {
      botId,
      partition: botBrowserPartition(botId),
      url: view?.webContents.getURL() || "about:blank",
      title: view?.webContents.getTitle() || "",
      canGoBack: view?.webContents.canGoBack() ?? false,
      canGoForward: view?.webContents.canGoForward() ?? false,
    };
  }

  private emitState(win: HostWindow, botId: string): void {
    if (win.isDestroyed()) return;
    win.webContents.send(
      "desktop.botBrowser.navigated",
      this.snapshot(botId, this.views.get(botId)),
    );
  }
}

export function showOsNotification(payload: { title: string; body: string }): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: payload.title,
    body: payload.body,
    silent: false,
  });
  notification.show();
}
