import { createHmac } from "node:crypto";

/**
 * Espelho de `deriveDomainKey`/`internalProxyProof` de `apps/api/src/app.ts`.
 *
 * O servidor web não importa `@quibt/core` nem a API: os pacotes do workspace exportam
 * TypeScript cru e este módulo também é carregado diretamente pelo Vite. Os testes de
 * domínio garantem que os dois lados continuem usando exatamente os mesmos rótulos.
 */
export const SCREEN_CAPABILITY_LABEL = "quibt-bot/screen-capability/v1";
export const INTERNAL_PROXY_LABEL = "quibt-bot/internal-proxy-proof/v1";

export function deriveDomainKey(authSecret: string, label: string): string {
  return createHmac("sha256", authSecret).update(label).digest("base64url");
}

export function screenProxySecret(authSecret: string): string {
  return deriveDomainKey(authSecret, SCREEN_CAPABILITY_LABEL);
}

export function internalProxyProof(authSecret: string): string {
  return createHmac("sha256", deriveDomainKey(authSecret, INTERNAL_PROXY_LABEL))
    .update("quibt-local-browser-proxy-v1")
    .digest("base64url");
}
