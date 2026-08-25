import { describe, expect, it } from "vitest";
import {
  connectionCallbackUrl,
  isTrustedOrigin,
  type TrustedOriginEnv,
  withConnectionId,
  withPublicConnectOrigin,
} from "./origins.js";

function env(overrides: Partial<TrustedOriginEnv> = {}): TrustedOriginEnv {
  return {
    webOrigin: "https://app.quibt.test",
    apiUrl: "https://api.quibt.test",
    authUrl: "https://api.quibt.test",
    trustedWebOrigins: [],
    nodeEnv: "production",
    ...overrides,
  };
}

const fallback = "https://app.quibt.test/plugins/callback";

describe("connectionCallbackUrl", () => {
  it("keeps the server callback when nothing was requested", () => {
    expect(connectionCallbackUrl(undefined, fallback, env())).toBe(fallback);
  });

  it("allows the deploy's own web origin and the native app schemes", () => {
    expect(connectionCallbackUrl(`${fallback}?app=1`, fallback, env())).toBe(`${fallback}?app=1`);
    expect(connectionCallbackUrl("quibt://plugins/callback", fallback, env())).toBe(
      "quibt://plugins/callback",
    );
  });

  it("refuses an open redirect to somebody else's origin", () => {
    expect(connectionCallbackUrl("https://evil.test/steal", fallback, env())).toBe(fallback);
    expect(connectionCallbackUrl("https://app.quibt.test.evil.test/x", fallback, env())).toBe(
      fallback,
    );
    expect(connectionCallbackUrl("//evil.test/steal", fallback, env())).toBe(fallback);
    expect(connectionCallbackUrl("javascript:alert(1)", fallback, env())).toBe(fallback);
  });

  it("refuses embedded credentials and localhost in production", () => {
    expect(
      connectionCallbackUrl("https://user:pass@app.quibt.test/plugins/callback", fallback, env()),
    ).toBe(fallback);
    expect(connectionCallbackUrl("http://localhost:5173/plugins/callback", fallback, env())).toBe(
      fallback,
    );
    expect(
      connectionCallbackUrl(
        "http://localhost:5173/plugins/callback",
        fallback,
        env({ nodeEnv: "development" }),
      ),
    ).toBe("http://localhost:5173/plugins/callback");
  });

  it("honours extra trusted web origins", () => {
    expect(
      connectionCallbackUrl(
        "https://staging.quibt.test/plugins/callback",
        fallback,
        env({ trustedWebOrigins: ["https://staging.quibt.test"] }),
      ),
    ).toBe("https://staging.quibt.test/plugins/callback");
  });
});

describe("withPublicConnectOrigin", () => {
  it("trusts only a normalized HTTPS tunnel, never loopback or http", () => {
    const trusted = withPublicConnectOrigin(env(), "https://quibt.trycloudflare.com/");
    expect(trusted.trustedWebOrigins).toEqual(["https://quibt.trycloudflare.com"]);
    expect(isTrustedOrigin("https://quibt.trycloudflare.com", trusted)).toBe(true);
    expect(withPublicConnectOrigin(env(), "http://192.168.1.20:3100").trustedWebOrigins).toEqual(
      [],
    );
    expect(withPublicConnectOrigin(env(), "https://127.0.0.1").trustedWebOrigins).toEqual([]);
  });
});

describe("withConnectionId", () => {
  it("adds the row id the callback needs to finish the connection", () => {
    expect(withConnectionId(fallback, "conn_1")).toBe(`${fallback}?connectionId=conn_1`);
    expect(withConnectionId(`${fallback}?app=1`, "conn_1")).toBe(
      `${fallback}?app=1&connectionId=conn_1`,
    );
  });

  it("replaces a caller-supplied connection id instead of trusting it", () => {
    expect(withConnectionId(`${fallback}?connectionId=someone_else`, "conn_1")).toBe(
      `${fallback}?connectionId=conn_1`,
    );
  });

  it("works on native deep links too", () => {
    expect(withConnectionId("quibt://plugins/callback", "conn_1")).toContain("connectionId=conn_1");
  });
});
