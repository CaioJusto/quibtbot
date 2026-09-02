import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  allowedBotBrowserUrl,
  botBrowserPartition,
  normalizeBotBrowserBounds,
  parseBotBrowserAttach,
  takeoverOsNotification,
} from "./bot-browser.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("embedded per-bot browser partition", () => {
  it("uses persist:bot-<id> and keeps two bots apart", () => {
    expect(botBrowserPartition("bot_ada")).toBe("persist:bot-bot_ada");
    expect(botBrowserPartition("bot_finn")).toBe("persist:bot-bot_finn");
    expect(botBrowserPartition("bot_ada")).not.toBe(botBrowserPartition("bot_finn"));
  });

  it("rejects a host profile, Kernel.sh, or an unsafe bot id", () => {
    expect(botBrowserPartition("bot_ada")).not.toContain("persist:main");
    expect(() => botBrowserPartition("../chrome")).toThrow(/botId/i);
    expect(() => botBrowserPartition("bot/ada")).toThrow(/botId/i);
    expect(() => botBrowserPartition("")).toThrow(/botId/i);
  });

  it("wires the partition helper through the desktop preload", () => {
    const preload = readFileSync(path.join(here, "preload.cjs"), "utf8");
    expect(preload).toContain("desktop.botBrowser.attach");
    expect(preload).toContain("notifyTakeover");
  });
});

describe("embedded browser navigation", () => {
  it("allows only http(s) pages and a blank start", () => {
    expect(allowedBotBrowserUrl("https://banco.example/login")).toBe(true);
    expect(allowedBotBrowserUrl("http://127.0.0.1:4173")).toBe(true);
    expect(allowedBotBrowserUrl("about:blank")).toBe(true);
    expect(allowedBotBrowserUrl("file:///etc/passwd")).toBe(false);
    expect(allowedBotBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(allowedBotBrowserUrl("chrome://gpu")).toBe(false);
  });
});

describe("embedded browser attach payload", () => {
  it("keeps the partition id beside integer bounds", () => {
    expect(
      parseBotBrowserAttach({
        botId: "bot_1",
        bounds: { x: 12.4, y: 40, width: 800, height: 600 },
      }),
    ).toEqual({
      botId: "bot_1",
      partition: "persist:bot-bot_1",
      bounds: { x: 12, y: 40, width: 800, height: 600 },
    });
    expect(
      parseBotBrowserAttach({ botId: "nope!", bounds: { x: 0, y: 0, width: 1, height: 1 } }),
    ).toBe(null);
    expect(normalizeBotBrowserBounds({ x: -4, y: 2, width: 0, height: 10 })).toBe(null);
  });
});

describe("desktop takeover notification", () => {
  it("builds a Portuguese OS notification the tray hook can show", () => {
    const notify = vi.fn();
    const payload = takeoverOsNotification({
      botName: "Finn",
      reason: "preciso que você faça o login",
    });
    expect(payload.title).toBe("Finn precisa de você");
    expect(payload.body).toBe("preciso que você faça o login");
    notify(payload);
    expect(notify).toHaveBeenCalledWith(payload);
  });
});
