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
});
