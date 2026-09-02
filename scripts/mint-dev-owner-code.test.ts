import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveBootstrapSecret } from "../packages/core/src/secrets-guard.js";
import {
  formatMintResult,
  mintDevOwnerCode,
  resolveMintBootstrapSecret,
} from "./mint-dev-owner-code.mjs";

describe("pnpm owner:code — first-run source path", () => {
  it("derives the same secret the API uses when BOOTSTRAP_SECRET is empty", () => {
    const env = {
      NODE_ENV: "development",
      BETTER_AUTH_SECRET: "one-secret-for-this-machine",
      BOOTSTRAP_SECRET: "",
    };
    const minted = resolveMintBootstrapSecret(env);
    expect(minted).toBe(resolveBootstrapSecret(env));
    expect(minted).toBe(
      createHmac("sha256", "one-secret-for-this-machine")
        .update("quibt-bot/bootstrap-secret/v1")
        .digest("hex"),
    );
  });

  it("prefers an explicit BOOTSTRAP_SECRET", () => {
    const env = {
      NODE_ENV: "development",
      BETTER_AUTH_SECRET: "one-secret-for-this-machine",
      BOOTSTRAP_SECRET: "explicit-bootstrap-secret-32chars-min",
    };
    expect(resolveMintBootstrapSecret(env)).toBe("explicit-bootstrap-secret-32chars-min");
    expect(resolveMintBootstrapSecret(env)).toBe(resolveBootstrapSecret(env));
  });

  it("refuses to invent a secret outside development", () => {
    expect(
      resolveMintBootstrapSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-secret-with-enough-entropy-here",
        BOOTSTRAP_SECRET: "",
      }),
    ).toBeNull();
  });

  it("mints against the local API with the derived header", async () => {
    const env = {
      NODE_ENV: "development",
      BETTER_AUTH_SECRET: "one-secret-for-this-machine",
      BOOTSTRAP_SECRET: "",
      API_URL: "http://127.0.0.1:3100/",
    };
    const expected = resolveMintBootstrapSecret(env);
    const seen: Array<{ url: string; header: string | null }> = [];
    const result = await mintDevOwnerCode(env, async (url, init) => {
      seen.push({
        url: String(url),
        header: new Headers(init?.headers).get("x-quibt-bootstrap-secret"),
      });
      return new Response(JSON.stringify({ code: "ABCD2345", expiresAt: "2026-09-02T02:00:00Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect(result).toEqual({ ok: true, code: "ABCD2345", expiresAt: "2026-09-02T02:00:00Z" });
    expect(seen).toEqual([
      { url: "http://127.0.0.1:3100/api/bootstrap/invites", header: expected },
    ]);
    expect(formatMintResult(result)).toContain("Código do instalador: ABCD2345");
  });

  it("says when the API is down", async () => {
    const result = await mintDevOwnerCode(
      {
        NODE_ENV: "development",
        BETTER_AUTH_SECRET: "one-secret-for-this-machine",
        API_URL: "http://127.0.0.1:3100",
      },
      async () => {
        throw new Error("connect ECONNREFUSED");
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/API local está ligado/);
  });
});
