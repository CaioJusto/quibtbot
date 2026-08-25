import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const inbox = readFileSync(path.join(here, "..", "app", "index.tsx"), "utf8");

/**
 * A caixa de entrada se atualiza sozinha a cada 4 s. Sem memória, cada volta do poll
 * recriava as listas e a identidade de cada bot, e a lista inteira — marcas em SVG
 * incluídas — redesenhava à toa. Estas garantias são o que mantém a rolagem lisa.
 */
describe("inbox stays cheap while it polls", () => {
  it("memoizes the rows so a poll tick does not redraw the whole list", () => {
    expect(inbox).toContain("const BotRow = memo(");
    expect(inbox).toContain("const GroupRow = memo(");
    expect(inbox).toContain("const FavoriteBot = memo(");
  });

  it("keeps the derived lists stable between renders", () => {
    for (const derived of ["displayBots", "visibleBots", "inboxItems"]) {
      const at = inbox.indexOf(`const ${derived} = `);
      expect(at, `${derived} deveria existir`).toBeGreaterThan(-1);
      expect(inbox.slice(at, at + 80)).toContain("useMemo");
    }
  });

  it("hands stable callbacks to the rows, or memo would be useless", () => {
    for (const callback of ["openBot", "updateBot", "duplicateBot", "suppressNextOpen"]) {
      const at = inbox.indexOf(`const ${callback} = `);
      expect(at, `${callback} deveria existir`).toBeGreaterThan(-1);
      expect(inbox.slice(at, at + 90)).toContain("useCallback");
    }
    expect(inbox).toContain("const renderInboxItem = useCallback(");
  });
});
