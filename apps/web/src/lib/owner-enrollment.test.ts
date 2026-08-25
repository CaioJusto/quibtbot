import { describe, expect, it, vi } from "vitest";
import { claimOwnerEnrollmentCode, validWebOwnerEnrollment } from "./owner-enrollment.js";

describe("web first-owner enrollment", () => {
  it("normalizes and exchanges only an eight-character installer code", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ enrollmentToken: "one-use-token", expiresAt }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await claimOwnerEnrollmentCode(" abcd1234 ", fetchMock as typeof fetch);

    expect(result).toEqual({
      ok: true,
      enrollment: { token: "one-use-token", expiresAt: Date.parse(expiresAt) },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bootstrap/claim",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ code: "ABCD1234" }),
      }),
    );
  });

  it("rejects malformed codes without touching the server", async () => {
    const fetchMock = vi.fn();
    await expect(claimOwnerEnrollmentCode("short", fetchMock as typeof fetch)).resolves.toEqual({
      ok: false,
      message: "Digite o código de oito caracteres do instalador.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a claimed token only until its expiry", () => {
    expect(validWebOwnerEnrollment({ token: "token", expiresAt: 2_000 }, 1_999)).toBe("token");
    expect(validWebOwnerEnrollment({ token: "token", expiresAt: 2_000 }, 2_000)).toBeNull();
  });
});
