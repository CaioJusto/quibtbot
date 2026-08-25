import type { PrismaClient } from "@quibt/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpoPushProvider, isExpoPushToken, removePushToken, savePushToken } from "./expo-push.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function prismaMock(input?: {
  tokens?: Array<{ id: string; token: string }>;
  pending?: Array<{ id: string; pushToken: { id: string } }>;
}) {
  const mock = {
    pushToken: {
      upsert: vi.fn().mockResolvedValue(undefined),
      findMany: vi.fn().mockResolvedValue(input?.tokens ?? []),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    pushTicket: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue(input?.pending ?? []),
    },
  };
  return { mock, prisma: mock as unknown as PrismaClient };
}

function context(userId = "user-1") {
  return {
    operationId: "n",
    traceId: "n",
    workspaceId: "w",
    userId,
    signal: new AbortController().signal,
  };
}

describe("expo push token registry", () => {
  it("accepts both current Expo token prefixes and rejects arbitrary values", () => {
    expect(isExpoPushToken("ExpoPushToken[abc_123-xyz]")).toBe(true);
    expect(isExpoPushToken("ExponentPushToken[abc123]")).toBe(true);
    expect(isExpoPushToken("https://attacker.example/token")).toBe(false);
  });

  it("reassigns a device token to the latest authenticated user", async () => {
    const { mock, prisma } = prismaMock();
    await savePushToken(prisma, "user-2", " ExpoPushToken[device-1] ");
    expect(mock.pushToken.upsert).toHaveBeenCalledWith({
      where: { token: "ExpoPushToken[device-1]" },
      create: { userId: "user-2", token: "ExpoPushToken[device-1]" },
      update: { userId: "user-2" },
    });
  });

  it("only unregisters the signed-in user's matching token", async () => {
    const { mock, prisma } = prismaMock();
    await removePushToken(prisma, "user-1", "ExpoPushToken[device-1]");
    expect(mock.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", token: "ExpoPushToken[device-1]" },
    });
  });
});

describe("expo push delivery", () => {
  it("does not call Expo when the user has no token", async () => {
    const { prisma } = prismaMock();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await new ExpoPushProvider(prisma).send(
      { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
      context("missing"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends to every registered device and persists delivery tickets", async () => {
    const { mock, prisma } = prismaMock({
      tokens: [
        { id: "push-1", token: "ExponentPushToken[first]" },
        { id: "push-2", token: "ExpoPushToken[second]" },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { status: "ok", id: "ticket-1" },
          { status: "ok", id: "ticket-2" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await new ExpoPushProvider(prisma).send(
      { kind: "takeover", title: "Need you", body: "on screen", botId: "bot-1", threadId: "th-1" },
      context(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(String(init.body)) as Array<{
      to: string;
      channelId: string;
      data: { botId: string };
    }>;
    expect(body.map(({ to }) => to)).toEqual(["ExponentPushToken[first]", "ExpoPushToken[second]"]);
    expect(body[0]).toMatchObject({ channelId: "default", data: { botId: "bot-1" } });
    expect(mock.pushTicket.createMany).toHaveBeenCalledWith({
      data: [
        { id: "ticket-1", pushTokenId: "push-1" },
        { id: "ticket-2", pushTokenId: "push-2" },
      ],
      skipDuplicates: true,
    });
  });

  it("removes tokens rejected as DeviceNotRegistered by a receipt", async () => {
    const { mock, prisma } = prismaMock({
      pending: [{ id: "ticket-old", pushToken: { id: "push-dead" } }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            "ticket-old": {
              status: "error",
              details: { error: "DeviceNotRegistered" },
            },
          },
        }),
      }),
    );
    await new ExpoPushProvider(prisma).send(
      { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
      context(),
    );
    expect(mock.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["push-dead"] } },
    });
    expect(mock.pushTicket.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["ticket-old"] } },
    });
  });
});
