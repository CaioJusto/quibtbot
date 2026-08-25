import { createHash } from "node:crypto";
import { CAPABILITY_LIMITS, capabilityConfigIssue } from "@quibt/contracts";
import type { Prisma, PrismaClient } from "./client.js";

export type CapabilityKind = "skill" | "plugin" | "mcp";

export class CapabilityInstallError extends Error {
  constructor(
    readonly code: "invalid" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "CapabilityInstallError";
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

/** Honest, stable content identity used for idempotent installs. */
export function capabilityDigest(source: string, config: Record<string, unknown>): string {
  const canonical = JSON.stringify({ source, config: canonicalJson(config) });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function validateCapabilityInstall(input: {
  kind: CapabilityKind;
  name: string;
  source: string;
  config: Record<string, unknown>;
}): void {
  const name = input.name.trim();
  const source = input.source.trim();
  if (!name || name.length > CAPABILITY_LIMITS.nameChars) {
    throw new CapabilityInstallError("invalid", "Capability name is outside the allowed size");
  }
  if (!source || source.length > CAPABILITY_LIMITS.sourceChars) {
    throw new CapabilityInstallError("invalid", "Capability source is outside the allowed size");
  }
  const issue = capabilityConfigIssue(input.config);
  if (issue) throw new CapabilityInstallError("invalid", `Capability config is ${issue}`);
}

/**
 * One short transaction serializes quota checks for an actor. External validation (DNS/HTTP)
 * must happen before this function so the advisory lock is held only for database work.
 */
export async function installCapability(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    kind: CapabilityKind;
    name: string;
    source: string;
    config: Record<string, unknown>;
    version?: string;
  },
) {
  validateCapabilityInstall(input);
  const normalized = {
    ...input,
    name: input.name.trim(),
    source: input.source.trim(),
    digest: capabilityDigest(input.source.trim(), input.config),
  };

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capability-install:${input.workspaceId}:${input.userId}`}))`;
    const rows = await tx.capabilityInstall.findMany({
      where: { workspaceId: input.workspaceId, userId: input.userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CAPABILITY_LIMITS.totalPerUser + 1,
    });

    const duplicate = rows.find(
      (row) => row.kind === input.kind && row.digest === normalized.digest,
    );
    if (duplicate) return duplicate;

    const identity = rows.find((row) => {
      if (row.kind !== input.kind) return false;
      if (input.kind === "skill") return row.name.toLowerCase() === normalized.name.toLowerCase();
      return row.source === normalized.source;
    });
    if (identity) {
      return tx.capabilityInstall.update({
        where: { id: identity.id },
        data: {
          name: normalized.name,
          source: normalized.source,
          config: input.config as Prisma.InputJsonValue,
          digest: normalized.digest,
          version: input.version ?? "0.0.0",
        },
      });
    }

    if (rows.length >= CAPABILITY_LIMITS.totalPerUser) {
      throw new CapabilityInstallError(
        "limit",
        `Capability limit reached (${CAPABILITY_LIMITS.totalPerUser})`,
      );
    }
    if (
      input.kind === "mcp" &&
      rows.filter((row) => row.kind === "mcp").length >= CAPABILITY_LIMITS.mcpPerUser
    ) {
      throw new CapabilityInstallError(
        "limit",
        `MCP source limit reached (${CAPABILITY_LIMITS.mcpPerUser})`,
      );
    }

    return tx.capabilityInstall.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        kind: input.kind,
        name: normalized.name,
        source: normalized.source,
        config: input.config as Prisma.InputJsonValue,
        digest: normalized.digest,
        version: input.version ?? "0.0.0",
      },
    });
  });
}
