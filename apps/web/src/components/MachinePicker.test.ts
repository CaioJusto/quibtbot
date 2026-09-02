import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "MachinePicker.tsx"),
  "utf8",
);

describe("MachineCredentials", () => {
  it("asks for the https name the supervisor-tls profile serves, not the unpublished port", () => {
    // A 7091 não é publicada por nenhum profile do Compose: quem atende, quando o operador liga
    // `--profile supervisor-tls`, é o Caddy em 443, pelo nome público. Um placeholder com
    // `:7091` ensina um endereço que não responde.
    expect(src).not.toMatch(/https?:\/\/[^\s"']*:7091/);
    expect(src).toMatch(/placeholder="[^"]*https:\/\/[^"]*"/);
    expect(src).toContain("supervisor-tls");
  });

  it("says the live screen arrives over an SSH tunnel to loopback", () => {
    expect(src).toMatch(/túnel temporário do noVNC até 127\.0\.0\.1/);
    expect(src).toMatch(/Alias SSH do ~\/\.ssh\/config/);
    expect(src).not.toMatch(/painel do computador fica preto/);
  });

  it("keeps using the shared catalog labels instead of inventing copy", () => {
    expect(src).toContain("item.endpointLabel");
    expect(src).toContain("item.keyLabel");
  });
});
