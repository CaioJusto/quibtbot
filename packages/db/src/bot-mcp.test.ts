import { describe, expect, it } from "vitest";
import {
  addBotMcpServer,
  listBotMcpServers,
  mapBotMcpServer,
  removeBotMcpServer,
  validateBotMcpInput,
} from "./bot-mcp.js";
import type { PrismaClient } from "./client.js";

const base = { workspaceId: "workspace", botId: "bot", name: "Arquivos" };

describe("bot MCP validation", () => {
  it("rejects a shell string in the executable field", () => {
    expect(() => validateBotMcpInput({ ...base, command: "npx -y foo", args: [] })).toThrow(
      /one executable argv value/,
    );
  });

  it("requires arguments to be an array of strings", () => {
    expect(() => validateBotMcpInput({ ...base, command: "npx", args: "-y foo" })).toThrow(
      /array of strings/,
    );
    expect(() => validateBotMcpInput({ ...base, command: "npx", args: ["-y", 3] })).toThrow(
      /array of strings/,
    );
  });

  it("redacts env from the public projection", () => {
    const publicRow = mapBotMcpServer({
      id: "server",
      botId: "bot",
      name: "Arquivos",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      url: null,
      enabled: true,
      disabledReason: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      env: { TOKEN: "secret" },
    } as Parameters<typeof mapBotMcpServer>[0] & { env: Record<string, string> });
    expect(publicRow).not.toHaveProperty("env");
    expect(JSON.stringify(publicRow)).not.toContain("secret");
  });

  it("lists and removes only rows scoped to the workspace and bot", async () => {
    const findMany = async (query: unknown) => {
      expect(query).toMatchObject({ where: { workspaceId: "workspace", botId: "bot" } });
      return [
        {
          id: "server",
          botId: "bot",
          name: "Arquivos",
          transport: "stdio",
          command: "node",
          args: ["server.mjs"],
          url: null,
          env: { TOKEN: "secret" },
          enabled: true,
          disabledReason: null,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      ];
    };
    const deleteMany = async (query: unknown) => {
      expect(query).toEqual({
        where: { id: "server", workspaceId: "workspace", botId: "bot" },
      });
      return { count: 1 };
    };
    const prisma = { botMcpServer: { findMany, deleteMany } } as unknown as PrismaClient;
    const listed = await listBotMcpServers(prisma, { workspaceId: "workspace", botId: "bot" });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("secret");
    await expect(
      removeBotMcpServer(prisma, { workspaceId: "workspace", botId: "bot", id: "server" }),
    ).resolves.toEqual({ count: 1 });
  });

  it("adds through a scoped transaction and returns the public row", async () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z");
    const create = async (query: { data: Record<string, unknown> }) => {
      expect(query.data).toMatchObject({
        workspaceId: "workspace",
        botId: "bot",
        name: "Arquivos",
        command: "node",
        args: ["server.mjs"],
        env: { TOKEN: "secret" },
      });
      return {
        id: "server",
        botId: "bot",
        name: "Arquivos",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        url: null,
        enabled: true,
        disabledReason: null,
        createdAt,
      };
    };
    const tx = {
      $executeRaw: async () => 1,
      bot: { findFirst: async () => ({ id: "bot" }) },
      botMcpServer: { findMany: async () => [], create },
    };
    const prisma = {
      $transaction: async (run: (value: typeof tx) => unknown) => run(tx),
    } as unknown as PrismaClient;
    const added = await addBotMcpServer(prisma, {
      ...base,
      command: "node",
      args: ["server.mjs"],
      env: { TOKEN: "secret" },
    });
    expect(added.id).toBe("server");
    expect(JSON.stringify(added)).not.toContain("secret");
  });
});
