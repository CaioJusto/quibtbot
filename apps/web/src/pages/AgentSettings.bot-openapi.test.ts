import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "AgentSettings.tsx"),
  "utf8",
);

describe("AgentSettings OpenAPI tools", () => {
  it("contains the Portuguese add/remove UI and bot OpenAPI RPCs", () => {
    expect(source).toContain("Ferramentas OpenAPI");
    expect(source).toContain("Somente HTTPS; HTTP é");
    expect(source).toContain("GET é leitura");
    expect(source).toContain("cards de aprovação");
    expect(source).toContain("rpc.botOpenApi");
    expect(source).toContain(".list({ botId })");
    expect(source).toContain(".add({ botId, name: cleanName, url: cleanUrl })");
    expect(source).toContain(".remove({ botId, id })");
    expect(source).toContain("Adicionar");
    expect(source).toContain("Remover");
  });
});
