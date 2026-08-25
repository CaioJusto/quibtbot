import {
  approvalKey,
  autoDecision as coreAutoDecision,
  looksDestructive,
  looksSensitive,
} from "@quibt/core";

export { approvalKey, looksDestructive, looksSensitive };

export const GATED_TOOLS = new Set(["shell", "delete_bot"]);

export interface AutoApprover {
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

export function autoDecision(bot: AutoApprover, tool: string, summary: string): string | null {
  // This legacy broker used opt-in auto approval; keep that API contract while sharing the
  // hardened command policy with the production executor.
  return coreAutoDecision({ ...bot, autoApprove: bot.autoApprove === true }, tool, summary);
}

export function toolSummary(name: string, args: Record<string, unknown>): string {
  if (name === "shell") return String(args.command ?? args.cmd ?? "");
  if (name === "write_file") return String(args.path ?? "");
  if (name === "delete_bot")
    return String(args.confirm_name ?? args.confirmName ?? args.name ?? "");
  try {
    return JSON.stringify(args).slice(0, 400);
  } catch {
    return name;
  }
}

export function needsPermissionGate(name: string, args: Record<string, unknown>): boolean {
  if (GATED_TOOLS.has(name)) return true;
  const summary = toolSummary(name, args);
  if (looksDestructive(summary) || looksDestructive(name) || looksSensitive(summary)) return true;
  if (name === "write_file" && looksSensitive(String(args.path ?? ""))) return true;
  if (/send.?mail|gmail.*send|payment|stripe|charge|transfer/i.test(name)) return true;
  return false;
}

export type PermissionAsk = {
  tool: string;
  summary: string;
  approvalKey: string;
  held?: string;
};

export class PermissionRequiredError extends Error {
  readonly permission: PermissionAsk;

  constructor(permission: PermissionAsk) {
    super("permission_required");
    this.name = "PermissionRequiredError";
    this.permission = permission;
  }
}

export function isPermissionRequiredError(error: unknown): error is PermissionRequiredError {
  return error instanceof PermissionRequiredError;
}

export function parseAlwaysAllow(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function serializeAlwaysAllow(keys: string[]): string {
  return JSON.stringify([...new Set(keys)]);
}

export type PermissionCheckpoint = {
  kind: "permission";
  tool: string;
  summary: string;
  approvalKey: string;
  oneShotKey?: string;
};

export function parsePermissionCheckpoint(
  raw: string | null | undefined,
): PermissionCheckpoint | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PermissionCheckpoint>;
    if (parsed.kind !== "permission" || !parsed.tool || !parsed.approvalKey) return null;
    return {
      kind: "permission",
      tool: parsed.tool,
      summary: String(parsed.summary ?? ""),
      approvalKey: parsed.approvalKey,
      oneShotKey: parsed.oneShotKey,
    };
  } catch {
    return null;
  }
}

export function parsePermissionAnswer(answer: string): "allow" | "always" | "deny" {
  const lower = answer.trim().toLowerCase();
  if (lower === "always" || lower === "always allow" || lower === "allow always") return "always";
  if (lower === "deny" || lower === "denied" || lower === "no") return "deny";
  return "allow";
}

export function decideToolPermission(
  bot: AutoApprover,
  name: string,
  args: Record<string, unknown>,
  oneShotKey?: string,
): { action: "allow"; reason?: string } | { action: "ask"; ask: PermissionAsk } {
  const summary = toolSummary(name, args);
  const key = approvalKey(name, summary);
  if (oneShotKey && oneShotKey === key) return { action: "allow", reason: "allow-once" };
  if (!needsPermissionGate(name, args)) return { action: "allow" };
  const auto = autoDecision(bot, name, summary);
  if (auto) return { action: "allow", reason: auto };
  return {
    action: "ask",
    ask: {
      tool: name,
      summary,
      approvalKey: key,
      held:
        looksDestructive(summary) || looksSensitive(summary)
          ? "This looked destructive or sensitive, so auto mode stopped to ask."
          : undefined,
    },
  };
}
