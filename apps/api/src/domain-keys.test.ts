import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { desktopSessionCapability } from "../../desktop/src/local-session.js";
import { resolveNovncTarget } from "../../web/src/screen-proxy.js";
import {
  consumeDesktopSessionCapability,
  desktopSessionKey,
  internalProxyKey,
  internalProxyProof,
  screenCapabilityKey,
} from "./app.js";
import { addScreenProxyCapability } from "./screen-proxy.js";

const AUTH_SECRET = "test-auth-secret-32-characters-long";
const SCREEN_URL = "http://127.0.0.1:6080/vnc.html?view_only=false";
const PROXY_ORIGIN = "http://127.0.0.1:5173";

function capabilityPath(secret: string): string {
  const signed = addScreenProxyCapability(SCREEN_URL, secret, PROXY_ORIGIN);
  return signed.slice(PROXY_ORIGIN.length);
}

/**
 * Uma chave, um trabalho. O `BETTER_AUTH_SECRET` assina o cookie de sessão; a tela e a
 * prova de proxy interno passam a usar chaves derivadas com rótulo próprio, como o token
 * do supervisor e o `BOOTSTRAP_SECRET` já fazem em `packages/core/src/secrets-guard.ts`.
 * Assim uma URL de tela vazada deixa de ser oráculo de HMAC da chave de sessão.
 */
describe("chaves separadas por domínio", () => {
  it("nenhuma delas é o segredo de auth cru", () => {
    expect(screenCapabilityKey(AUTH_SECRET)).not.toBe(AUTH_SECRET);
    expect(internalProxyKey(AUTH_SECRET)).not.toBe(AUTH_SECRET);
    expect(screenCapabilityKey(AUTH_SECRET)).not.toBe(internalProxyKey(AUTH_SECRET));
  });

  it("a capacidade de tela só vale com a chave do domínio da tela", () => {
    const signed = capabilityPath(screenCapabilityKey(AUTH_SECRET));
    expect(resolveNovncTarget(signed, screenCapabilityKey(AUTH_SECRET))).not.toBeNull();
    // Chave de outro domínio (e o segredo cru) não abrem a tela.
    expect(resolveNovncTarget(signed, internalProxyKey(AUTH_SECRET))).toBeNull();
    expect(resolveNovncTarget(signed, AUTH_SECRET)).toBeNull();
  });

  it("uma capacidade assinada com a chave do proxy interno não vale na tela", () => {
    const signed = capabilityPath(internalProxyKey(AUTH_SECRET));
    expect(resolveNovncTarget(signed, screenCapabilityKey(AUTH_SECRET))).toBeNull();
  });

  it("a prova de proxy interno vem da chave do proxy, não da chave da tela", () => {
    expect(internalProxyProof(AUTH_SECRET)).toBe(
      createHmac("sha256", internalProxyKey(AUTH_SECRET))
        .update("quibt-local-browser-proxy-v1")
        .digest("base64url"),
    );
    expect(internalProxyProof(AUTH_SECRET)).not.toBe(
      createHmac("sha256", screenCapabilityKey(AUTH_SECRET))
        .update("quibt-local-browser-proxy-v1")
        .digest("base64url"),
    );
    expect(internalProxyProof(AUTH_SECRET)).not.toBe(
      createHmac("sha256", AUTH_SECRET).update("quibt-local-browser-proxy-v1").digest("base64url"),
    );
  });

  it("o web deriva as mesmas chaves que a API", () => {
    // O `vite.config.ts` não pode importar `@quibt/core` nem a API (ver o comentário em
    // `apps/web/src/build-config.ts`), então a derivação é espelhada lá. Se um lado mudar
    // de rótulo sem o outro, a tela fica preta e o auto-login local para de valer.
    const config = readFileSync(path.join(import.meta.dirname, "../../web/vite.config.ts"), "utf8");
    expect(config).toContain('"quibt-bot/screen-capability/v1"');
    expect(config).toContain('"quibt-bot/internal-proxy-proof/v1"');
    expect(config).toContain('createHmac("sha256", authSecret).update(label).digest("base64url")');
  });

  it("a chave do desktop é um terceiro domínio, e a API aceita o que o desktop assina", () => {
    expect(desktopSessionKey(AUTH_SECRET)).not.toBe(AUTH_SECRET);
    expect(desktopSessionKey(AUTH_SECRET)).not.toBe(screenCapabilityKey(AUTH_SECRET));
    expect(desktopSessionKey(AUTH_SECRET)).not.toBe(internalProxyKey(AUTH_SECRET));
    // O mesmo valor dos dois lados: o desktop assina, a API verifica.
    const capability = desktopSessionCapability({
      authSecret: AUTH_SECRET,
      method: "POST",
      path: "/api/local/session",
    });
    expect(
      consumeDesktopSessionCapability(capability, {
        authSecret: AUTH_SECRET,
        method: "POST",
        path: "/api/local/session",
        used: new Map<string, number>(),
      }),
    ).toBe(true);
  });

  it("uma capacidade de tela não vira capacidade de sessão do desktop", () => {
    const signed = capabilityPath(desktopSessionKey(AUTH_SECRET));
    expect(resolveNovncTarget(signed, screenCapabilityKey(AUTH_SECRET))).toBeNull();
  });
});
