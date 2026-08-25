import { describe, expect, it } from "vitest";
import {
  deploymentSignupDenial,
  isLoopbackAddress,
  isLoopbackMintPeer,
  isTrustedOrigin,
  readinessPayload,
  requestIsFromThisMachine,
} from "./app.js";
import type { AppEnv } from "./env.js";

function env(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    nodeEnv: "production",
    webOrigin: "https://app.example.com",
    apiUrl: "https://api.example.com",
    authUrl: "https://auth.example.com",
    trustedWebOrigins: [],
    ...overrides,
  } as AppEnv;
}

describe("isTrustedOrigin", () => {
  it("rejects loopback in production", () => {
    expect(isTrustedOrigin("", env())).toBe(false);
    expect(isTrustedOrigin("http://localhost:8081", env())).toBe(false);
    expect(isTrustedOrigin("http://127.0.0.1:19006", env())).toBe(false);
  });

  it("accepts configured extra origins in production", () => {
    expect(
      isTrustedOrigin(
        "https://admin.example.com",
        env({ trustedWebOrigins: ["https://admin.example.com"] }),
      ),
    ).toBe(true);
  });

  it("accepts loopback in development", () => {
    expect(isTrustedOrigin("", env({ nodeEnv: "development" }))).toBe(true);
    expect(isTrustedOrigin("http://localhost:8081", env({ nodeEnv: "development" }))).toBe(true);
  });

  it("accepts the app schemes in production", () => {
    expect(isTrustedOrigin("quibt://billing", env())).toBe(true);
  });
});

describe("readinessPayload", () => {
  it("maps the database ping result without checking optional providers", () => {
    expect(readinessPayload(true)).toEqual({ body: { ok: true }, status: 200 });
    expect(readinessPayload(false)).toEqual({
      body: { ok: false },
      status: 503,
    });
  });
});

describe("deploymentSignupDenial", () => {
  const open = { signupsEnabled: true, signupAllowlist: null };

  it("refuses accounts once the owner closes signups in the deployment screen", () => {
    expect(deploymentSignupDenial(open, "new@example.com")).toBeNull();
    expect(deploymentSignupDenial({ ...open, signupsEnabled: false }, "new@example.com")).toMatch(
      /não está aceitando/,
    );
  });

  it("applies the saved allowlist, not only the one from the process env", () => {
    const settings = {
      signupsEnabled: true,
      signupAllowlist: "@quibt.com.br,boss@example.com",
    };
    expect(deploymentSignupDenial(settings, "someone@quibt.com.br")).toBeNull();
    expect(deploymentSignupDenial(settings, "boss@example.com")).toBeNull();
    expect(deploymentSignupDenial(settings, "stranger@example.com")).toMatch(/não pode criar/);
  });

  it("stays quiet when there is no settings row to consult", () => {
    expect(deploymentSignupDenial(null, "new@example.com")).toBeNull();
  });
});

describe("isLoopbackAddress", () => {
  it("only trusts the machine itself, and never a header the client picks", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    // Redefinir a senha sem e-mail só pode valer para quem está no computador.
    expect(isLoopbackAddress("192.168.0.10")).toBe(false);
    expect(isLoopbackAddress("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("isLoopbackMintPeer", () => {
  it("only trusts the transport socket for bootstrap minting", () => {
    expect(isLoopbackMintPeer("127.0.0.1")).toBe(true);
    expect(isLoopbackMintPeer("::1")).toBe(true);
    expect(isLoopbackMintPeer("203.0.113.10")).toBe(false);
    expect(isLoopbackMintPeer(undefined)).toBe(false);
  });
});

describe("requestIsFromThisMachine", () => {
  it("trusts the raw socket when no proxy sits in front", () => {
    expect(requestIsFromThisMachine("127.0.0.1", undefined, [])).toBe(true);
    expect(requestIsFromThisMachine("192.168.0.10", undefined, [])).toBe(false);
    expect(requestIsFromThisMachine("127.0.0.1", "192.168.0.55", [])).toBe(false);
    expect(requestIsFromThisMachine("127.0.0.1", "127.0.0.1", [])).toBe(false);
  });

  it("does not let a reverse proxy turn the whole LAN into localhost", () => {
    // Atrás do proxy do self-host, TODO navegador chega com socket de loopback: o do
    // proxy. Sem esta checagem, qualquer um na rede pediria link de redefinição.
    const proxies = ["127.0.0.1"];
    expect(requestIsFromThisMachine("127.0.0.1", "192.168.0.55", proxies)).toBe(false);
    expect(requestIsFromThisMachine("127.0.0.1", "127.0.0.1", proxies)).toBe(true);
    expect(requestIsFromThisMachine("127.0.0.1", "::ffff:127.0.0.1", proxies)).toBe(true);
    // Proxy que não anuncia o cliente não serve para decidir: recusa.
    expect(requestIsFromThisMachine("127.0.0.1", undefined, proxies)).toBe(false);
    expect(requestIsFromThisMachine("127.0.0.1", "", proxies)).toBe(false);
  });
});
