import { describe, expect, it } from "vitest";
import { withStreamingHeaders } from "./streaming-response.js";

describe("withStreamingHeaders", () => {
  it("disables cache and nginx buffering for event streams", () => {
    const source = new Response("data: {}\n\n", {
      headers: { "content-type": "text/event-stream; charset=utf-8", vary: "origin" },
    });
    const response = withStreamingHeaders(source);
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("vary")).toBe("origin");
  });

  it("leaves ordinary RPC responses untouched", () => {
    const source = Response.json({ ok: true });
    expect(withStreamingHeaders(source)).toBe(source);
  });
});
