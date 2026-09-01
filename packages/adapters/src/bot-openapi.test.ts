import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  isOpenApiReadMethod,
  loadBotOpenApiTools,
  openApiToolName,
  parseOpenApiToolName,
  type RuntimeBotOpenApiSource,
} from "./bot-openapi.js";

const fixture = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "bot-openapi-fixture.json"),
  "utf8",
);
const resolver = async () => [{ address: "93.184.216.34" }];
const source: RuntimeBotOpenApiSource = {
  id: "source",
  workspaceId: "workspace",
  botId: "bot",
  name: "Pets",
  url: "https://spec.example.test/openapi.json",
  enabled: true,
};

function response(body: string, init?: ResponseInit) {
  return new Response(body, {
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
}

describe("bot OpenAPI tools", () => {
  it("parses JSON, prefixes tool names, and classifies reads", async () => {
    const runtime = await loadBotOpenApiTools([source], {
      resolver,
      fetchImpl: vi.fn(async () => response(fixture)) as typeof fetch,
    });
    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "oa__pets__get__listPets",
      "oa__pets__post__createPet",
    ]);
    expect(runtime.tools[1]?.inputSchema).toMatchObject({
      properties: { body: { type: "object" } },
      required: ["body"],
    });
    expect(openApiToolName("Pet Store", "GET", "listPets")).toBe("oa__pet_store__get__listPets");
    expect(parseOpenApiToolName("oa__pet_store__post__createPet")).toEqual({
      sourceSlug: "pet_store",
      method: "post",
      operation: "createPet",
    });
    expect(isOpenApiReadMethod("oa__pets__get__listPets")).toBe(true);
    expect(isOpenApiReadMethod("HEAD")).toBe(true);
    expect(isOpenApiReadMethod("POST")).toBe(false);
  });

  it("parses YAML OpenAPI 3 documents", async () => {
    const yaml = `
openapi: 3.1.0
info: { title: Pets, version: 1.0.0 }
servers:
  - url: https://api.example.test
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200": { description: OK }
    post:
      operationId: createPet
      responses:
        "200": { description: OK }
`;
    const runtime = await loadBotOpenApiTools([source], {
      resolver,
      fetchImpl: vi.fn(async () =>
        response(yaml, { headers: { "content-type": "text/yaml" } }),
      ) as typeof fetch,
    });
    expect(runtime.tools).toHaveLength(2);
    expect(runtime.tools[0]?.name).toBe("oa__pets__get__listPets");
  });

  it.each(["http://example.com/openapi.json", "http://127.0.0.1/openapi.json"])(
    "refuses a cleartext spec URL: %s",
    async (url) => {
      const disable = vi.fn(async (_source: RuntimeBotOpenApiSource, _reason: string) => undefined);
      const runtime = await loadBotOpenApiTools([{ ...source, url }], {
        resolver,
        fetchImpl: vi.fn() as typeof fetch,
        disable,
      });
      expect(runtime.tools).toEqual([]);
      expect(disable).toHaveBeenCalledOnce();
      expect(disable.mock.calls[0]?.[1]).toMatch(/HTTPS/);
    },
  );

  it.each([
    [
      "network failure",
      vi.fn(async () => {
        throw new Error("network token=hidden-value");
      }),
    ],
    ["HTTP failure", vi.fn(async () => response("no", { status: 500 }))],
  ])("disables a source after %s without taking the run down", async (_label, fetchImpl) => {
    const disable = vi.fn(async () => undefined);
    const runtime = await loadBotOpenApiTools([source], {
      resolver,
      fetchImpl: fetchImpl as typeof fetch,
      disable,
    });
    expect(runtime.tools).toEqual([]);
    expect(disable).toHaveBeenCalledOnce();
    expect(JSON.stringify(disable.mock.calls)).not.toContain("hidden-value");
  });

  it.each([
    ["too large", response("{}", { headers: { "content-length": String(512 * 1024 + 1) } })],
    ["Swagger 2", response(JSON.stringify({ swagger: "2.0", paths: {} }))],
    [
      "remote reference",
      response(
        JSON.stringify({
          openapi: "3.0.0",
          info: { title: "x", version: "1" },
          paths: { "/x": { get: { responses: { 200: { $ref: "https://evil.test/r.json" } } } } },
        }),
      ),
    ],
  ])("refuses a %s document", async (_label, specResponse) => {
    const disable = vi.fn(async () => undefined);
    const runtime = await loadBotOpenApiTools([source], {
      resolver,
      fetchImpl: vi.fn(async () => specResponse) as typeof fetch,
      disable,
    });
    expect(runtime.tools).toEqual([]);
    expect(disable).toHaveBeenCalledOnce();
  });

  it("skips operations whose server URL is cleartext", async () => {
    const document = JSON.parse(fixture) as Record<string, unknown>;
    document.servers = [{ url: "http://api.example.test" }];
    const runtime = await loadBotOpenApiTools([source], {
      resolver,
      fetchImpl: vi.fn(async () => response(JSON.stringify(document))) as typeof fetch,
    });
    expect(runtime.tools).toEqual([]);
  });

  it("caps operations per source and across all sources", async () => {
    const document = {
      openapi: "3.0.3",
      info: { title: "Many", version: "1" },
      servers: [{ url: "https://api.example.test" }],
      paths: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `/item-${index}`,
          { get: { responses: { 200: { description: "OK" } } } },
        ]),
      ),
    };
    const sources = Array.from({ length: 5 }, (_, index) => ({
      ...source,
      id: `source-${index}`,
      name: `Source ${index}`,
      url: `https://spec-${index}.example.test/openapi.json`,
    }));
    const runtime = await loadBotOpenApiTools(sources, {
      resolver,
      fetchImpl: vi.fn(async () => response(JSON.stringify(document))) as typeof fetch,
    });
    expect(runtime.tools).toHaveLength(128);
    expect(runtime.tools.filter((tool) => tool.name.startsWith("oa__source_0__"))).toHaveLength(32);
    expect(runtime.tools[0]?.name).toBe("oa__source_0__get__get_item_0");
  });

  it("executes GET without a body and POST with JSON through the injected fetch", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("openapi.json")) return response(fixture);
      return response(JSON.stringify({ token: "do-not-persist", value: "ok" }));
    }) as typeof fetch;
    const runtime = await loadBotOpenApiTools([source], { resolver, fetchImpl });
    const getResult = await runtime.call("oa__pets__get__listPets", { limit: 2 });
    const postResult = await runtime.call("oa__pets__post__createPet", {
      body: { name: "Milo" },
    });
    expect(calls[1]).toMatchObject({
      url: "https://api.example.test/v1/pets?limit=2",
      init: { method: "GET" },
    });
    expect(calls[1]?.init).not.toHaveProperty("body");
    expect(calls[2]).toMatchObject({
      url: "https://api.example.test/v1/pets",
      init: { method: "POST", body: JSON.stringify({ name: "Milo" }) },
    });
    expect(JSON.stringify(getResult)).not.toContain("do-not-persist");
    expect(JSON.stringify(postResult)).not.toContain("do-not-persist");
  });
});
