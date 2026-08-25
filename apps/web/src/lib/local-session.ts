/**
 * Entrar sozinho na máquina onde o Quibt roda.
 *
 * A conta mora nesta instalação. Quem abre o app aqui está no teclado do computador
 * que a hospeda — a mesma prova que criou a conta. Pedir login a cada abertura só
 * inventava um passo. De fora (celular, outra máquina, VPS), isto não responde: lá
 * a entrada é por código, com aprovação de quem já está dentro.
 */
export function isLoopbackOrigin(host = window.location.hostname): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export async function claimLocalSession(): Promise<boolean> {
  if (!isLoopbackOrigin()) return false;
  const res = await fetch("/api/local/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: "{}",
  }).catch(() => null);
  return Boolean(res?.ok);
}
