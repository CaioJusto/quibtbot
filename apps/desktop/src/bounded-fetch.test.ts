import { describe, expect, it, vi } from "vitest";
import { boundedFetchText } from "./bounded-fetch.js";

describe("boundedFetchText", () => {
  it("aborts when the response exceeds the byte limit", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("0123456789", {
          status: 200,
          headers: { "content-length": "10" },
        }),
    );
    await expect(
      boundedFetchText("https://example.test/manifest", fetchImpl, { maxBytes: 4 }),
    ).rejects.toThrow(/size limit/i);
  });

  it("returns text for small responses", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    await expect(boundedFetchText("https://example.test/manifest", fetchImpl)).resolves.toBe("ok");
  });
});
