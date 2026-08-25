import { describe, expect, it } from "vitest";
import { shouldKeepWaitingForSubscription } from "./subscription-sign-in.js";

describe("shouldKeepWaitingForSubscription", () => {
  it("keeps waiting when the phone lost the request while the app was in the background", () => {
    expect(shouldKeepWaitingForSubscription(new Error("Network request failed"))).toBe(true);
    expect(shouldKeepWaitingForSubscription(new Error("Failed to fetch"))).toBe(true);
    expect(shouldKeepWaitingForSubscription(new Error("Load failed"))).toBe(true);
    expect(
      shouldKeepWaitingForSubscription(
        new Error("A conexão demorou demais. Verifique sua internet e tente novamente."),
      ),
    ).toBe(true);
    expect(shouldKeepWaitingForSubscription(new Error("The operation was aborted"))).toBe(true);
    expect(shouldKeepWaitingForSubscription(new Error("A conexão falhou"))).toBe(true);
  });

  it("stops on what the server actually said", () => {
    expect(shouldKeepWaitingForSubscription(new Error("Sign-in session not found."))).toBe(false);
    const expired = new Error("Sessão expirada. Entre de novo.") as Error & { code?: string };
    expired.code = "session_expired";
    expect(shouldKeepWaitingForSubscription(expired)).toBe(false);
    const unauthorized = new Error("Failed to fetch") as Error & { code?: string };
    unauthorized.code = "UNAUTHORIZED";
    expect(shouldKeepWaitingForSubscription(unauthorized)).toBe(false);
  });

  it("does not swallow things that are not errors", () => {
    expect(shouldKeepWaitingForSubscription("Network request failed")).toBe(false);
    expect(shouldKeepWaitingForSubscription(undefined)).toBe(false);
  });
});
