import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allowScreenNavigation,
  computerPollMs,
  controlLabel,
  createPointerMoveCoalescer,
  decideScreenUrl,
  embeddableScreenUrl,
  needsScreenUrlRpc,
  type PointerDelta,
  planScreenReconnect,
  previewPlaceholder,
  SCREEN_MESSAGE,
  SCREEN_RECONNECT_LIMIT,
  screenBridgeMessage,
  screenNotice,
  trackpadReleaseAction,
} from "./computer.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

function source(relative: string) {
  return readFileSync(path.join(dir, relative), "utf8");
}

describe("embeddableScreenUrl", () => {
  it("leaves a public stream URL alone", () => {
    const url = "https://sandbox.e2b.app/stream?authKey=abc&view_only=true";
    expect(embeddableScreenUrl(url, "https://api.quibt.test")).toBe(url);
  });

  it("keeps loopback screens when the API is also loopback", () => {
    const url = "http://127.0.0.1:16080/embed.html?view_only=true";
    expect(embeddableScreenUrl(url, "http://127.0.0.1:3100")).toBe(url);
    expect(embeddableScreenUrl(url, "http://localhost:3100")).toBe(url);
  });

  it("rewrites loopback screens onto the API host for a device or emulator", () => {
    expect(
      embeddableScreenUrl(
        "http://127.0.0.1:16080/embed.html?view_only=false",
        "http://10.0.2.2:3100",
      ),
    ).toBe("http://10.0.2.2:16080/embed.html?view_only=false");
    expect(
      embeddableScreenUrl("http://localhost:16080/embed.html", "http://192.168.1.20:3100"),
    ).toBe("http://192.168.1.20:16080/embed.html");
  });

  it("returns null when there is no screen", () => {
    expect(embeddableScreenUrl(null, "http://127.0.0.1:3100")).toBeNull();
  });

  it("rewrites a loopback /novnc/ capability onto a public HTTPS API origin", () => {
    expect(
      embeddableScreenUrl(
        "http://127.0.0.1:5173/novnc/abc/49152/9.sig.control/embed.html",
        "https://quibt.trycloudflare.com",
      ),
    ).toBe("https://quibt.trycloudflare.com/novnc/abc/49152/9.sig.control/embed.html");
  });
});

describe("screen URL pinning", () => {
  const NOW = 1_700_000_000_000;
  const signed = (expiresAt: number, signature: string, port = 49152) =>
    `http://10.0.2.2:3100/novnc/MTAuMC4yLjI/${port}/${expiresAt}.${signature}/embed.html`;

  it("keeps the WebView on its URL while the screen is up, even re-signed", () => {
    const current = signed(NOW + 60_000, "sig-a");
    const next = signed(NOW + 120_000, "sig-b");
    // The status poll runs every two seconds; a new string here would reload noVNC.
    expect(decideScreenUrl({ current, next, mountedAt: NOW, now: NOW + 30_000 })).toEqual({
      url: current,
      action: "keep",
    });
    expect(decideScreenUrl({ current, next, mountedAt: NOW, now: NOW + 300_000 })).toEqual({
      url: current,
      action: "keep",
    });
  });

  it("keeps the WebView when a refresh re-signs the same control capability", () => {
    const signedMode = (expiresAt: number, signature: string) =>
      `http://10.0.2.2:3100/novnc/MTAuMC4yLjI/49152/${expiresAt}.${signature}.control/embed.html`;
    const current = signedMode(NOW + 60_000, "sig-a");
    const next = signedMode(NOW + 120_000, "sig-b");
    expect(decideScreenUrl({ current, next, mountedAt: NOW, now: NOW + 30_000 })).toEqual({
      url: current,
      action: "keep",
    });
  });

  it("unpins the WebView when the API stops issuing a capability", () => {
    const signedMode = (expiresAt: number, signature: string) =>
      `http://10.0.2.2:3100/novnc/MTAuMC4yLjI/49152/${expiresAt}.${signature}.control/embed.html`;
    const current = signedMode(NOW + 60_000, "sig-a");
    expect(decideScreenUrl({ current, next: null, mountedAt: NOW, now: NOW + 1_000 })).toEqual({
      url: null,
      action: "reconnect",
    });
  });

  it("swaps when the URL points at another screen", () => {
    const current = signed(NOW + 60_000, "sig-a", 49152);
    const next = signed(NOW + 60_000, "sig-b", 49999);
    expect(decideScreenUrl({ current, next, mountedAt: NOW, now: NOW })).toEqual({
      url: next,
      action: "swap",
    });
  });

  it("takes a fresh capability when the screen is not showing", () => {
    const current = signed(NOW + 60_000, "sig-a");
    const next = signed(NOW + 120_000, "sig-b");
    expect(decideScreenUrl({ current, next, mountedAt: null, now: NOW + 30_000 })).toEqual({
      url: next,
      action: "swap",
    });
    // About to expire: better to wait for the next poll than to mount a dead URL.
    expect(decideScreenUrl({ current, next: current, mountedAt: null, now: NOW + 55_000 })).toEqual(
      { url: null, action: "renew" },
    );
  });

  it("leaves an unsigned dev URL alone", () => {
    const url = "http://10.0.2.2:16080/embed.html";
    expect(decideScreenUrl({ current: url, next: url, mountedAt: null, now: NOW })).toEqual({
      url,
      action: "keep",
    });
  });

  it("is wired into the screen instead of the raw refresh URL", () => {
    const src = source("../app/computer.tsx");
    expect(src).toContain("decideScreenUrl");
    expect(src).toContain("url={pinnedScreenUrl}");
    expect(src).not.toContain("url={embeddedScreenUrl}");
  });

  it("unmounts a dead session instead of pinning it forever", () => {
    const current = signed(NOW + 60_000, "sig-a");
    // Pinning is what protects a live session; a WebView whose noVNC died has to remount,
    // otherwise the user is stuck with a frozen screen.
    expect(
      decideScreenUrl({
        current,
        next: current,
        mountedAt: NOW,
        now: NOW + 20_000,
        disconnected: true,
      }),
    ).toEqual({ url: null, action: "reconnect" });
    // The next poll (every 2 s) mints a fresh capability and it mounts again.
    const next = signed(NOW + 120_000, "sig-b");
    expect(decideScreenUrl({ current: null, next, mountedAt: null, now: NOW + 60_000 })).toEqual({
      url: next,
      action: "swap",
    });
  });
});

describe("screen bridge messages", () => {
  it("reads the connection reports the embed page posts", () => {
    expect(screenBridgeMessage(JSON.stringify({ type: SCREEN_MESSAGE.disconnected }))).toBe(
      "disconnected",
    );
    expect(screenBridgeMessage(JSON.stringify({ type: SCREEN_MESSAGE.connected }))).toBe(
      "connected",
    );
  });

  it("ignores anything else a page can push through the bridge", () => {
    expect(screenBridgeMessage(JSON.stringify({ type: "something.else" }))).toBeNull();
    expect(screenBridgeMessage("not json")).toBeNull();
    expect(screenBridgeMessage(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(screenBridgeMessage(undefined)).toBeNull();
    expect(screenBridgeMessage("x".repeat(600))).toBeNull();
  });
});

describe("screen reconnect backoff", () => {
  it("grows the delay and then gives up instead of remounting forever", () => {
    const delays: number[] = [];
    let attempt = 0;
    for (let i = 0; i < SCREEN_RECONNECT_LIMIT; i += 1) {
      const plan = planScreenReconnect(attempt);
      expect(plan.retry).toBe(true);
      delays.push(plan.delayMs);
      attempt = plan.nextAttempt;
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000]);
    expect(planScreenReconnect(attempt).retry).toBe(false);
    expect(planScreenReconnect(0).delayMs).toBe(500);
  });

  it("is wired to the WebView bridge, with a give-up message and no leaked timer", () => {
    const src = source("../app/computer.tsx");
    expect(src).toContain("onMessage={onScreenMessage}");
    expect(src).toContain("onMessage={(event) => onMessage(event.nativeEvent.data)}");
    expect(src).toContain("screenBridgeMessage");
    expect(src).toContain("planScreenReconnect");
    expect(src).toContain("disconnected: dropped");
    expect(src).toContain("A tela caiu e não voltou");
    expect(src).toContain("if (screenLost) {");
    expect(src).toContain("clearTimeout(screenRetryTimer.current)");
  });
});

describe("computer copy", () => {
  it("matches the web pane while booting, asleep, or in control", () => {
    expect(previewPlaceholder("stopped", false, "Chief")).toBe("Seu computador está parado");
    expect(previewPlaceholder("suspended", false, "Chief")).toBe(
      "Seu computador está dormindo — assuma o controle pra acordar",
    );
    expect(previewPlaceholder("running", true, "Chief")).toBe(
      "Abrindo a tela de Chief no seu computador",
    );
    expect(previewPlaceholder("running", false, "Chief")).toBe("Assuma o controle para ver a tela");
    expect(
      controlLabel({ state: "running", controlHolder: "user", screenAvailable: true }, "Chief"),
    ).toBe("Você tem o controle");
    expect(
      controlLabel({ state: "suspended", controlHolder: "none", screenAvailable: false }, "Chief"),
    ).toBe("Dormindo");
  });

  it("diz até quando o controle é seu, a partir do prazo que o status devolve", () => {
    const deadline = new Date(2026, 7, 25, 14, 35);
    const now = new Date(2026, 7, 25, 14, 20);
    expect(
      controlLabel(
        {
          state: "running",
          controlHolder: "user",
          controlLeaseExpiresAt: deadline.toISOString(),
          screenAvailable: true,
        },
        "Chief",
        now,
      ),
    ).toBe("Você tem o controle até 14:35");
    // Prazo já passado ou ausente: a frase de sempre, sem hora errada.
    expect(
      controlLabel(
        {
          state: "running",
          controlHolder: "user",
          controlLeaseExpiresAt: deadline.toISOString(),
          screenAvailable: true,
        },
        "Chief",
        new Date(2026, 7, 25, 14, 36),
      ),
    ).toBe("Você tem o controle");
    expect(
      controlLabel(
        {
          state: "running",
          controlHolder: "user",
          controlLeaseExpiresAt: null,
          screenAvailable: true,
        },
        "Chief",
        now,
      ),
    ).toBe("Você tem o controle");
  });
});

describe("mobile computer screen", () => {
  it("boots, takes over, heartbeats, and releases like web", () => {
    const src = source("../app/computer.tsx");
    expect(src).toContain("computer/boot");
    expect(src).toContain("computer/takeover");
    expect(src).toContain("computer/release");
    expect(src).toContain("computer/heartbeat");
    expect(src).toContain('if (!botId || !hasControl || computer?.state !== "running") return');
    expect(src).toContain("screenUrl: null");
    expect(src).toContain("setScreenUrl(result.screenUrl)");
    expect(src).toContain("needsScreenUrlRpc");
    expect(src).not.toContain("force: true");
    expect(src).toContain("Assumir controle");
    expect(src).toContain("Liberar");
    expect(src).toContain("Fechar computador");
    expect(src).toContain("Modo trackpad");
    expect(src).toContain("Colar");
    expect(src).toContain("currentApiBase()");
  });

  it("sends relative pointer moves and non-empty clipboard paste", () => {
    const src = source("../app/computer.tsx");
    expect(src).toContain('kind: "pointer"');
    // Trackpad manda o deslocamento (relativo), não a posição absoluta, e o toque-clique
    // é um "tap" que clica onde o cursor está — não um click em (0,0).
    expect(src).toContain('type: "moveRelative"');
    expect(src).toContain('type: "tap"');
    expect(src).not.toContain('type: "move"');
    expect(src).toContain('kind: "clipboard"');
    expect(src).toContain("readClipboardText");
    expect(src).not.toContain('payload: { text: "" }');
    expect(src).toContain("showNativeSheet");
  });
});

describe("native iOS chrome", () => {
  it("opens create and computer menus with stable platform controls", () => {
    expect(source("./native.tsx")).toContain("ActionSheetIOS");
    expect(source("./native.tsx")).toContain("expo-symbols");
    expect(source("./native.tsx")).toContain("NativeSheetHost");
    expect(source("../app/_layout.tsx")).toContain("<NativeSheetHost />");
    // No iOS o menu do cabeçalho é o cartão ancorado ao botão, o desenho do UIMenu.
    expect(source("./native-glass-menu.ios.tsx")).toContain("ContextMenuSheet");
    expect(source("./native-glass-menu.ios.tsx")).toContain("alignRight");
    expect(source("./native-glass-menu-fallback.tsx")).not.toContain("expo-glass-effect");
    expect(source("./design-system.tsx")).toContain("expo-blur");
    expect(source("./native-glass-menu-fallback.tsx")).toContain("Modal");
    // `@expo/ui` só sobe em dev build; o app tem que continuar rodando no Expo Go.
    expect(source("./native-glass-menu.ios.tsx")).not.toContain("@expo/ui/swift-ui");
    expect(source("./native-glass-menu.tsx")).toContain("native-glass-menu-fallback");
    expect(source("../app/index.tsx")).toContain("Novo bot");
    expect(source("../app/index.tsx")).toContain("Novo grupo");
    expect(source("../app/index.tsx")).toContain("NativeGlassMenu");
  });

  it("confirms destructive account and bot actions in a native sheet", () => {
    const account = source("../app/account.tsx");
    expect(account).toContain("showNativeSheet");
    expect(account).toContain("destructive: true");
    // Every header ellipsis must open a menu, not sit there as dead chrome.
    const settings = source("../app/settings.tsx");
    expect(settings).toContain("NativeGlassMenu");
    expect(settings).toContain('accessibilityLabel="Opções do bot"');
    expect(settings).toContain("Limpar conversa");
    expect(source("./routines.tsx")).toContain("showNativeSheet");
    expect(source("../app/group-settings.tsx")).not.toContain("Alert.alert");
  });

  it("sends plan limits from bot creation to the billing screen", () => {
    const src = source("../app/new.tsx");
    expect(src).toContain("isPlanLimitError");
    expect(src).toContain('router.push("/billing")');
  });

  it("sends thread plan limits to the billing screen", () => {
    const src = source("../app/thread.tsx");
    expect(src).toContain("isPlanLimitError");
    expect(src).toContain('router.push("/billing")');
    expect(src).toContain("threadEventNeedsSnapshotRefresh");
  });

  it("renders billing cards from the server snapshot", () => {
    const src = source("../app/billing.tsx");
    expect(src).toContain("billing.plans.map");
    expect(src).not.toContain("CLOUD_PLANS");
  });

  it("shows live presence on featured marks and every inbox row", () => {
    const src = source("../app/index.tsx");
    // Verde trabalhando, azul quando é a pessoa quem falta — nos destaques e em cada linha.
    expect(src.match(/presence=\{inboxPresence\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("gives every generated mascot a living idle motion", () => {
    const src = source("./agent-mark.tsx");
    expect(src).toContain("Animated");
    expect(src).toContain("useNativeDriver: true");
    expect(src).toContain("mascot-blob-citrus.png");
    expect(src).toContain("mascot-cube-citrus.png");
    expect(src).toContain("mascot-drop-citrus.png");
    expect(src).toContain("mascot-orb-citrus.png");
    expect(src).toContain("nearestMascotColorKey");
    expect(src).toContain("animated ?? (size >= 100 && !developmentBundle)");
    expect(src).toContain("translateY: phase.interpolate");
    expect(src).toContain("scale: phase.interpolate");
    expect(src.match(/Animated\.loop/g)).toHaveLength(1);
    expect(src).not.toContain("shadowColor: fill");
  });

  it("keeps auth mascots clean without decorative light behind them", () => {
    const brand = source("./brand.tsx");
    const auth = source("./auth-ui.tsx");
    expect(brand).not.toContain("width: size * 1.28");
    expect(brand).not.toContain('shadowColor: "#5B7FE5"');
    // Sem pano de fundo decorativo nem cabeçalho com selo: as telas de entrada são só
    // a pergunta, o campo e o botão.
    expect(auth).not.toContain("AuthBackdrop");
    expect(auth).not.toContain("AuthHeader");
  });

  it("offers only the four genuinely different mascot silhouettes", () => {
    const src = source("./character-picker.tsx");
    expect(src).toContain("PICKER_SHAPES");
    expect(src).toContain('from "@quibt/ui-tokens"');
    expect(src).toContain("PICKER_SHAPES.map");
    expect(src).not.toContain("MARK_SHAPES.map");
    expect(src).toContain("accessibilityLabel={`Formato ");
    expect(src).toContain("MARK_STYLE_LABELS[id]");
    expect(src.indexOf("PICKER_SHAPES.map")).toBeLessThan(src.indexOf(">Cor</Text>"));
    expect(src).toContain("size={60}");
    expect(src).toContain("selected && styles.colorSelected");
    expect(src).toContain("const swatchStyles = StyleSheet.create");
    expect(src).not.toContain("MARK_COLORS.map");
    expect(src).not.toContain("backgroundColor: swatch.value");
  });

  it("answers approval requests with the author bot in group threads", () => {
    const src = source("../app/thread.tsx");
    expect(src).toContain('rpc("threads/answer"');
    // The row that carries the answer target is built in lib/thread-rows.
    expect(source("./thread-rows.ts")).toContain("message.authorBotId ?? botId");
    expect(src).toContain("answerBotId={item.answerBotId}");
    expect(src).toContain("Enviar");
    expect(src).toContain("Permitir");
    expect(src).toContain("Sempre");
    expect(src).toContain("Recusar");
  });
});

describe("trackpad and poll", () => {
  it("coalesces pointer movement into one scheduled delta", () => {
    let callback: (() => void) | undefined;
    const sent: PointerDelta[] = [];
    const moves = createPointerMoveCoalescer(
      (delta) => sent.push(delta),
      (next) => {
        callback = next;
        return 7;
      },
      () => undefined,
    );
    moves.add({ x: 2, y: 3 });
    moves.add({ x: -1, y: 4 });
    expect(sent).toEqual([]);
    callback?.();
    expect(sent).toEqual([{ x: 1, y: 7 }]);
  });

  it("cancels a pending pointer movement", () => {
    const sent: PointerDelta[] = [];
    const cancelled: number[] = [];
    const moves = createPointerMoveCoalescer(
      (delta) => sent.push(delta),
      () => 9,
      (id) => cancelled.push(id),
    );
    moves.add({ x: 2, y: 3 });
    moves.cancel();
    expect(cancelled).toEqual([9]);
    expect(sent).toEqual([]);
  });

  it("treats a short tap as a click", () => {
    expect(trackpadReleaseAction(2)).toBe("click");
    expect(trackpadReleaseAction(40)).toBeNull();
  });

  it("polls faster while the user holds control", () => {
    expect(computerPollMs(false)).toBe(2000);
    expect(computerPollMs(true)).toBe(800);
  });

  it("does not publish a status response after the screen unmounts", () => {
    const screen = source("../app/computer.tsx");
    expect(screen).toContain("let active = true");
    expect(screen).toContain("if (!active) return");
    expect(screen).toContain("active = false");
    expect(screen).toContain("isActive: () => boolean");
    expect(screen).toContain("bootComputer(\n      {");
  });

  it("skips the extra screenUrl RPC when status already has the URL or the viewer is pinned", () => {
    const running = { state: "running", controlHolder: "user", screenAvailable: true };
    expect(
      needsScreenUrlRpc({
        status: { ...running, screenUrl: "https://app/novnc/x" },
        pinnedUrl: null,
      }),
    ).toBe(false);
    expect(needsScreenUrlRpc({ status: running, pinnedUrl: "https://app/novnc/x" })).toBe(false);
    expect(
      needsScreenUrlRpc({ status: { ...running, controlHolder: "bot" }, pinnedUrl: null }),
    ).toBe(false);
    expect(needsScreenUrlRpc({ status: running, pinnedUrl: null })).toBe(true);
  });
});

describe("screenNotice", () => {
  const base = {
    state: "running",
    booting: false,
    hasControl: false,
    error: null,
    lost: false,
    name: "Teste",
  };

  it("explica que a tela precisa do controle, em vez de só escrever o nome do bot", () => {
    const notice = screenNotice(base);
    expect(notice.title).toBe("Assuma o controle para ver a tela");
    expect(notice.action).toBe("take-control");
    expect(notice.title).not.toContain("Tela de");
  });

  it("mostra o erro do WebView com um caminho de volta", () => {
    const notice = screenNotice({ ...base, error: "Este aparelho não alcança a URL da tela." });
    expect(notice.body).toContain("não alcança");
    expect(notice.action).toBe("retry");
  });

  it("trata queda de conexão, computador dormindo e computador parado", () => {
    expect(screenNotice({ ...base, lost: true }).action).toBe("retry");
    expect(screenNotice({ ...base, state: "suspended" }).action).toBe("wake");
    expect(screenNotice({ ...base, state: "stopped" }).action).toBe("boot");
  });

  it("não oferece botão enquanto a tela está abrindo ou conectando", () => {
    expect(screenNotice({ ...base, booting: true }).action).toBeNull();
    expect(screenNotice({ ...base, hasControl: true }).action).toBeNull();
  });
});

describe("allowScreenNavigation", () => {
  const screen = "http://192.168.1.20:5173/novnc/abc/6080/1.sig.control/embed.html";

  it("keeps the webview on the host that serves the screen", () => {
    expect(allowScreenNavigation(`${screen}?view_only=false`, screen)).toBe(true);
    expect(allowScreenNavigation("http://192.168.1.20:5173/outra", screen)).toBe(true);
  });

  it("refuses anywhere else, which is what a hijacked page would try", () => {
    expect(allowScreenNavigation("https://phishing.example/login", screen)).toBe(false);
    // Mesmo host, outra porta, é outro servidor.
    expect(allowScreenNavigation("http://192.168.1.20:9999/", screen)).toBe(false);
    expect(allowScreenNavigation("javascript:alert(1)", screen)).toBe(false);
  });

  it("lets the webview do its own bootstrap", () => {
    expect(allowScreenNavigation("about:blank", screen)).toBe(true);
    expect(allowScreenNavigation("data:text/html,<b>x</b>", screen)).toBe(true);
  });

  it("refuses everything while there is no screen to be on", () => {
    expect(allowScreenNavigation("http://qualquer/", null)).toBe(false);
  });
});
