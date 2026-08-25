import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));

function source(relative: string) {
  return readFileSync(path.join(dir, relative), "utf8");
}

describe("mobile plugins screen", () => {
  const screen = source("../app/plugins.tsx");

  it("talks to the same connections.* RPC the web overlay uses", () => {
    expect(screen).toContain('"connections/catalog"');
    expect(screen).toContain('"connections/list"');
    expect(screen).toContain('"connections/begin"');
    expect(screen).toContain('"connections/complete"');
    expect(screen).toContain('"connections/revoke"');
    expect(screen).toContain("pluginCallbackUrl");
    expect(screen).toContain("waitForPluginConnection");
    expect(screen).not.toContain("/plugins/callback?app=1");
  });

  it("opens OAuth in an in-app session that returns to the app", () => {
    expect(screen).toContain("openPluginAuthorization");
    expect(screen).toContain("openAuthSessionAsync");
    expect(screen).toContain("AppState");
  });

  it("is native chrome on the light product surface, not a dark leftover", () => {
    expect(screen).not.toContain("WebView");
    expect(screen).toContain("COLORS.background");
    expect(screen).not.toContain('backgroundColor: "#000"');
    expect(screen).toContain("AppSymbol");
    expect(screen).toContain("puzzlepiece.extension.fill");
    expect(screen).toContain("Switch");
    expect(screen).toContain("RefreshControl");
    expect(screen).toContain("SafeAreaView");
  });

  it("virtualizes plugin rows", () => {
    expect(screen).toContain("<FlatList");
    expect(screen).not.toContain("<ScrollView");
    expect(screen).not.toContain("{visible.map(");
  });

  it("confirms disconnecting in a destructive native sheet", () => {
    expect(screen).toContain("showNativeSheet");
    expect(screen).toContain("destructive: true");
    expect(screen).toContain("Desconectar");
  });

  it("is honest when the server has no Composio key", () => {
    expect(screen).toContain("Nenhum app disponível neste servidor.");
    expect(screen).toContain("não tem o Composio configurado");
  });

  it("stops polling for a connection when the screen goes away", () => {
    expect(screen).toContain("alive.current = false");
    expect(screen).toContain("cancelled: () => !alive.current");
  });

  it("is registered in the stack and reachable from the account screen", () => {
    const layout = source("../app/_layout.tsx");
    expect(layout).toContain('<Stack.Screen name="plugins"');
    expect(layout).toContain("parseAppDeepLink");
    expect(layout).toContain("plugins/callback");
    expect(source("../app/account.tsx")).toContain('router.push("/plugins")');
  });
});

describe("mobile account screen", () => {
  const account = source("../app/account.tsx");

  it("has no e-mail or password to manage — the account lives in the person's Quibt", () => {
    expect(account).not.toContain("changeEmail");
    expect(account).not.toContain("changePassword");
    expect(account).not.toContain("sendVerificationEmail");
  });

  it("lets the person set a profile photo from the gallery or the camera", () => {
    expect(account).toContain("pickAvatar");
    expect(account).toContain("Escolher da galeria");
    expect(account).toContain("Tirar foto");
    expect(account).toContain("updateProfile({ image })");
  });

  it("deletes the account behind a destructive native confirmation", () => {
    expect(account).toContain("deleteAccount");
    expect(account).toContain("Apagar conta");
    expect(account).toContain("destructive: true");
    expect(account).toContain('router.replace("/welcome")');
  });
});
