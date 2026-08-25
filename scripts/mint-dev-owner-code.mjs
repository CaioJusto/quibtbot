// biome-ignore lint/suspicious/noUndeclaredEnvVars: the script loads this documented local-only secret from .env
const bootstrapSecret = process.env.BOOTSTRAP_SECRET?.trim();
if (!bootstrapSecret) {
  console.error("Defina BOOTSTRAP_SECRET no arquivo .env antes de emitir o código.");
  process.exitCode = 1;
} else {
  // A porta muda quando alguém já ocupou a 3100; o .env manda, como no resto do dev.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: documented local API address from .env
  const apiUrl = (process.env.API_URL?.trim() || "http://127.0.0.1:3100").replace(/\/+$/, "");
  const response = await fetch(`${apiUrl}/api/bootstrap/invites`, {
    method: "POST",
    headers: { "x-quibt-bootstrap-secret": bootstrapSecret },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const body = await response?.json().catch(() => ({}));
  if (!response?.ok || typeof body?.code !== "string") {
    console.error(
      typeof body?.message === "string"
        ? body.message
        : "Não foi possível emitir o código. Confirme que o API local está ligado.",
    );
    process.exitCode = 1;
  } else {
    console.log(`Código do instalador: ${body.code}`);
    if (typeof body.expiresAt === "string") console.log(`Expira em: ${body.expiresAt}`);
  }
}
