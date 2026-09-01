import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "AgentSettings.tsx"),
  "utf8",
);

describe("AgentSettings MCP servers", () => {
  it("contains the Portuguese add/remove UI and bot MCP RPCs", () => {
    expect(source).toContain("Servidores MCP");
    expect(source).toContain("HTTP sem criptografia é recusado");
    expect(source).toContain("Variáveis de ambiente");
    expect(source).toContain("rpc.botMcp");
    expect(source).toContain(".list({ botId })");
    expect(source).toContain(".add({");
    expect(source).toContain(".remove({ botId, id })");
    expect(source).toContain("Adicionar");
    expect(source).toContain("Remover");
  });
});
