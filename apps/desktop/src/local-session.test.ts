import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_CAPABILITY_HEADER,
  desktopAuthSecretFromEnvFile,
  desktopSessionCapability,
  isLocalSessionRequest,
} from "./local-session.js";

const AUTH_SECRET = "test-auth-secret-32-characters-long";

/**
 * O app do desktop já administra a stack: ele escreve e lê o `quibt.env` (modo 0600).
 * Provar posse desse segredo é o que vale, e não o endereço de rede — com a stack em
 * Docker o dono chega com o mesmo `172.17.0.1` de qualquer aparelho do Wi-Fi.
 */
describe("capacidade local do desktop", () => {
  it("lê o BETTER_AUTH_SECRET do quibt.env e ignora arquivo ausente ou sem a chave", () => {
    const file = [
      "QUIBT_EDITION=oss",
      `BETTER_AUTH_SECRET=${AUTH_SECRET}`,
      "ENCRYPTION_KEY=outra-coisa",
      "",
    ].join("\n");
    expect(desktopAuthSecretFromEnvFile("quibt.env", () => file)).toBe(AUTH_SECRET);
    expect(
      desktopAuthSecretFromEnvFile("quibt.env", () => 'BETTER_AUTH_SECRET="entre aspas"'),
    ).toBe("entre aspas");
    expect(desktopAuthSecretFromEnvFile("quibt.env", () => "ENCRYPTION_KEY=x")).toBeNull();
    expect(
      desktopAuthSecretFromEnvFile("quibt.env", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });

  it("assina com a chave do domínio do desktop, presa ao método, caminho e instante", () => {
    const capability = desktopSessionCapability({
      authSecret: AUTH_SECRET,
      method: "POST",
      path: "/api/local/session",
      issuedAt: 1_700_000_000_000,
      nonce: "abc123",
    });
    const key = createHmac("sha256", AUTH_SECRET)
      .update("quibt-bot/desktop-local-session/v1")
      .digest("base64url");
    const expected = createHmac("sha256", key)
      .update("v1:POST:/api/local/session:1700000000000:abc123")
      .digest("base64url");
    expect(capability).toBe(`v1.1700000000000.abc123.${expected}`);
  });

  it("gera um nonce novo a cada chamada", () => {
    const first = desktopSessionCapability({
      authSecret: AUTH_SECRET,
      method: "POST",
      path: "/api/local/session",
    });
    const second = desktopSessionCapability({
      authSecret: AUTH_SECRET,
      method: "POST",
      path: "/api/local/session",
    });
    expect(first).not.toBe(second);
  });

  it("só reconhece a rota de sessão local na origem do próprio web", () => {
    expect(
      isLocalSessionRequest("http://127.0.0.1:5173/api/local/session", "http://127.0.0.1:5173"),
    ).toBe(true);
    expect(
      isLocalSessionRequest("http://127.0.0.1:5173/api/auth/sign-in", "http://127.0.0.1:5173"),
    ).toBe(false);
    // Servidor remoto: o segredo desta máquina não vai junto.
    expect(
      isLocalSessionRequest(
        "https://quibt.example.com/api/local/session",
        "https://quibt.example.com",
      ),
    ).toBe(false);
    expect(
      isLocalSessionRequest("http://outro.example/api/local/session", "http://127.0.0.1:5173"),
    ).toBe(false);
  });
});

describe("a janela do desktop manda a capacidade", () => {
  const main = readFileSync(path.join(import.meta.dirname, "main.ts"), "utf8");

  it("injeta o cabeçalho no pedido de sessão local e nada mais", () => {
    expect(main).toContain("registerLocalSessionCapabilityBridge");
    expect(main).toContain("isLocalSessionRequest");
    expect(main).toContain("DESKTOP_CAPABILITY_HEADER");
    expect(DESKTOP_CAPABILITY_HEADER).toBe("x-quibt-desktop-session");
    expect(main).toContain("desktopSessionCapability");
  });

  it("cai no login normal quando o segredo local não está acessível", () => {
    // Sem segredo, nada de cabeçalho inventado: a API responde 404 e a tela de login aparece.
    expect(main).toContain("desktopAuthSecretFromEnvFile");
    expect(main).toMatch(/if \(!secret\)|secret \?\?|!authSecret/);
  });
});
