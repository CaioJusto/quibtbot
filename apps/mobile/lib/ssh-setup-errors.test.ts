import { describe, expect, it } from "vitest";
import { sshSetupErrorMessage } from "./ssh-setup-errors.js";

const target = { host: "203.0.113.9", port: 22 };

describe("sshSetupErrorMessage", () => {
  it("says the session never opened, instead of blaming the fingerprint", () => {
    const message = sshSetupErrorMessage(
      new Error("SSH host fingerprint was not returned"),
      target,
    );
    expect(message).toContain("203.0.113.9:22");
    expect(message).toMatch(/sessão SSH/i);
    expect(message).not.toMatch(/impressão digital/i);
  });

  it("keeps a real fingerprint mismatch loud", () => {
    const message = sshSetupErrorMessage(new Error("SSH host fingerprint mismatch"), target);
    expect(message).toMatch(/identidade/i);
    expect(message).toMatch(/no meio/i);
  });

  it("separates refused connection, timeout and refused login", () => {
    expect(sshSetupErrorMessage(new Error("SSH connection failed"), target)).toMatch(/conectar/i);
    expect(sshSetupErrorMessage(new Error("Timed out while reading"), target)).toMatch(
      /não respondeu a tempo/i,
    );
    expect(sshSetupErrorMessage(new Error("Authentication failed"), target)).toMatch(/login/i);
  });

  it("says the server is too modern when the handshake finds no common algorithm", () => {
    const message = sshSetupErrorMessage(new Error("Unable to exchange encryption keys"), target);
    expect(message).toMatch(/criptografia mais nova/i);
    expect(message).toMatch(/computador|VPS/i);
  });

  it("names the missing native module for a stale build", () => {
    const message = sshSetupErrorMessage(
      new Error("Verified SSH is unavailable: install the patched module"),
      target,
    );
    expect(message).toMatch(/versão nova do app/i);
  });

  it("leaves our own Portuguese message alone", () => {
    expect(sshSetupErrorMessage(new Error("Informe a senha SSH."), target)).toBe(
      "Informe a senha SSH.",
    );
  });

  it("survives something that is not an Error", () => {
    expect(sshSetupErrorMessage(undefined, target)).toBe("Não foi possível instalar por SSH.");
    expect(sshSetupErrorMessage({ nope: true }, target)).toBe("[object Object]");
  });
});
