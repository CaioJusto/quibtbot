export const CAPABILITY_LIMITS = {
  totalPerUser: 100,
  mcpPerUser: 10,
  nameChars: 80,
  sourceChars: 2_048,
  configBytes: 32 * 1_024,
  configDepth: 8,
  configKeys: 256,
  mcpToolsPerSource: 32,
  mcpToolsTotal: 128,
} as const;

export type CapabilityConfigIssue = "too_large" | "too_deep" | "too_many_keys";

/** Browser-safe structural bounds shared by the RPC contract and database writer. */
export function capabilityConfigIssue(value: unknown): CapabilityConfigIssue | null {
  let keys = 0;
  const visit = (item: unknown, depth: number): CapabilityConfigIssue | null => {
    if (depth > CAPABILITY_LIMITS.configDepth) return "too_deep";
    if (Array.isArray(item)) {
      for (const child of item) {
        const issue = visit(child, depth + 1);
        if (issue) return issue;
      }
      return null;
    }
    if (!item || typeof item !== "object") return null;
    for (const child of Object.values(item as Record<string, unknown>)) {
      keys += 1;
      if (keys > CAPABILITY_LIMITS.configKeys) return "too_many_keys";
      const issue = visit(child, depth + 1);
      if (issue) return issue;
    }
    return null;
  };
  const structural = visit(value, 0);
  if (structural) return structural;
  try {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength > CAPABILITY_LIMITS.configBytes
    ) {
      return "too_large";
    }
  } catch {
    return "too_large";
  }
  return null;
}
