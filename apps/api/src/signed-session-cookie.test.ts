import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signedSessionCookie } from "./app.js";

describe("signedSessionCookie", () => {
  const cookie = {
    name: "better-auth.session_token",
    attributes: { path: "/", httpOnly: true, sameSite: "lax", secure: false },
  };

  it("assina como o better-auth lê: token.hmac-sha256 em base64, URL-encoded", () => {
    const header = signedSessionCookie(
      cookie,
      "segredo",
      "tok3n",
      new Date("2026-08-20T00:00:00Z"),
      new Date("2026-08-19T00:00:00Z"),
    );
    const signature = createHmac("sha256", "segredo").update("tok3n").digest("base64");
    expect(
      header.startsWith(`better-auth.session_token=${encodeURIComponent(`tok3n.${signature}`)};`),
    ).toBe(true);
    expect(header).toContain("Max-Age=86400");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Secure");
  });

  it("respeita o nome e as opções que o better-auth escolheu (https ganha __Secure- e Secure)", () => {
    const header = signedSessionCookie(
      { name: "__Secure-better-auth.session_token", attributes: { secure: true, sameSite: "lax" } },
      "s",
      "t",
      new Date(Date.now() + 10_000),
    );
    expect(header.startsWith("__Secure-better-auth.session_token=")).toBe(true);
    expect(header).toContain("Secure");
    expect(header).toContain("Max-Age=60");
  });
});
