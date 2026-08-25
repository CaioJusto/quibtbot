import type { AdapterContext, NotificationMessage, NotificationProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]+\]$/;
const MAX_TOKENS_PER_USER = 10;
const RECEIPT_DELAY_MS = 60_000;
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

type ExpoResult = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

export function isExpoPushToken(token: string): boolean {
  return EXPO_TOKEN.test(token.trim());
}

export async function savePushToken(
  prisma: PrismaClient,
  userId: string,
  token: string,
): Promise<void> {
  const normalized = token.trim();
  if (!isExpoPushToken(normalized)) throw new Error("Invalid Expo push token");

  // A device token belongs to the most recently authenticated account. Updating
  // the owner prevents a shared device from continuing to notify a signed-out user.
  await prisma.pushToken.upsert({
    where: { token: normalized },
    create: { userId, token: normalized },
    update: { userId },
  });
  const excess = await prisma.pushToken.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    skip: MAX_TOKENS_PER_USER,
    select: { id: true },
  });
  if (excess.length) {
    await prisma.pushToken.deleteMany({ where: { id: { in: excess.map(({ id }) => id) } } });
  }
}

export async function removePushToken(
  prisma: PrismaClient,
  userId: string,
  token: string,
): Promise<void> {
  await prisma.pushToken.deleteMany({ where: { userId, token: token.trim() } });
}

export class ExpoPushProvider implements NotificationProvider {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "expo-push",
      contractVersion: "2",
      adapterVersion: "0.2.0",
      capabilities: { push: true, email: false },
    };
  }

  async send(message: NotificationMessage, context: AdapterContext): Promise<void> {
    await this.reconcileReceipts(context);
    const tokens = await this.prisma.pushToken.findMany({
      where: { userId: context.userId },
      orderBy: { updatedAt: "desc" },
      take: MAX_TOKENS_PER_USER,
      select: { id: true, token: true },
    });
    if (!tokens.length) return;

    const body = await this.post(
      EXPO_SEND_URL,
      tokens.map(({ token }) => ({
        to: token,
        title: message.title,
        body: message.body,
        channelId: "default",
        data: { kind: message.kind, botId: message.botId, threadId: message.threadId },
      })),
      context.signal,
    );
    const results = Array.isArray(body.data) ? body.data : [body.data];
    const invalidTokenIds = new Set<string>();
    const tickets: Array<{ id: string; pushTokenId: string }> = [];
    const transientErrors: string[] = [];

    for (const [index, token] of tokens.entries()) {
      const result = results[index] as ExpoResult | undefined;
      if (!result) {
        transientErrors.push("Expo did not return a ticket for every token");
        continue;
      }
      if (result.status === "ok" && result.id) {
        tickets.push({ id: result.id, pushTokenId: token.id });
      } else if (result.details?.error === "DeviceNotRegistered") {
        invalidTokenIds.add(token.id);
      } else if (result.status === "error") {
        transientErrors.push(result.message ?? result.details?.error ?? "Expo rejected a push");
      }
    }

    if (invalidTokenIds.size) {
      await this.prisma.pushToken.deleteMany({ where: { id: { in: [...invalidTokenIds] } } });
    }
    if (tickets.length) {
      await this.prisma.pushTicket.createMany({ data: tickets, skipDuplicates: true });
    }
    if (transientErrors.length) throw new Error(transientErrors.join("; "));
  }

  private async reconcileReceipts(context: AdapterContext): Promise<void> {
    const now = Date.now();
    await this.prisma.pushTicket.deleteMany({
      where: { createdAt: { lt: new Date(now - RECEIPT_RETENTION_MS) } },
    });
    const pending = await this.prisma.pushTicket.findMany({
      where: {
        createdAt: { lte: new Date(now - RECEIPT_DELAY_MS) },
        pushToken: { is: { userId: context.userId } },
      },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: {
        id: true,
        pushToken: { select: { id: true } },
      },
    });
    if (!pending.length) return;

    const body = await this.post(
      EXPO_RECEIPTS_URL,
      { ids: pending.map(({ id }) => id) },
      context.signal,
    );
    const receipts =
      body.data && !Array.isArray(body.data) ? (body.data as Record<string, ExpoResult>) : {};
    const resolvedTicketIds: string[] = [];
    const invalidTokenIds = new Set<string>();
    for (const ticket of pending) {
      const receipt = receipts[ticket.id];
      if (!receipt) continue;
      resolvedTicketIds.push(ticket.id);
      if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
        invalidTokenIds.add(ticket.pushToken.id);
      }
    }
    if (invalidTokenIds.size) {
      await this.prisma.pushToken.deleteMany({ where: { id: { in: [...invalidTokenIds] } } });
    }
    if (resolvedTicketIds.length) {
      await this.prisma.pushTicket.deleteMany({ where: { id: { in: resolvedTicketIds } } });
    }
  }

  private async post(
    url: string,
    payload: unknown,
    parentSignal: AbortSignal,
  ): Promise<{ data: ExpoResult | ExpoResult[] | Record<string, ExpoResult> }> {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) throw new Error(`Expo push request failed (${response.status})`);
    const body = (await response.json()) as {
      data?: ExpoResult | ExpoResult[] | Record<string, ExpoResult>;
      errors?: Array<{ message?: string }>;
    };
    if (!body.data) throw new Error(body.errors?.[0]?.message ?? "Expo push returned no data");
    return { data: body.data };
  }
}
