import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ConnectorTool } from "@quibt/adapter-kit";
import { CAPABILITY_LIMITS } from "@quibt/contracts";

const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
export type ResolveHost = (hostname: string) => Promise<Array<{ address: string }>>;

const resolveHost: ResolveHost = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export function isPrivateMcpAddress(address: string): boolean {
  const value = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/, "");
  if (isIP(value) === 4) {
    const octets = value.split(".").map(Number);
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a! >= 224
    );
  }
  if (isIP(value) === 6) {
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      /^fe[89ab]/.test(value)
    );
  }
  return true;
}

export async function validateMcpEndpoint(
  source: string,
  resolver: ResolveHost = resolveHost,
): Promise<URL> {
  return validatePublicHttpsEndpoint(source, "MCP endpoint", resolver);
}

/** Shared outbound-network boundary for MCP and first-party HTTP adapters. */
export async function validatePublicHttpsEndpoint(
  source: string,
  label: string,
  resolver: ResolveHost = resolveHost,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} must use HTTPS without embedded credentials`);
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`${label} cannot target a local network address`);
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolver(hostname);
  if (!addresses.length || addresses.some(({ address }) => isPrivateMcpAddress(address))) {
    throw new Error(`${label} cannot target a private or reserved network address`);
  }
  return url;
}

async function mcpJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP response is too large");
  if (!response.body) return JSON.parse(await response.text());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MCP_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("MCP response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function mcpToolName(source: string, tool: string) {
  const slug = source
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32);
  return `mcp__${slug}__${tool}`;
}

export function parseMcpToolName(name: string): { sourceSlug: string; tool: string } | null {
  const match = /^mcp__([^_].+?)__(.+)$/.exec(name);
  const sourceSlug = match?.[1];
  const tool = match?.[2];
  if (!sourceSlug || !tool) return null;
  return { sourceSlug, tool };
}

export async function discoverMcpTools(
  sources: string[],
  fetchImpl: typeof fetch = fetch,
  resolver: ResolveHost = resolveHost,
): Promise<ConnectorTool[]> {
  const uniqueSources = [...new Set(sources)].slice(0, CAPABILITY_LIMITS.mcpPerUser);
  const discoverSource = async (source: string): Promise<ConnectorTool[]> => {
    try {
      const endpoint = await validateMcpEndpoint(source, resolver);
      const res = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return [];
      if (res.status >= 300 && res.status < 400) return [];
      const body = (await mcpJson(res)) as {
        tools?: Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;
      };
      return (body.tools ?? []).slice(0, CAPABILITY_LIMITS.mcpToolsPerSource).map((tool) => ({
        name: mcpToolName(source, tool.name),
        description: `${tool.description ?? tool.name} (MCP ${source})`,
        inputSchema: tool.inputSchema ?? { type: "object" },
      }));
    } catch {
      // A dead MCP server must not take the run down.
      return [];
    }
  };
  // Sources share one wall-clock window instead of multiplying four seconds by every row.
  const discovered = await Promise.race([
    Promise.all(uniqueSources.map(discoverSource)),
    new Promise<ConnectorTool[][]>((resolve) => {
      setTimeout(() => resolve([]), 4_100).unref?.();
    }),
  ]);
  return discovered.flat().slice(0, CAPABILITY_LIMITS.mcpToolsTotal);
}

export async function callMcpTool(
  source: string,
  tool: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  resolver: ResolveHost = resolveHost,
): Promise<unknown> {
  const endpoint = await validateMcpEndpoint(source, resolver);
  const res = await fetchImpl(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status >= 300 && res.status < 400) throw new Error("MCP redirects are not allowed");
  if (!res.ok) throw new Error(`MCP ${source} respondeu ${res.status}`);
  return mcpJson(res);
}

export function matchMcpSource(sources: string[], slug: string): string | undefined {
  return sources.find((source) => mcpToolName(source, "x").startsWith(`mcp__${slug}__`));
}
