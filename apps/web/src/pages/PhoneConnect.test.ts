import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "PhoneConnect.tsx"),
  "utf8",
);

describe("phone connect", () => {
  it("pairs by the same account and a QR of the server URL", () => {
    expect(src).toContain("connectDeepLink");
    expect(src).toContain("lanInfo");
    expect(src).toContain("computador desligado");
  });

  it("only puts a login inside the QR after the owner approves it here", () => {
    // Sem o clique, o QR só carrega o endereço: quem fotografar a tela não entra.
    expect(src).toContain("Liberar entrada por 2 minutos");
    expect(src).toContain("oneTimeToken.generate()");
    expect(src).toContain("connectDeepLink(api, pair)");
    expect(src).toContain("useState<string | null>(null)");
    // O código expira sozinho na tela e morre junto com ela.
    expect(src).toContain("expira em {clock}");
    expect(src).toContain("clearInterval(timer.current)");
  });

  it("can point a local PC QR at a user-owned HTTPS tunnel instead of the LAN", () => {
    expect(src).toContain('reach === "remote"');
    expect(src).toContain("Qualquer rede");
    expect(src).toContain("normalizeRemoteConnectApi");
    expect(src).toContain("webhookPublicUrl");
    expect(src).toContain("localPhoneTunnelCommand");
    expect(src).toContain("não hospeda");
    expect(src).toContain("https://");
  });

  it("explains that a desktop already on a VPS gives that VPS directly to the phone", () => {
    expect(src).toContain("Este desktop já está numa VPS");
    expect(src).toContain("diretamente a ela");
    expect(src).toContain("sem passar");
  });
});
