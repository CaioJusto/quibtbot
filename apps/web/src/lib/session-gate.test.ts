import { describe, expect, it } from "vitest";
import { MAX_SESSION_RETRIES, sessionGate } from "./session-gate";

describe("sessionGate", () => {
  it("keeps loading while the request is in flight", () => {
    expect(sessionGate({ isPending: true, hasUser: false, error: null }, 0)).toBe("loading");
  });

  it("only shows welcome on a clear empty answer from the API", () => {
    expect(sessionGate({ isPending: false, hasUser: false, error: null }, 0)).toBe("signed-out");
  });

  it("treats a network error as still loading, not as signed out", () => {
    // O caso do desktop: a UI sobe antes da API e o get-session falha por segundos.
    expect(sessionGate({ isPending: false, hasUser: false, error: new Error("fetch") }, 0)).toBe(
      "loading",
    );
    expect(sessionGate({ isPending: false, hasUser: false, error: new Error("fetch") }, 3)).toBe(
      "loading",
    );
  });

  it("gives up after enough retries so a dead API does not spin forever", () => {
    expect(
      sessionGate(
        { isPending: false, hasUser: false, error: new Error("fetch") },
        MAX_SESSION_RETRIES,
      ),
    ).toBe("unreachable");
  });

  it("a user wins over everything else", () => {
    expect(sessionGate({ isPending: false, hasUser: true, error: null }, 0)).toBe("signed-in");
  });
});
