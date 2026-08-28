import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  apiBaseWarning,
  defaultApiBase,
  displayApiHost,
  normalizeApiBase,
  PROBE_TIMEOUT_MS,
  probeApiBase,
  usesCustomApiBase,
} from "./endpoint.js";

describe("normalizeApiBase", () => {
  it("trims, adds https, and keeps only the origin", () => {
    expect(normalizeApiBase("  app.example.com/rpc  ")).toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    expect(normalizeApiBase("https://quibt.example.com:8443/api/")).toEqual({
      ok: true,
      url: "https://quibt.example.com:8443",
    });
    expect(normalizeApiBase("http://192.168.1.20:3100/")).toMatchObject({
      ok: false,
    });
  });

  it("accepts a Tailscale address over http, the recommended path off the home wifi", () => {
    expect(normalizeApiBase("http://100.101.102.103:3100")).toEqual({
      ok: true,
      url: "http://100.101.102.103:3100",
    });
    expect(normalizeApiBase("http://meu-mac.tail1234.ts.net:3100")).toEqual({
      ok: true,
      url: "http://meu-mac.tail1234.ts.net:3100",
    });
    // 100.0.x e 100.128.x ficam fora do CGNAT: são internet pública, exigem https.
    expect(normalizeApiBase("http://100.0.0.1:3100")).toMatchObject({
      ok: false,
    });
    expect(normalizeApiBase("http://100.128.0.1:3100")).toMatchObject({
      ok: false,
    });
  });

  it("rejects empty, non-http, and malformed values", () => {
    expect(normalizeApiBase("")).toMatchObject({ ok: false });
    expect(normalizeApiBase("   ")).toMatchObject({ ok: false });
    expect(normalizeApiBase("javascript:alert(1)")).toMatchObject({
      ok: false,
    });
    expect(normalizeApiBase("ftp://files.example.com")).toMatchObject({
      ok: false,
    });
    expect(normalizeApiBase("http://")).toMatchObject({ ok: false });
    expect(normalizeApiBase("http://app.example.com")).toEqual({
      ok: false,
      error: "Use https:// ou um endereço Tailscale. A rede Wi-Fi comum não protege sua sessão.",
    });
  });

  it("strips credentials from the stored origin", () => {
    expect(normalizeApiBase("https://user:pass@app.example.com/rpc")).toEqual({
      ok: true,
      url: "https://app.example.com",
    });
  });
});

describe("display and warnings", () => {
  it("shows host and non-default port", () => {
    expect(displayApiHost("https://quibt.example.com")).toBe("quibt.example.com");
    expect(displayApiHost("http://10.0.0.8:3100")).toBe("10.0.0.8:3100");
  });

  it("warns on unencrypted HTTP outside loopback or Tailscale", () => {
    expect(apiBaseWarning("https://app.example.com")).toBeNull();
    expect(apiBaseWarning("http://127.0.0.1:3100")).toBeNull();
    expect(apiBaseWarning("http://192.168.1.20:3100")).toMatch(/https|Tailscale/i);
    expect(apiBaseWarning("http://app.example.com")).toMatch(/https/i);
  });

  it("treats the compile-time default as not custom", () => {
    expect(usesCustomApiBase(defaultApiBase())).toBe(false);
    expect(usesCustomApiBase("https://quibt.example.com")).toBe(true);
  });
});

describe("probeApiBase", () => {
  it("accepts a Quibt Bot /rpc/health response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ json: { ok: true, version: "0.1.0" } }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    await expect(probeApiBase("https://app.example.com", fetchImpl)).resolves.toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    expect(PROBE_TIMEOUT_MS).toBe(4_000);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.example.com/rpc/health",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects a host that is up but is not Quibt Bot", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(probeApiBase("https://example.com", fetchImpl)).resolves.toMatchObject({
      ok: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a single network drop before giving up", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ json: { ok: true } }), { status: 200 }),
      ) as unknown as typeof fetch;
    await expect(probeApiBase("https://app.example.com", fetchImpl)).resolves.toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("mobile custom server UI", () => {
  it("aponta o app para o servidor certo e entra por código, sem senha", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const enterCode = readFileSync(path.join(dir, "../app/enter-code.tsx"), "utf8");
    const server = readFileSync(path.join(dir, "../app/server.tsx"), "utf8");
    const setupBox = readFileSync(path.join(dir, "../app/setup-ssh.tsx"), "utf8");
    const welcome = readFileSync(path.join(dir, "../app/welcome.tsx"), "utf8");
    const api = readFileSync(path.join(dir, "api.ts"), "utf8");
    expect(server).toContain("saveApiBase");
    expect(server).toContain("probeApiBase");
    // A porta de entrada diz em qual servidor o app está e oferece o QR e o código.
    expect(welcome).toContain("Ler QR code");
    expect(welcome).toContain("Tenho um código");
    expect(welcome).toContain("Só tenho o celular");
    expect(welcome).toContain("Instalar no Box ou numa VPS");
    expect(welcome).toContain('params: { kind: "box" }');
    expect(welcome).toContain('router.push("/scan")');
    expect(welcome).toContain("displayApiHost(apiBase)");
    expect(welcome.indexOf('label="Ler QR code"')).toBeLessThan(
      welcome.indexOf("<View style={styles.paths}>"),
    );
    expect(welcome).not.toContain('label="Criar minha conta"');
    expect(setupBox).toContain("não é a chave da Hetzner");
    expect(setupBox).toContain("servidor de teste fica ligado por até 2 horas");
    // Entrar é digitar o código que outro aparelho mostra, e esperar o sim de lá.
    expect(enterCode).toContain("requestSignInWithCode");
    expect(api).toContain("currentApiBase()");
    expect(api).not.toMatch(/export const API /);
  });

  it("não sobrou nada de e-mail e senha no celular", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const app = path.join(dir, "../app");
    // As telas de senha saíram do produto: entrar é por código, com aprovação.
    for (const gone of ["sign-in.tsx", "forgot-password.tsx", "reset-password.tsx"]) {
      expect(existsSync(path.join(app, gone))).toBe(false);
    }
    const api = readFileSync(path.join(dir, "api.ts"), "utf8");
    expect(api).not.toContain("export async function signIn(");
    expect(api).not.toContain("export async function resetPassword(");
  });
});
