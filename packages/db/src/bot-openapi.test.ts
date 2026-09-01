import { describe, expect, it } from "vitest";
import {
  addBotOpenApiSource,
  listBotOpenApiSources,
  mapBotOpenApiSource,
  removeBotOpenApiSource,
  validateBotOpenApiInput,
} from "./bot-openapi.js";
import type { PrismaClient } from "./client.js";

const base = { workspaceId: "workspace", botId: "bot", name: "Pets" };

describe("bot OpenAPI validation and DTO", () => {
  it.each([
    "http://example.com/openapi.json",
    "http://127.0.0.1/openapi.json",
    "https://user:secret@example.com/openapi.json",
    "https://example.com/openapi.json?api_key=secret",
  ])("rejects an unsafe URL: %s", (url) => {
    expect(() => validateBotOpenApiInput({ ...base, url })).toThrow(/HTTPS|credential/);
  });

  it("trims the name and accepts HTTPS", () => {
    expect(
      validateBotOpenApiInput({
        ...base,
        name: "  Pets  ",
        url: "https://example.com/openapi.yaml",
      }),
    ).toMatchObject({ name: "Pets", url: "https://example.com/openapi.yaml" });
  });

  it("maps only the public DTO", () => {
    const mapped = mapBotOpenApiSource({
      id: "source",
      botId: "bot",
      name: "Pets",
      url: "https://example.com/openapi.json",
      enabled: true,
      disabledReason: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(mapped).toEqual({
      id: "source",
      botId: "bot",
      name: "Pets",
      url: "https://example.com/openapi.json",
      enabled: true,
      disabledReason: null,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("lists and removes only within the workspace and bot", async () => {
    const row = {
      id: "source",
      botId: "bot",
      name: "Pets",
      url: "https://example.com/openapi.json",
      enabled: true,
      disabledReason: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    const prisma = {
      botOpenApiSource: {
        findMany: async (query: unknown) => {
          expect(query).toMatchObject({ where: { workspaceId: "workspace", botId: "bot" } });
          return [row];
        },
        deleteMany: async (query: unknown) => {
          expect(query).toEqual({
            where: { id: "source", workspaceId: "workspace", botId: "bot" },
          });
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    await expect(listBotOpenApiSources(prisma, base)).resolves.toHaveLength(1);
    await expect(removeBotOpenApiSource(prisma, { ...base, id: "source" })).resolves.toEqual({
      count: 1,
    });
  });

  it("adds through a scoped transaction", async () => {
    const tx = {
      $executeRaw: async () => 1,
      bot: { findFirst: async () => ({ id: "bot" }) },
      botOpenApiSource: {
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: "source",
          botId: data.botId,
          name: data.name,
          url: data.url,
          enabled: true,
          disabledReason: null,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        }),
      },
    };
    const prisma = {
      $transaction: async (run: (value: typeof tx) => unknown) => run(tx),
    } as unknown as PrismaClient;
    await expect(
      addBotOpenApiSource(prisma, { ...base, url: "https://example.com/openapi.json" }),
    ).resolves.toMatchObject({ id: "source", name: "Pets" });
  });
});
