import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.join(here, file), "utf8");

describe("settings panel", () => {
  it("hosts account, machine and phone in one panel with a back stack", () => {
    const panel = source("./SettingsPanel.tsx");
    expect(panel).toContain("AccountSettingsBody");
    expect(panel).toContain("MachineSettingsBody");
    expect(panel).toContain("PhoneConnectBody");
    expect(panel).toContain('aria-label="Voltar"');
  });

  it("replaces the three stacked modals in the shell", () => {
    const shell = source("./Shell.tsx");
    expect(shell).toContain("<SettingsPanel");
    // Um painel só: nada de <Modal title="Conta"> / "Máquina" / "Conectar o celular".
    expect(shell).not.toContain('<Modal title="Conta"');
    expect(shell).not.toContain('<Modal title="Máquina"');
    expect(shell).not.toContain('<Modal title="Conectar o celular"');
  });

  it("abre a Conta direto na aba Modelo pelo menu e pelo erro do composer", () => {
    const panel = source("./SettingsPanel.tsx");
    expect(panel).toContain('models: "Modelo"');
    expect(panel).toContain('initialTab={page === "models" ? "models" : "profile"}');

    // O menu Conta ganhou o item que a mensagem de erro prometia.
    const sheet = source("./AccountSheet.tsx");
    expect(sheet).toContain('label="Modelo" onClick={onModel}');

    // Modelo ausente, chave recusada ou sem crédito: botão "Conectar modelo" no composer.
    const shell = source("./Shell.tsx");
    expect(shell).toContain("needsModelConnection(actionError.message)");
    expect(shell).toContain("Conectar modelo");
    expect(shell).toContain('setSettingsModal("models")');
    expect(shell).toContain("onModel={() => {");
  });
});
