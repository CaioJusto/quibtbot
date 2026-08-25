import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RemoteUrlRecord {
  url: string;
  savedAt: string;
}

export function remoteUrlFile(userData: string): string {
  return path.join(path.resolve(userData), "remote-url.json");
}

export function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1";
}

export function isPrivateLanHost(hostname: string): boolean {
  if (isLoopbackHost(hostname)) return true;
  const lower = hostname.toLowerCase();
  if (lower.endsWith(".local")) return true;

  const ipv4 = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    return false;
  }

  if (lower.includes(":")) {
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80:")) return true;
  }

  return false;
}

export function normalizeAppUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: "URL vazia." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: "URL inválida." };
  }

  if (parsed.protocol === "javascript:" || parsed.protocol === "file:") {
    return { ok: false, message: "Protocolo não permitido." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: "Credenciais na URL não são permitidas." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "Use http:// ou https://." };
  }

  if (parsed.protocol === "http:" && !isPrivateLanHost(parsed.hostname)) {
    return {
      ok: false,
      message: "HTTP só é permitido para localhost ou rede local (LAN).",
    };
  }

  const normalized = parsed.toString().replace(/\/$/, "") || parsed.origin;
  return { ok: true, url: normalized };
}

export function loadRemoteUrl(userData: string): string | null {
  const target = remoteUrlFile(userData);
  if (!existsSync(target)) return null;
  try {
    const raw = JSON.parse(readFileSync(target, "utf8")) as RemoteUrlRecord;
    if (typeof raw.url !== "string") return null;
    const normalized = normalizeAppUrl(raw.url);
    return normalized.ok ? normalized.url : null;
  } catch {
    return null;
  }
}

export function saveRemoteUrl(userData: string, url: string, savedAt: string): string {
  mkdirSync(userData, { recursive: true });
  const target = remoteUrlFile(userData);
  writeFileSync(target, `${JSON.stringify({ url, savedAt }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return target;
}

export function clearRemoteUrl(userData: string): void {
  const target = remoteUrlFile(userData);
  if (existsSync(target)) unlinkSync(target);
}
