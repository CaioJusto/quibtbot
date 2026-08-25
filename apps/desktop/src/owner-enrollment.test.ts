import { describe, expect, it, vi } from "vitest";
import {
  claimOwnerEnrollment,
  isFirstOwnerSignupRequest,
  isLocalFirstOwnerSignupRequest,
  shouldClearOwnerEnrollment,
  validOwnerEnrollmentToken,
} from "./owner-enrollment.js";

describe("desktop first-owner enrollment", () => {
  it("injects only into the exact local signup endpoint", () => {
    expect(
      isLocalFirstOwnerSignupRequest(
        "http://127.0.0.1:5173/api/auth/sign-up/email",
        "http://127.0.0.1:5173",
      ),
    ).toBe(true);
    expect(
      isLocalFirstOwnerSignupRequest(
        "http://127.0.0.1:5173/api/auth/sign-in/email",
        "http://127.0.0.1:5173",
      ),
    ).toBe(false);
    expect(
      isLocalFirstOwnerSignupRequest(
        "https://attacker.example/api/auth/sign-up/email",
        "http://127.0.0.1:5173",
      ),
    ).toBe(false);
    expect(
      isFirstOwnerSignupRequest(
        "https://quibt.example/api/auth/sign-up/email",
        "https://quibt.example",
      ),
    ).toBe(true);
    expect(
      isFirstOwnerSignupRequest(
        "https://attacker.example/api/auth/sign-up/email",
        "https://quibt.example",
      ),
    ).toBe(false);
  });

  it("never returns an expired or empty enrollment", () => {
    expect(validOwnerEnrollmentToken({ token: "enroll", expiresAt: 2_000 }, 1_999)).toBe("enroll");
    expect(validOwnerEnrollmentToken({ token: "enroll", expiresAt: 2_000 }, 2_000)).toBeNull();
    expect(validOwnerEnrollmentToken({ token: "", expiresAt: 3_000 }, 2_000)).toBeNull();
  });

  it("clears successful and terminal signup enrollments but preserves retryable failures", () => {
    expect(shouldClearOwnerEnrollment(200)).toBe(true);
    expect(shouldClearOwnerEnrollment(403)).toBe(true);
    expect(shouldClearOwnerEnrollment(409)).toBe(true);
    expect(shouldClearOwnerEnrollment(400)).toBe(false);
    expect(shouldClearOwnerEnrollment(500)).toBe(false);
  });

  it("claims the visible installer code and keeps the enrollment out of logs and URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          enrollmentToken: "enrollment-secret",
          expiresAt: "2026-08-17T22:10:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      claimOwnerEnrollment("http://127.0.0.1:3100/", "ABCD1234", fetchMock),
    ).resolves.toEqual({
      token: "enrollment-secret",
      expiresAt: Date.parse("2026-08-17T22:10:00.000Z"),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/bootstrap/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "ABCD1234" }),
      }),
    );
  });

  it("claims the QR token from a newly installed VPS without putting it in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          enrollmentToken: "remote-enrollment",
          expiresAt: "2026-08-17T22:10:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await claimOwnerEnrollment("https://quibt.example", { token: "installer-qr-token" }, fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://quibt.example/api/bootstrap/claim",
      expect.objectContaining({ body: JSON.stringify({ token: "installer-qr-token" }) }),
    );
  });
});
