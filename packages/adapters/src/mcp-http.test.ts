import { describe, expect, it } from "vitest";
import {
  callMcpTool,
  discoverMcpTools,
  isPrivateMcpAddress,
  mcpToolName,
  parseMcpToolName,
  validateMcpEndpoint,
} from "./mcp-http.js";

const publicResolver = async () => [{ address: "93.184.216.34" }];

describe("mcp http", () => {
  it("round-trips tool names", () => {
    const name = mcpToolName("http://127.0.0.1:8755/mcp", "notes.write");
    expect(parseMcpToolName(name)?.tool).toBe("notes.write");
  });

  it("lists tools from a source", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          tools: [
            {
              name: "notes.write",
              description: "Write a note",
              inputSchema: { type: "object" },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const tools = await discoverMcpTools(
      ["https://mcp.example.com/mcp"],
      fetchImpl,
      publicResolver,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toContain("notes.write");
  });

  it("deduplicates sources and caps aggregate discovered tools", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          tools: Array.from({ length: 200 }, (_, index) => ({
            name: `tool-${index}`,
          })),
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const source = "https://mcp.example.com/mcp";
    const tools = await discoverMcpTools([source, source, source], fetchImpl, publicResolver);
    expect(calls).toBe(1);
    expect(tools).toHaveLength(32);
  });

  it("rejects local, private and non-HTTPS endpoints", async () => {
    expect(isPrivateMcpAddress("127.0.0.1")).toBe(true);
    expect(isPrivateMcpAddress("169.254.169.254")).toBe(true);
    expect(isPrivateMcpAddress("10.0.0.8")).toBe(true);
    expect(isPrivateMcpAddress("::1")).toBe(true);
    expect(isPrivateMcpAddress("93.184.216.34")).toBe(false);
    await expect(validateMcpEndpoint("http://example.com/mcp", publicResolver)).rejects.toThrow(
      "HTTPS",
    );
    await expect(validateMcpEndpoint("https://127.0.0.1/mcp")).rejects.toThrow("private");
    await expect(
      validateMcpEndpoint("https://metadata.example/mcp", async () => [
        { address: "169.254.169.254" },
      ]),
    ).rejects.toThrow("private");
  });

  it("refuses redirects and oversized responses", async () => {
    const redirect = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1" },
      })) as typeof fetch;
    await expect(
      callMcpTool("https://mcp.example.com", "notes.read", {}, redirect, publicResolver),
    ).rejects.toThrow("redirects");

    const oversized = (async () =>
      new Response("x", {
        headers: { "content-length": String(1024 * 1024 + 1) },
      })) as typeof fetch;
    await expect(
      callMcpTool("https://mcp.example.com", "notes.read", {}, oversized, publicResolver),
    ).rejects.toThrow("too large");
  });
});
