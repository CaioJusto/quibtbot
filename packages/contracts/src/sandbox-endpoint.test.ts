import { describe, expect, it } from "vitest";
import { isAllowedSandboxEndpoint, SandboxEndpointInput } from "./domain.js";

/**
 * O endereço do supervisor remoto recebe o token do supervisor em todo boot, e quem manda
 * no supervisor manda no Docker do host. Por isso o campo é uma política, não um `z.string()`.
 */
describe("sandboxEndpoint", () => {
  it("aceita https público e o loopback do próprio computador", () => {
    expect(isAllowedSandboxEndpoint("https://quibt-a1b2.203.0.113.9.sslip.io")).toBe(true);
    expect(isAllowedSandboxEndpoint("https://minha-vps.example.com:7091")).toBe(true);
    expect(isAllowedSandboxEndpoint("http://127.0.0.1:7091")).toBe(true);
    expect(isAllowedSandboxEndpoint("http://localhost:7091")).toBe(true);
    expect(isAllowedSandboxEndpoint("http://host.docker.internal:7091")).toBe(true);
  });

  it("recusa http fora do loopback: o token iria em claro", () => {
    expect(isAllowedSandboxEndpoint("http://minha-vps.example.com:7091")).toBe(false);
    expect(isAllowedSandboxEndpoint("http://203.0.113.9:7091")).toBe(false);
  });

  it("recusa metadado da nuvem, faixa privada e link-local", () => {
    expect(isAllowedSandboxEndpoint("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedSandboxEndpoint("https://169.254.169.254")).toBe(false);
    expect(isAllowedSandboxEndpoint("https://10.0.0.5:7091")).toBe(false);
    expect(isAllowedSandboxEndpoint("https://192.168.1.10:7091")).toBe(false);
    expect(isAllowedSandboxEndpoint("https://172.16.0.4:7091")).toBe(false);
    expect(isAllowedSandboxEndpoint("https://100.64.0.4:7091")).toBe(false);
    expect(isAllowedSandboxEndpoint("https://[fd00::1]:7091")).toBe(false);
  });

  it("recusa outro esquema, credencial embutida e lixo", () => {
    expect(isAllowedSandboxEndpoint("file:///etc/passwd")).toBe(false);
    expect(isAllowedSandboxEndpoint("https://user:senha@vps.example.com")).toBe(false);
    expect(isAllowedSandboxEndpoint("vps.example.com:7091")).toBe(false);
    expect(isAllowedSandboxEndpoint("")).toBe(false);
  });

  it("o schema do contrato recusa antes de gravar", () => {
    expect(SandboxEndpointInput.safeParse("https://minha-vps.example.com:7091").success).toBe(true);
    expect(SandboxEndpointInput.safeParse("http://203.0.113.9:7091").success).toBe(false);
    expect(SandboxEndpointInput.safeParse("https://169.254.169.254").success).toBe(false);
    expect(
      SandboxEndpointInput.safeParse(`https://vps.example.com/${"a".repeat(2100)}`).success,
    ).toBe(false);
  });
});
