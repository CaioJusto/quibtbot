import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Como este app prova que é o dono desta máquina.
 *
 * A stack empacotada roda em Docker, e ali o navegador do dono chega à API com o mesmo
 * endereço de origem (`172.17.0.1`) de qualquer aparelho do Wi-Fi — a porta 3100 é
 * publicada em `0.0.0.0` de propósito, para o QR do celular funcionar. Posição de rede,
 * portanto, não separa ninguém. O que separa é o segredo da instalação: este app escreve e
 * lê o `quibt.env` (modo 0600), e ninguém mais no Wi-Fi tem esse arquivo.
 *
 * A capacidade é derivada com rótulo próprio (nunca o `BETTER_AUTH_SECRET` cru, nunca o
 * rótulo do proxy interno), vale um minuto, serve uma vez só e está presa ao método e ao
 * caminho da requisição. Espelho de `apps/api/src/app.ts`, que verifica — os dois lados
 * precisam derivar o MESMO valor.
 */
export const DESKTOP_SESSION_LABEL = "quibt-bot/desktop-local-session/v1";
export const DESKTOP_CAPABILITY_HEADER = "x-quibt-desktop-session";
export const LOCAL_SESSION_PATH = "/api/local/session";

export function deriveDomainKey(authSecret: string, label: string): string {
  return createHmac("sha256", authSecret).update(label).digest("base64url");
}

export function desktopSessionKey(authSecret: string): string {
  return deriveDomainKey(authSecret, DESKTOP_SESSION_LABEL);
}

export function desktopSessionCapability(input: {
  authSecret: string;
  method: string;
  path: string;
  issuedAt?: number;
  nonce?: string;
}): string {
  const issuedAt = input.issuedAt ?? Date.now();
  const nonce = input.nonce ?? randomBytes(12).toString("base64url");
  const signature = createHmac("sha256", desktopSessionKey(input.authSecret))
    .update(`v1:${input.method.toUpperCase()}:${input.path}:${issuedAt}:${nonce}`)
    .digest("base64url");
  return `v1.${issuedAt}.${nonce}.${signature}`;
}

/**
 * O segredo da instalação local, lido do `quibt.env`. Devolve `null` quando o arquivo não
 * existe ou não tem a chave: sem segredo não se inventa confiança nenhuma — o app
 * simplesmente não manda o cabeçalho e a pessoa entra pela tela de login de sempre.
 */
export function desktopAuthSecretFromEnvFile(
  envFile: string,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): string | null {
  let content: string;
  try {
    content = read(envFile);
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*BETTER_AUTH_SECRET\s*=\s*(.*)$/);
    if (!match) continue;
    const value = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
    return value || null;
  }
  return null;
}

/** A rota de sessão local, e só ela, na origem do web que este app abriu. */
export function isLocalSessionRequest(requestUrl: string, webUrl: string): boolean {
  try {
    const request = new URL(requestUrl);
    const web = new URL(webUrl);
    if (request.origin !== web.origin) return false;
    if (request.pathname !== LOCAL_SESSION_PATH) return false;
    // Servidor remoto (VPS, Box): o segredo desta máquina não sai daqui.
    return web.hostname === "127.0.0.1" || web.hostname === "localhost" || web.hostname === "[::1]";
  } catch {
    return false;
  }
}
