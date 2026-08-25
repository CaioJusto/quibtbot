import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deviceLabel } from "@quibt/core/device-code";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = readFileSync(path.join(here, "device-code-store.ts"), "utf8");
const app = readFileSync(path.join(here, "app.ts"), "utf8");

/**
 * A garantia que dá sentido ao desenho: acertar o código não entra. Se um dia alguém
 * devolver a sessão direto do claim, estes testes caem.
 */
describe("entering with a code needs two sides", () => {
  it("claiming a code creates a request, never a session", () => {
    const claim = store.slice(store.indexOf("export async function claimDeviceCode"));
    const body = claim.slice(0, claim.indexOf("function hashRequestSecret"));
    expect(body).toContain("claimedAt");
    expect(body).toContain("requestSecretHash");
    expect(body).not.toContain("createSession");
  });

  it("the session is minted only on an approved poll", () => {
    const poll = app.slice(app.indexOf('app.post("/api/pairing/poll"'));
    const body = poll.slice(0, 1400);
    expect(body).toContain('outcome.state !== "approved"');
    // A sessão nasce depois da checagem, nunca antes dela.
    expect(body.indexOf('outcome.state !== "approved"')).toBeLessThan(
      body.indexOf("createSession"),
    );
  });

  it("the claim route no longer answers with a token", () => {
    const claim = app.slice(app.indexOf('app.post("/api/pairing/claim"'));
    const body = claim.slice(0, claim.indexOf('app.post("/api/pairing/poll"'));
    expect(body).toContain("requestId");
    expect(body).not.toContain("token:");
  });

  it("polling demands the secret that came with the request", () => {
    const poll = store.slice(store.indexOf("export async function pollDeviceRequest"));
    expect(poll.slice(0, 900)).toContain("timingSafeEqual");
    expect(poll).toContain("requestSecretHash: row.requestSecretHash");
    expect(poll).toContain("consumed.count !== 1");
  });

  it("only the owner decides, and only what is still waiting", () => {
    const decide = store.slice(store.indexOf("export async function decideDeviceRequest"));
    const body = decide.slice(0, 600);
    expect(body).toContain("userId");
    expect(body).toContain("approvedAt: null");
    expect(body).toContain("deniedAt: null");
  });
});

describe("what the person approving reads", () => {
  it("shows a device name, never raw text from the phone", () => {
    expect(store).toContain("deviceLabel(");
    expect(deviceLabel("iPhone\nde   Caio")).toBe("iPhone de Caio");
  });
});
