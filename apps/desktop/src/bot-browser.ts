export const BOT_BROWSER_PARTITION_PREFIX = "persist:bot-";

const SAFE_BOT_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function botBrowserPartition(botId: string): string {
  if (!SAFE_BOT_ID.test(botId)) {
    throw new Error("botId inválido para o navegador embutido");
  }
  return `${BOT_BROWSER_PARTITION_PREFIX}${botId}`;
}

export function allowedBotBrowserUrl(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export type BotBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function normalizeBotBrowserBounds(raw: unknown): BotBrowserBounds | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const x = Number(input.x);
  const y = Number(input.y);
  const width = Number(input.width);
  const height = Number(input.height);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  if (width < 1 || height < 1) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function parseBotBrowserAttach(raw: unknown): {
  botId: string;
  partition: string;
  bounds: BotBrowserBounds;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.botId !== "string") return null;
  const bounds = normalizeBotBrowserBounds(input.bounds);
  if (!bounds) return null;
  try {
    return { botId: input.botId, partition: botBrowserPartition(input.botId), bounds };
  } catch {
    return null;
  }
}

export function parseBotBrowserId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const botId = (raw as Record<string, unknown>).botId;
  if (typeof botId !== "string") return null;
  try {
    botBrowserPartition(botId);
    return botId;
  } catch {
    return null;
  }
}

export function takeoverOsNotification(input: { botName: string; reason: string }): {
  title: string;
  body: string;
} {
  const name = input.botName.trim() || "Quibt Bot";
  return {
    title: `${name} precisa de você`,
    body: input.reason.trim() || "Assuma o controle para continuar.",
  };
}
