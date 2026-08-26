import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const executor = readFileSync(path.join(here, "executor.ts"), "utf8");

/**
 * O prompt do sistema é o que separa "não consigo capturar prints" de tirar o print.
 * Estas linhas prendem as garantias que o modelo precisa ouvir toda vez — não só quando
 * o bot está sem instruções, que era quando o texto de fallback do runtime aparecia.
 */
describe("agent system prompt", () => {
  it("teaches screenshot, record_screen and send_file to every bot", () => {
    expect(executor).toContain("`screenshot` puts a picture of your current screen");
    expect(executor).toContain("`record_screen`");
    expect(executor).toContain("`send_file`");
    // Um pedido de print termina em screenshot, não numa desculpa sobre "site externo".
    expect(executor).toContain("there is no such thing as an external site you cannot capture");
  });

  it("opens ordinary pages inside the bot browser without an approval card", () => {
    expect(executor).toContain("Use open_url to open HTTP or HTTPS pages inside that browser");
    expect(executor).toContain("open it with `open_url`");
    expect(executor).not.toContain("`xdg-open URL`");
  });

  it("puts a direct request ahead of getting-to-know-you questions", () => {
    expect(executor).toContain("A direct request always comes first");
    expect(executor).toContain("skip any getting-to-know-you questions");
  });

  it("makes leading the team a thing the person says, not a setting", () => {
    expect(executor).toContain(
      "Being in charge is something the person tells you in the conversation, not a setting",
    );
  });
});
