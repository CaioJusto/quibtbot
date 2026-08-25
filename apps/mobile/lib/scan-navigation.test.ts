import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scan = readFileSync(path.join(import.meta.dirname, "..", "app", "scan.tsx"), "utf8");

describe("leitor de QR → pareamento", () => {
  it("substitui o modal da câmera em vez de empilhar por cima dele", () => {
    // O /scan é um modal (presentation: "modal" no _layout). Um push deixava a câmera
    // viva por baixo de cadastro, onboarding e chat — a pessoa via o QR "no fundo" e
    // achava que nada tinha sido salvo, embora o servidor já tivesse tudo.
    const bootstrapBlock = scan.slice(
      scan.indexOf("parseBootstrapDeepLink(data)"),
      scan.indexOf("applyConnectLink(data)"),
    );
    expect(bootstrapBlock).toContain('pathname: "/pair-installation"');
    expect(bootstrapBlock).toContain("router.replace(");
    expect(bootstrapBlock).not.toContain("router.push(");
  });

  it("continua sendo um modal no layout", () => {
    const layout = readFileSync(path.join(import.meta.dirname, "..", "app", "_layout.tsx"), "utf8");
    expect(layout).toMatch(/name="scan"[^\n]*presentation: "modal"/);
  });
});
