import { describe, expect, it } from "vitest";
import {
  allowRequest,
  allowWebhookRequest,
  authRateLimit,
  clientIp,
  clientKey,
  resetRateLimits,
  rpcMutationRateLimit,
  webhookEndpointBucket,
} from "./rate-limit.js";

describe("allowRequest", () => {
  it("allows up to the limit inside the window, then blocks", () => {
    resetRateLimits();
    const now = 1_000;
    expect(allowRequest("a", 2, 60_000, now)).toBe(true);
    expect(allowRequest("a", 2, 60_000, now + 10)).toBe(true);
    expect(allowRequest("a", 2, 60_000, now + 20)).toBe(false);
  });

  it("resets after the window", () => {
    resetRateLimits();
    const now = 1_000;
    expect(allowRequest("b", 1, 60_000, now)).toBe(true);
    expect(allowRequest("b", 1, 60_000, now + 60_000)).toBe(true);
  });

  it("evicts the oldest identity when the live cap is full, instead of locking out newcomers", () => {
    resetRateLimits();
    for (let i = 0; i < 2_000; i += 1) {
      expect(allowRequest(`identity-${i}`, 1, 60_000, 1_000)).toBe(true);
    }
    expect(allowRequest("identity-over-cap", 1, 60_000, 1_000)).toBe(true);
    expect(allowRequest("identity-0", 1, 60_000, 1_000)).toBe(true);
  });
});

describe("clientIp", () => {
  it("uses forwarding headers only for an explicitly trusted peer", () => {
    expect(
      clientIp(
        {
          get: (name) => (name === "x-real-ip" ? "10.0.0.8" : "1.2.3.4, 10.0.0.8"),
        },
        "127.0.0.1",
        ["127.0.0.1"],
      ),
    ).toBe("10.0.0.8");
    expect(
      clientIp(
        {
          get: (name) => (name === "x-forwarded-for" ? "1.2.3.4, 10.0.0.8" : undefined),
        },
        "127.0.0.1",
        ["127.0.0.1"],
      ),
    ).toBe("10.0.0.8");
    expect(clientIp({ get: () => "spoofed" }, "203.0.113.4", [])).toBe("203.0.113.4");
  });
});

describe("rpcMutationRateLimit", () => {
  it("limits bot creation and checkout without throttling reads", () => {
    expect(rpcMutationRateLimit("/rpc/bots/create")).toBe(20);
    expect(rpcMutationRateLimit("/rpc/billing/checkout")).toBe(20);
    expect(rpcMutationRateLimit("/rpc/capabilities/install")).toBe(20);
    expect(rpcMutationRateLimit("/rpc/billing/get")).toBeNull();
  });

  it("limits the send paths that wake bots", () => {
    expect(rpcMutationRateLimit("/rpc/threads/send")).toBe(60);
    expect(rpcMutationRateLimit("/rpc/peers/send")).toBe(60);
    expect(rpcMutationRateLimit("/rpc/botGroups/send")).toBe(60);
    expect(rpcMutationRateLimit("/rpc/threads/subscribe")).toBeNull();
    expect(rpcMutationRateLimit("/rpc/botGroups/thread")).toBeNull();
  });
});

describe("auth rate limit buckets", () => {
  it("puts the QR pairing exchange in its own tight bucket", () => {
    // Trocar o código do QR por uma sessão é o único caminho que vira login sem senha.
    expect(authRateLimit("/one-time-token/verify")).toEqual({
      key: "auth-pair",
      limit: 10,
    });
    expect(authRateLimit("/sign-in/email").key).toBe("auth-sign");
    expect(authRateLimit("/get-session").key).toBe("auth");
  });
});

describe("allowWebhookRequest", () => {
  it("lives in a store separate from allowRequest: flooding it with thousands of invented endpoint ids never evicts — and thereby never silently resets — an auth/rpc bucket", () => {
    resetRateLimits();
    const now = 1_000;
    const authKey = clientKey("203.0.113.99", "auth");
    // Exhaust a real auth bucket for this IP.
    for (let i = 0; i < 40; i += 1) {
      expect(allowRequest(authKey, 40, 60_000, now)).toBe(true);
    }
    expect(allowRequest(authKey, 40, 60_000, now)).toBe(false);

    // Flood the webhook store with more distinct (ip, endpoint) pairs than the general
    // store's own MAX_BUCKETS (2_000): if webhook keys ever shared that Map, this alone
    // would have been enough to evict the auth bucket above and silently restore it.
    for (let i = 0; i < 2_100; i += 1) {
      allowWebhookRequest(`198.51.100.${i % 200}`, `invented-endpoint-${i}`, now);
    }

    // The auth bucket must still be exhausted: none of that webhook flood touched it.
    expect(allowRequest(authKey, 40, 60_000, now)).toBe(false);
  });

  it("closes distributed enumeration across many different endpoint ids with a per-IP global ceiling (60/min)", () => {
    resetRateLimits();
    const now = 2_000;
    const ip = "203.0.113.50";
    for (let i = 0; i < 60; i += 1) {
      expect(allowWebhookRequest(ip, `enum-endpoint-${i}`, now)).toBe(true);
    }
    // The 61st attempt, against yet another never-seen endpoint id, still hits the
    // per-IP global ceiling — no single endpoint bucket got anywhere near its own
    // 30-attempt limit, so only the global window explains this.
    expect(allowWebhookRequest(ip, "enum-endpoint-60", now)).toBe(false);
  });

  it("still enforces a focused per-(IP, endpoint-bucket) ceiling (30/min) below the global one", () => {
    resetRateLimits();
    const now = 3_000;
    const ip = "203.0.113.60";
    const endpointId = "wh_focused_target";
    for (let i = 0; i < 30; i += 1) {
      expect(allowWebhookRequest(ip, endpointId, now)).toBe(true);
    }
    expect(allowWebhookRequest(ip, endpointId, now)).toBe(false);
  });

  it("does not share state across a different endpoint bucket or a different IP", () => {
    resetRateLimits();
    const now = 4_000;
    const ip = "203.0.113.70";
    const bucketA = webhookEndpointBucket("wh_endpoint_a");
    let endpointB = "wh_endpoint_b";
    for (let i = 0; i < 50 && webhookEndpointBucket(endpointB) === bucketA; i += 1) {
      endpointB = `wh_endpoint_b_${i}`;
    }
    expect(webhookEndpointBucket(endpointB)).not.toBe(bucketA);

    for (let i = 0; i < 30; i += 1) {
      expect(allowWebhookRequest(ip, "wh_endpoint_a", now)).toBe(true);
    }
    expect(allowWebhookRequest(ip, "wh_endpoint_a", now)).toBe(false);

    // Same IP, a different endpoint bucket: well under the global ceiling (31 so far),
    // and this bucket has never been touched.
    expect(allowWebhookRequest(ip, endpointB, now)).toBe(true);

    // Same endpoint, a different IP: an entirely fresh global + bucket state.
    expect(allowWebhookRequest("203.0.113.71", "wh_endpoint_a", now)).toBe(true);
  });

  it("maps an endpoint id deterministically into at most 64 buckets", () => {
    for (const id of ["a", "wh_abc123", "invented-endpoint-999", ""]) {
      const bucket = webhookEndpointBucket(id);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(64);
      expect(webhookEndpointBucket(id)).toBe(bucket);
    }
  });

  it("resetRateLimits() clears both the general and the webhook-only store", () => {
    resetRateLimits();
    const now = 5_000;
    const authKey = clientKey("203.0.113.80", "auth");
    expect(allowRequest(authKey, 1, 60_000, now)).toBe(true);
    expect(allowRequest(authKey, 1, 60_000, now)).toBe(false);
    for (let i = 0; i < 30; i += 1) {
      allowWebhookRequest("203.0.113.81", "wh_reset_target", now);
    }
    expect(allowWebhookRequest("203.0.113.81", "wh_reset_target", now)).toBe(false);

    resetRateLimits();

    expect(allowRequest(authKey, 1, 60_000, now)).toBe(true);
    expect(allowWebhookRequest("203.0.113.81", "wh_reset_target", now)).toBe(true);
  });
});
