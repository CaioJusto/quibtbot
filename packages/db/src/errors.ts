/** Prisma P2002 on the unique `(workspaceId, clientNonce)` of `runs`. */
export function isRunNonceConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    meta?: { modelName?: string; target?: string[] | string };
  };
  if (candidate.code !== "P2002") return false;
  const target = Array.isArray(candidate.meta?.target)
    ? candidate.meta.target
    : candidate.meta?.target
      ? [candidate.meta.target]
      : [];
  return candidate.meta?.modelName === "Run" || target.includes("clientNonce");
}
