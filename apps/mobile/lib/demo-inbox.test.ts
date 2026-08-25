import { describe, expect, it } from "vitest";
import {
  DEMO_BOTS,
  defaultDemoInstructions,
  demoBotForId,
  demoMessagesForBot,
  isDemoBotId,
  withInboxPlaceholders,
} from "./demo-inbox";

describe("development inbox placeholders", () => {
  it("fills a sparse inbox to five bots without replacing real bots", () => {
    const real = { id: "real", name: "Real", title: "", preview: "" };
    const result = withInboxPlaceholders([real], true);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(real);
    expect(result.slice(1).every((bot) => isDemoBotId(bot.id))).toBe(true);
  });

  it("does not inject screenshot data when disabled", () => {
    expect(withInboxPlaceholders([], false)).toEqual([]);
  });

  it("gives every demo bot a readable conversation", () => {
    for (const bot of DEMO_BOTS) {
      const messages = demoMessagesForBot(bot.id);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe("user");
      expect(messages[1]?.role).toBe("bot");
      expect(messages[1]?.blocks[0]?.text?.length).toBeGreaterThan(30);
    }
  });

  it("hydrates the edit-agent page with local overrides", () => {
    const bot = demoBotForId(DEMO_BOTS[0]?.id, {
      [DEMO_BOTS[0]!.id]: { name: "Maia Azul", color: "#006BFF", shape: "nova" },
    });
    expect(bot).toMatchObject({ name: "Maia Azul", color: "#006BFF", shape: "nova" });
    expect(defaultDemoInstructions(bot.id).length).toBeGreaterThan(40);
  });
});
