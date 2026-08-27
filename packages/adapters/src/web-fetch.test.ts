import { describe, expect, it } from "vitest";
import { MAX_WEB_FETCH_BYTES, webFetch, webFetchRequestForTranscript } from "./web-fetch.js";

const publicResolver = async () => [{ address: "93.184.216.34" }];

describe("web_fetch", () => {
  it("returns the final URL, title and readable HTML text", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/start")) {
        return new Response(null, { status: 302, headers: { location: "/article" } });
      }
      return new Response(
        "<html><head><title>Quibt &amp; Web</title><style>secret css</style></head>" +
          "<body><h1>Hello</h1><script>secret js</script><p>Readable text.</p></body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }) as typeof fetch;

    await expect(
      webFetch("https://example.com/start", { fetchImpl, resolver: publicResolver }),
    ).resolves.toEqual({
      finalUrl: "https://example.com/article",
      title: "Quibt & Web",
      text: "Hello\nReadable text.",
    });
    expect(seen).toEqual(["https://example.com/start", "https://example.com/article"]);
  });

  it("revalidates redirects and blocks private or downgraded destinations", async () => {
    const privateRedirect = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/admin" },
      })) as typeof fetch;
    await expect(
      webFetch("https://example.com", { fetchImpl: privateRedirect, resolver: publicResolver }),
    ).rejects.toThrow("private");

    const downgrade = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://example.com/plain" },
      })) as typeof fetch;
    await expect(
      webFetch("https://example.com", { fetchImpl: downgrade, resolver: publicResolver }),
    ).rejects.toThrow("HTTPS");

    let redirects = 0;
    const loop = (async () => {
      redirects += 1;
      return new Response(null, { status: 302, headers: { location: "/again" } });
    }) as typeof fetch;
    await expect(
      webFetch("https://example.com", { fetchImpl: loop, resolver: publicResolver }),
    ).rejects.toThrow("exceeded 3 redirects");
    expect(redirects).toBe(4);
  });

  it("allows only bounded text responses", async () => {
    const binary = (async () =>
      new Response("png", { headers: { "content-type": "image/png" } })) as typeof fetch;
    await expect(
      webFetch("https://example.com/image", { fetchImpl: binary, resolver: publicResolver }),
    ).rejects.toThrow("content type");

    const oversized = (async () =>
      new Response("x", {
        headers: {
          "content-type": "text/plain",
          "content-length": String(MAX_WEB_FETCH_BYTES + 1),
        },
      })) as typeof fetch;
    await expect(
      webFetch("https://example.com/large", { fetchImpl: oversized, resolver: publicResolver }),
    ).rejects.toThrow("too large");
  });

  it("refuses credentials before they can be persisted in an effect", () => {
    expect(() => webFetchRequestForTranscript({ url: "https://user:pass@example.com" })).toThrow(
      "credentials",
    );
    expect(() =>
      webFetchRequestForTranscript({ url: "https://example.com/?access_token=top-secret" }),
    ).toThrow("credential query");
    expect(webFetchRequestForTranscript({ url: "https://example.com/?q=quibt" })).toEqual({
      url: "https://example.com/?q=quibt",
    });
  });
});
