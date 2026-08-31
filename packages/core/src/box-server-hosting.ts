export const BOX_WEB_PORT = 5173;
export const BOX_INSTALL_MISSING_EXIT_CODE = 42;
export const BOX_PUBLIC_PROXY_ENV = "QUIBT_PUBLIC_PROXY_URL";

const BOX_HOST_SUFFIX = `-${BOX_WEB_PORT}.on.ascii.dev`;

/**
 * Box exposes a hosted port through its own TLS proxy. Only accept the exact
 * HTTPS origin produced for Quibt's web port; accepting an arbitrary URL here
 * would let command output redirect the owner-creation credential elsewhere.
 */
export function normalizeBoxHostedUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const hostname = url.hostname.toLowerCase();
    const prefix = hostname.slice(0, -BOX_HOST_SUFFIX.length);
    if (
      url.protocol !== "https:" ||
      !hostname.endsWith(BOX_HOST_SUFFIX) ||
      !prefix ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(prefix) ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function parseBoxHostedUrl(output: string): string | null {
  const candidates = output.match(/https:\/\/[^\s"'<>]+/gi) ?? [];
  for (const candidate of candidates) {
    const normalized = normalizeBoxHostedUrl(candidate.replace(/[),.;]+$/, ""));
    if (normalized) return normalized;
  }
  return null;
}

export function buildBoxHostCommand(): string {
  return `host ${BOX_WEB_PORT} --title "Quibt Bot" --public`;
}

function boxInstallPreamble(): string[] {
  return [
    "set -eu",
    `data_dir="\${XDG_DATA_HOME:-$HOME/.local/share}/quibt"`,
    'env_file="$data_dir/quibt.env"',
    'compose_file="$data_dir/compose/docker-compose.desktop.yml"',
    'if [ ! -s "$env_file" ] || [ ! -s "$compose_file" ]; then',
    '  echo "QUIBT_BOX_INSTALL_MISSING" >&2',
    `  exit ${BOX_INSTALL_MISSING_EXIT_CODE}`,
    "fi",
    "set_env() {",
    '  key="$1"',
    '  value="$2"',
    '  tmp="$env_file.tmp.$$"',
    '  awk -v key="$key" -v value="$value" \'BEGIN { found=0 } { if (substr($0, 1, length(key) + 1) == key "=") { if (!found) print key "=" value; found=1 } else print } END { if (!found) print key "=" value }\' "$env_file" > "$tmp"',
    '  chmod 600 "$tmp"',
    '  mv "$tmp" "$env_file"',
    "}",
    "remove_env() {",
    '  key="$1"',
    '  tmp="$env_file.tmp.$$"',
    '  awk -v key="$key" \'substr($0, 1, length(key) + 1) != key "=" { print }\' "$env_file" > "$tmp"',
    '  chmod 600 "$tmp"',
    '  mv "$tmp" "$env_file"',
    "}",
  ];
}

/** Detects an existing install, opens only the web port, and restarts the web service. */
export function buildBoxHostingPreparationShell(): string {
  return [
    ...boxInstallPreamble(),
    'set_env "QUIBT_WEB_BIND_HOST" "0.0.0.0"',
    'docker compose -f "$compose_file" --env-file "$env_file" up -d web',
    'echo "QUIBT_BOX_INSTALL_READY"',
  ].join("\n");
}

/**
 * Makes the Box proxy origin authoritative, recreates services with the new auth
 * origin, waits for the local API, and returns a fresh first-owner invite.
 */
export function buildBoxPublicConfigurationShell(publicUrl: string): string {
  const origin = normalizeBoxHostedUrl(publicUrl);
  if (!origin) throw new Error("Invalid Box hosted URL.");
  const safeOrigin = JSON.stringify(origin);
  const ownerScript = [
    `const publicUrl = ${safeOrigin};`,
    "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
    "async function readJson(response) { const text = await response.text(); try { return JSON.parse(text); } catch { throw new Error('Quibt API returned malformed JSON'); } }",
    "let health;",
    "for (let attempt = 0; attempt < 60; attempt += 1) {",
    "  try {",
    "    const response = await fetch('http://127.0.0.1:3100/rpc/health', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: {} }) });",
    "    if (response.ok) { const body = await readJson(response); if (body?.json?.ok === true && typeof body.json.needsFirstOwner === 'boolean') { health = body.json; break; } }",
    "  } catch {}",
    "  await sleep(2000);",
    "}",
    "if (!health) throw new Error('Quibt API did not become healthy inside the Box');",
    "console.log('URL: ' + publicUrl);",
    "if (health.needsFirstOwner) {",
    "  const secret = process.env.BOOTSTRAP_SECRET || '';",
    "  if (!secret) throw new Error('BOOTSTRAP_SECRET is missing');",
    "  const response = await fetch('http://127.0.0.1:3100/api/bootstrap/invites', { method: 'POST', headers: { 'x-quibt-bootstrap-secret': secret } });",
    "  const invite = await readJson(response);",
    "  if (!response.ok || typeof invite.code !== 'string' || typeof invite.token !== 'string' || typeof invite.expiresAt !== 'string') throw new Error('Could not create a fresh Box owner invite');",
    "  console.log('Code: ' + invite.code);",
    "  console.log('Token: ' + invite.token);",
    "  console.log('Expires: ' + invite.expiresAt);",
    "} else {",
    "  console.log('QUIBT_BOX_ALREADY_CLAIMED');",
    "}",
  ].join("\n");

  return [
    ...boxInstallPreamble(),
    `origin=${safeOrigin}`,
    'remove_env "QUIBT_PUBLIC_HOST"',
    `set_env "${BOX_PUBLIC_PROXY_ENV}" "$origin"`,
    'set_env "QUIBT_WEB_BIND_HOST" "0.0.0.0"',
    'set_env "QUIBT_API_BIND_HOST" "127.0.0.1"',
    'set_env "WEB_ORIGIN" "$origin"',
    'set_env "BETTER_AUTH_URL" "$origin"',
    'set_env "API_URL" "$origin"',
    'docker compose -f "$compose_file" --env-file "$env_file" --profile public stop caddy >/dev/null 2>&1 || true',
    'docker compose -f "$compose_file" --env-file "$env_file" up -d supervisor api worker web computer',
    'docker compose -f "$compose_file" --env-file "$env_file" exec -T api node <<\'QUIBT_BOX_OWNER\'',
    ownerScript,
    "QUIBT_BOX_OWNER",
  ].join("\n");
}

export interface ProbeBoxHostedUrlOptions {
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The hosted URL is usable only after the phone-facing Quibt RPC answers. */
export async function probeBoxHostedUrl(
  publicUrl: string,
  fetchImpl: typeof fetch = fetch,
  options: ProbeBoxHostedUrlOptions = {},
): Promise<boolean> {
  const origin = normalizeBoxHostedUrl(publicUrl);
  if (!origin) return false;
  const attempts = options.attempts ?? 15;
  const delayMs = options.delayMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 5_000;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw new Error("Remote install cancelled");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(`${origin}/rpc/health`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "quibt://" },
        body: JSON.stringify({ json: {} }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        json?: { ok?: unknown };
      };
      if (response.ok && body.json?.ok === true) return true;
    } catch {
      // The Box proxy and the recreated web container can become ready independently.
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
    if (attempt + 1 < attempts) await delay(delayMs);
  }
  return false;
}
