import { describe, expect, it } from "vitest";
import {
  asConnectorTools,
  COMPOSIO_KEY_TTL_MS,
  ComposioConnector,
  ComposioKeyMissingError,
  collectLogIds,
  collectPages,
  executeSessionKey,
  filterCatalog,
  isComposioEnabled,
  isNoAuthToolkitError,
  sanitizeComposioError,
  setBounded,
} from "./composio-connector.js";

describe("composio session cache", () => {
  it("evicts the oldest entry when the map is full", () => {
    const map = new Map<string, string>();
    setBounded(map, "a", "1", 2);
    setBounded(map, "b", "2", 2);
    setBounded(map, "c", "3", 2);
    expect([...map.entries()]).toEqual([
      ["b", "2"],
      ["c", "3"],
    ]);
    setBounded(map, "b", "2b", 2);
    expect([...map.entries()]).toEqual([
      ["c", "3"],
      ["b", "2b"],
    ]);
  });
});

describe("composio tool mapping", () => {
  it("maps OpenAI-style session tools and raw slugs", () => {
    const tools = asConnectorTools([
      {
        type: "function",
        function: {
          name: "COMPOSIO_SEARCH_TOOLS",
          description: "Search tools",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
      {
        slug: "HACKERNEWS_GET_USER",
        description: "Look up a public HN profile",
        inputParameters: { type: "object", properties: { username: { type: "string" } } },
      },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "COMPOSIO_SEARCH_TOOLS",
      "HACKERNEWS_GET_USER",
    ]);
    expect(tools[1]?.inputSchema).toMatchObject({ properties: { username: { type: "string" } } });
  });

  it("redacts project keys from errors", () => {
    expect(sanitizeComposioError("denied ak_secretvaluehere")).toContain("[redacted]");
    expect(sanitizeComposioError("denied ak_secretvaluehere")).not.toContain("ak_secret");
    expect(sanitizeComposioError("COMPOSIO_API_KEY=ak_shouldnotleak")).not.toContain(
      "ak_shouldnotleak",
    );
  });

  it("paginates until the cursor ends", async () => {
    const pages = [
      { items: ["gmail", "github"], cursor: "page-2" },
      { items: ["slack"], cursor: undefined },
    ];
    const items = await collectPages(async (cursor) => {
      if (!cursor) return pages[0]!;
      return pages[1]!;
    });
    expect(items).toEqual(["gmail", "github", "slack"]);
  });

  it("treats Composio no-auth toolkit errors as in-app connect", () => {
    expect(
      isNoAuthToolkitError(
        new Error(
          '400 {"error":{"message":"Toolkit hackernews does not require authentication.","slug":"ToolRouterV2_ToolkitsIsNoAuth"}}',
        ),
      ),
    ).toBe(true);
    expect(isNoAuthToolkitError(new Error("redirect required"))).toBe(false);
  });

  it("collects nested Composio log ids", () => {
    expect(
      collectLogIds({
        logId: "",
        data: { results: [{ log_id: "log_abc123", slug: "HACKERNEWS_GET_USER" }] },
      }),
    ).toEqual(["log_abc123"]);
  });

  it("keys execute sessions by sorted unique toolkits", () => {
    expect(executeSessionKey(["hackernews", "gmail", "hackernews"])).toBe("gmail,hackernews");
    expect(executeSessionKey([])).toBe("");
  });

  it("filters the catalog by name or slug", () => {
    const items = [
      { slug: "github", name: "GitHub", logo: null, connected: false, noAuth: false },
      { slug: "hackernews", name: "Hacker News", logo: null, connected: false, noAuth: true },
    ];
    expect(filterCatalog(items, "hacker").map((item) => item.slug)).toEqual(["hackernews"]);
  });
});

describe("Composio during verify:fast", () => {
  it("does not construct a live Platform client under Vitest", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isComposioEnabled("ck_must_not_call_live")).toBe(false);
  });
});

describe("ComposioConnector.complete", () => {
  /** Minimal stand-in for the SDK surface `complete()` touches. No network. */
  function fakeSdk(behaviour: {
    onWait: (id: string, timeout?: number) => Promise<{ id: string }>;
  }) {
    const calls: Array<{ id: string; timeout?: number }> = [];
    const sdk = {
      connectedAccounts: {
        waitForConnection: async (id: string, timeout?: number) => {
          calls.push({ id, timeout });
          return behaviour.onWait(id, timeout);
        },
      },
    };
    return { sdk: sdk as unknown as ConstructorParameters<typeof ComposioConnector>[0], calls };
  }

  const context = {
    operationId: "op",
    traceId: "trace",
    workspaceId: "ws-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };

  it("waits on the stored connection request and returns the connected account id", async () => {
    const { sdk, calls } = fakeSdk({ onWait: async () => ({ id: "ca_live" }) });
    const connector = new ComposioConnector(sdk);
    await expect(
      connector.complete({ state: "ca_pending", code: "oauth-code" }, context),
    ).resolves.toEqual({ connectionRef: "ca_live" });
    // Short wait: the web and mobile callbacks poll instead of holding a request.
    expect(calls).toEqual([{ id: "ca_pending", timeout: 3_000 }]);
  });

  it("falls back to the request id when the SDK returns no id", async () => {
    const { sdk } = fakeSdk({ onWait: async () => ({ id: "" }) });
    await expect(
      new ComposioConnector(sdk).complete({ state: "ca_pending" }, context),
    ).resolves.toEqual({ connectionRef: "ca_pending" });
  });

  it("surfaces a still-pending connection as an error the caller can retry", async () => {
    const { sdk } = fakeSdk({
      onWait: async () => {
        throw new Error("Connection request timed out for ca_pending");
      },
    });
    await expect(
      new ComposioConnector(sdk).complete({ state: "ca_pending" }, context),
    ).rejects.toThrow(/timed out/);
  });

  it("refuses to call the SDK without a provider reference", async () => {
    const { sdk, calls } = fakeSdk({ onWait: async () => ({ id: "ca_live" }) });
    await expect(new ComposioConnector(sdk).complete({ state: "" }, context)).rejects.toThrow(
      /referência do provedor/,
    );
    expect(calls).toEqual([]);
  });
});

describe("composio key resolution (BYOK)", () => {
  it("prefers the env key and never asks the store", async () => {
    let asked = 0;
    const connector = new ComposioConnector({
      envApiKey: "env-key",
      loadStoredKey: async () => {
        asked += 1;
        return "stored-key";
      },
    });
    expect(await connector.resolveApiKey()).toBe("env-key");
    expect(asked).toBe(0);
  });

  it("reads the stored key, caches it briefly and forgets it on invalidate", async () => {
    let value: string | undefined = "first";
    let asked = 0;
    const connector = new ComposioConnector({
      loadStoredKey: async () => {
        asked += 1;
        return value;
      },
    });
    expect(await connector.resolveApiKey(1_000)).toBe("first");
    value = "second";
    expect(await connector.resolveApiKey(2_000)).toBe("first");
    expect(await connector.resolveApiKey(1_000 + COMPOSIO_KEY_TTL_MS)).toBe("second");
    connector.invalidateKey();
    value = undefined;
    expect(await connector.resolveApiKey(1_000 + COMPOSIO_KEY_TTL_MS)).toBeUndefined();
    expect(await connector.available()).toBe(false);
    expect(asked).toBe(4);
  });

  it("stays unavailable without any key and says what to do", async () => {
    const connector = new ComposioConnector({ loadStoredKey: async () => undefined });
    expect(await connector.available()).toBe(false);
    await expect(connector.catalog("u1")).rejects.toBeInstanceOf(ComposioKeyMissingError);
  });
});
