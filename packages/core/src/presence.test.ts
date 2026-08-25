import { describe, expect, it } from "vitest";
import { botIsOnline, inboxBotStatus } from "./presence.js";

describe("botIsOnline", () => {
  it("is on while the bot is working", () => {
    expect(botIsOnline("running")).toBe(true);
    expect(botIsOnline("booting")).toBe(true);
    expect(botIsOnline("queued")).toBe(true);
    expect(botIsOnline("leased")).toBe(true);
    expect(botIsOnline("waiting_input")).toBe(true);
    expect(botIsOnline("waiting_takeover")).toBe(true);
  });

  it("is off when the computer is asleep or idle", () => {
    expect(botIsOnline("idle")).toBe(false);
    expect(botIsOnline("suspended")).toBe(false);
    expect(botIsOnline("stopped")).toBe(false);
    expect(botIsOnline("completed")).toBe(false);
    expect(botIsOnline(undefined)).toBe(false);
  });
});

describe("inboxBotStatus", () => {
  it("prefers an active turn over a quiet computer", () => {
    expect(inboxBotStatus({ runStatus: "waiting_takeover", computerState: "running" })).toBe(
      "waiting_takeover",
    );
    expect(inboxBotStatus({ runStatus: "queued", computerState: "stopped" })).toBe("queued");
  });

  it("a quiet bot is idle even while its computer is still up between turns", () => {
    // Verde é "trabalhando"; o Xvfb de pé não é trabalho nenhum.
    expect(inboxBotStatus({ runStatus: null, computerState: "running" })).toBe("idle");
    expect(inboxBotStatus({ runStatus: "idle", computerState: "booting" })).toBe("idle");
  });

  it("goes idle when the computer sleeps", () => {
    expect(inboxBotStatus({ runStatus: null, computerState: "suspended" })).toBe("idle");
    expect(inboxBotStatus({ runStatus: "completed", computerState: "stopped" })).toBe("idle");
    expect(inboxBotStatus({})).toBe("idle");
  });
});

describe("inboxPresence", () => {
  it("verde trabalhando, azul quando é a pessoa quem falta, nada quando quieto", async () => {
    const { inboxPresence } = await import("./presence.js");
    expect(inboxPresence({ status: "running" })).toBe("working");
    expect(inboxPresence({ status: "queued", unread: true })).toBe("working");
    expect(inboxPresence({ status: "waiting_input" })).toBe("attention");
    expect(inboxPresence({ status: "waiting_takeover", unread: false })).toBe("attention");
    expect(inboxPresence({ status: "idle", unread: true })).toBe("attention");
    expect(inboxPresence({ status: "idle" })).toBeNull();
    expect(inboxPresence({})).toBeNull();
  });

  it("um run que a API reprovou por falta de worker apaga o verde", async () => {
    // O reconciliador marca o run `failed` quando ficou na fila sem worker; a partir daí a
    // lista não pode continuar dizendo "trabalhando".
    const { inboxPresence } = await import("./presence.js");
    expect(inboxPresence({ status: "queued" })).toBe("working");
    expect(inboxPresence({ status: "failed" })).toBeNull();
    expect(inboxPresence({ status: "failed", unread: true })).toBe("attention");
    expect(inboxBotStatus({ runStatus: "failed", computerState: "running" })).toBe("idle");
    expect(botIsOnline("failed")).toBe(false);
  });
});
