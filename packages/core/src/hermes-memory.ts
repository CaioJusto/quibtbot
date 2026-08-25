/**
 * Curated memory copied from NousResearch/hermes-agent (`tools/memory_tool.py`).
 *
 * Two stores, injected as a frozen snapshot at the start of each turn:
 * - MEMORY.md — agent notes (environment, conventions, lessons). 2,200 chars.
 * - USER.md — who the user is (preferences, style, timezone). 1,375 chars.
 *
 * Entries are joined by `§`. The `memory` tool adds, replaces, or removes
 * one entry (or a batch) without rewriting the other entries. Writes persist
 * immediately; the prompt snapshot only refreshes on the next turn.
 */

export const ENTRY_DELIMITER = "\n§\n";

export const MEMORY_CHAR_LIMIT = 2200;
export const USER_CHAR_LIMIT = 1375;

export const MEMORY_BLOCK_HEADERS = {
  memory: "MEMORY (your personal notes)",
  user: "USER PROFILE (who the user is)",
} as const;

export type MemoryTarget = "memory" | "user";
export type MemoryAction = "add" | "replace" | "remove";

export type MemoryOp = {
  action?: string;
  content?: string;
  new_text?: string;
  old_text?: string;
};

export type MemoryToolArgs = {
  action?: string;
  target?: string;
  content?: string;
  new_text?: string;
  old_text?: string;
  operations?: MemoryOp[];
};

export type MemoryToolResult = {
  success: boolean;
  done?: boolean;
  error?: string;
  message?: string;
  note?: string;
  target?: MemoryTarget;
  usage?: string;
  entry_count?: number;
  current_entries?: string[];
  matches?: string[];
};

export type MemoryMutation = {
  result: MemoryToolResult;
  nextContent?: string;
};

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(your\s+)?(system\s+)?prompt/i,
  /you\s+are\s+now\s+(?:a|an|the)\s+/i,
  /new\s+system\s+prompt\s*:/i,
  /<\s*\|?\s*(system|im_start|endoftext)/i,
  /\[INST\]|<<SYS>>/i,
];

const EXFIL_PATTERNS = [
  /exfiltrat/i,
  /(api[_-]?key|secret|password|token|credential).{0,80}(https?:\/\/|curl\s|wget\s)/i,
  /(https?:\/\/|curl\s|wget\s).{0,80}(api[_-]?key|secret|password|token|credential)/i,
];

const INVISIBLE_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

export function memoryCharLimit(target: MemoryTarget): number {
  return target === "user" ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

export function parseMemoryEntries(raw: string): string[] {
  if (!raw.trim()) return [];
  if (raw.includes(ENTRY_DELIMITER)) {
    return dedupe(
      raw
        .split(ENTRY_DELIMITER)
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }
  return parseLegacyMarkdown(raw);
}

export function serializeMemoryEntries(entries: string[]): string {
  return entries.filter(Boolean).join(ENTRY_DELIMITER);
}

export function memoryCharCount(entries: string[]): number {
  if (!entries.length) return 0;
  return serializeMemoryEntries(entries).length;
}

export function formatMemoryUsage(entries: string[], target: MemoryTarget): string {
  const current = memoryCharCount(entries);
  const limit = memoryCharLimit(target);
  const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
  return `${pct}% — ${formatCount(current)}/${formatCount(limit)} chars`;
}

export function formatMemoryUsageFromRaw(raw: string, target: MemoryTarget): string {
  return formatMemoryUsage(parseMemoryEntries(raw), target);
}

export function formatMemoryBlock(target: MemoryTarget, entries: string[]): string {
  if (!entries.length) return "";
  const limit = memoryCharLimit(target);
  const content = serializeMemoryEntries(entries);
  const current = content.length;
  const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
  const header = `${MEMORY_BLOCK_HEADERS[target]} [${pct}% — ${formatCount(current)}/${formatCount(limit)} chars]`;
  const separator = "═".repeat(46);
  return `${separator}\n${header}\n${separator}\n${content}`;
}

export function resolveUserMemoryPath(paths: string[]): "USER.md" | "MEMORY.md" {
  if (paths.includes("USER.md")) return "USER.md";
  if (paths.includes("MEMORY.md")) return "MEMORY.md";
  return "USER.md";
}

export function scanMemoryContent(content: string): string | null {
  if (INVISIBLE_UNICODE.test(content)) {
    return "Blocked: memory entry contains invisible Unicode. Rewrite it in plain text.";
  }
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(content))) {
    return "Blocked: memory entry looks like a prompt-injection. Rewrite it as a fact, not as instructions to the model.";
  }
  if (EXFIL_PATTERNS.some((pattern) => pattern.test(content))) {
    return "Blocked: memory entry looks like an exfiltration attempt. Store the fact, not a request to send secrets.";
  }
  return null;
}

export function sanitizeEntriesForSnapshot(entries: string[], filename: string): string[] {
  return entries.map((entry) => {
    if (!entry || entry.startsWith("[BLOCKED:")) return entry;
    const threat = scanMemoryContent(entry);
    if (!threat) return entry;
    return `[BLOCKED: ${filename} entry contained a threat pattern. Removed from system prompt; use memory(action=remove) to delete the original.]`;
  });
}

export function applyMemoryTool(raw: string, args: MemoryToolArgs): MemoryMutation {
  const target = normalizeTarget(args.target);
  if (!target) {
    return {
      result: { success: false, error: `Invalid target '${args.target}'. Use 'memory' or 'user'.` },
    };
  }

  const working = parseMemoryEntries(raw);
  if (args.operations) {
    if (!Array.isArray(args.operations)) {
      return {
        result: {
          success: false,
          error: "operations must be a list of {action, content?, old_text?} objects.",
        },
      };
    }
    return applyBatch(working, target, args.operations);
  }

  const content = coalesceContent(args.content, args.new_text);
  const action = String(args.action ?? "").trim();
  if (action === "add") {
    if (!content)
      return { result: { success: false, error: "Content is required for 'add' action." } };
    return addEntry(working, target, content);
  }
  if (action === "replace") {
    const oldText = String(args.old_text ?? "").trim();
    if (!oldText) {
      return {
        result: {
          success: false,
          error:
            "old_text is required for 'replace'. Check current_entries and retry with a unique substring.",
          current_entries: working,
        },
      };
    }
    if (!content) {
      return {
        result: {
          success: false,
          error: "content is required for 'replace' action. Use 'remove' to delete entries.",
        },
      };
    }
    return replaceEntry(working, target, oldText, content);
  }
  if (action === "remove") {
    const oldText = String(args.old_text ?? "").trim();
    if (!oldText) {
      return {
        result: {
          success: false,
          error:
            "old_text is required for 'remove'. Check current_entries and retry with a unique substring.",
          current_entries: working,
        },
      };
    }
    return removeEntry(working, target, oldText);
  }
  return {
    result: { success: false, error: `Unknown action '${action}'. Use: add, replace, remove` },
  };
}

function addEntry(entries: string[], target: MemoryTarget, content: string): MemoryMutation {
  const trimmed = content.trim();
  if (!trimmed) return { result: { success: false, error: "Content cannot be empty." } };
  const scanError = scanMemoryContent(trimmed);
  if (scanError) return { result: { success: false, error: scanError } };
  if (entries.includes(trimmed)) {
    return {
      result: successResponse(entries, target, "Entry already exists (no duplicate added)."),
    };
  }
  const next = [...entries, trimmed];
  const overflow = budgetError(entries, next, target, {
    kind: "add",
    incomingChars: trimmed.length,
  });
  if (overflow) return { result: overflow };
  return {
    result: successResponse(next, target, "Entry added."),
    nextContent: serializeMemoryEntries(next),
  };
}

function replaceEntry(
  entries: string[],
  target: MemoryTarget,
  oldText: string,
  newContent: string,
): MemoryMutation {
  const scanError = scanMemoryContent(newContent);
  if (scanError) return { result: { success: false, error: scanError } };
  const matched = matchEntries(entries, oldText);
  if (!matched.ok) return { result: matched.result };
  const next = [...entries];
  next[matched.index] = newContent;
  const overflow = budgetError(entries, next, target, { kind: "replace" });
  if (overflow) return { result: overflow };
  return {
    result: successResponse(next, target, "Entry replaced."),
    nextContent: serializeMemoryEntries(next),
  };
}

function removeEntry(entries: string[], target: MemoryTarget, oldText: string): MemoryMutation {
  const matched = matchEntries(entries, oldText);
  if (!matched.ok) return { result: matched.result };
  const next = entries.filter((_, index) => index !== matched.index);
  return {
    result: successResponse(next, target, "Entry removed."),
    nextContent: serializeMemoryEntries(next),
  };
}

function applyBatch(
  entries: string[],
  target: MemoryTarget,
  operations: MemoryOp[],
): MemoryMutation {
  if (!operations.length) return { result: { success: false, error: "operations list is empty." } };
  const working = [...entries];
  for (const [index, rawOp] of operations.entries()) {
    const op = rawOp ?? {};
    const act = String(op.action ?? "").trim();
    const content = coalesceContent(op.content, op.new_text);
    const oldText = String(op.old_text ?? "").trim();
    const pos = `Operation ${index + 1} (${act || "unknown"})`;

    if (act === "add") {
      if (!content) {
        return batchError(entries, target, `${pos}: content is required.`);
      }
      const scanError = scanMemoryContent(content);
      if (scanError) return { result: { success: false, error: `${pos}: ${scanError}` } };
      if (!working.includes(content)) working.push(content);
      continue;
    }
    if (act === "replace") {
      if (!oldText) return batchError(entries, target, `${pos}: old_text is required.`);
      if (!content) {
        return batchError(
          entries,
          target,
          `${pos}: content is required (use action='remove' to delete).`,
        );
      }
      const scanError = scanMemoryContent(content);
      if (scanError) return { result: { success: false, error: `${pos}: ${scanError}` } };
      const matched = matchEntries(working, oldText);
      if (!matched.ok) return batchError(entries, target, `${pos}: ${matched.result.error}`);
      working[matched.index] = content;
      continue;
    }
    if (act === "remove") {
      if (!oldText) return batchError(entries, target, `${pos}: old_text is required.`);
      const matched = matchEntries(working, oldText);
      if (!matched.ok) return batchError(entries, target, `${pos}: ${matched.result.error}`);
      working.splice(matched.index, 1);
      continue;
    }
    return batchError(entries, target, `${pos}: unknown action. Use add, replace, or remove.`);
  }

  const overflow = budgetError(entries, working, target, { kind: "batch" });
  if (overflow) return { result: overflow };
  return {
    result: successResponse(working, target, "Batch applied."),
    nextContent: serializeMemoryEntries(working),
  };
}

function matchEntries(
  entries: string[],
  oldText: string,
): { ok: true; index: number } | { ok: false; result: MemoryToolResult } {
  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter((row) => row.entry.includes(oldText));
  if (!matches.length) {
    return {
      ok: false,
      result: {
        success: false,
        error: `No entry matched '${oldText}'. Check current_entries below and retry with the exact text of the entry you want to change.`,
        current_entries: entries,
      },
    };
  }
  const unique = new Set(matches.map((row) => row.entry));
  if (unique.size > 1) {
    return {
      ok: false,
      result: {
        success: false,
        error: `Multiple entries matched '${oldText}'. Be more specific.`,
        matches: matches.map((row) => preview(row.entry)),
      },
    };
  }
  return { ok: true, index: matches[0]!.index };
}

function budgetError(
  currentEntries: string[],
  next: string[],
  target: MemoryTarget,
  detail: { kind: "add" | "replace" | "batch"; incomingChars?: number },
): MemoryToolResult | null {
  const limit = memoryCharLimit(target);
  const newTotal = memoryCharCount(next);
  if (newTotal <= limit) return null;
  const current = memoryCharCount(currentEntries);
  const usage = `${formatCount(current)}/${formatCount(limit)}`;
  if (detail.kind === "add") {
    return {
      success: false,
      error:
        `Memory at ${formatCount(current)}/${formatCount(limit)} chars. ` +
        `Adding this entry (${detail.incomingChars ?? 0} chars) would exceed the limit. ` +
        `Consolidate now: use 'replace' to merge overlapping entries into shorter ones or 'remove' stale entries ` +
        `(see current_entries below), then retry this add — all in this turn.`,
      current_entries: currentEntries,
      usage,
    };
  }
  return {
    success: false,
    error:
      `This change would put memory at ${formatCount(newTotal)}/${formatCount(limit)} chars. ` +
      `Shorten the new content, or 'remove' other stale entries to make room (see current_entries below), then retry.`,
    current_entries: currentEntries,
    usage,
  };
}

function successResponse(
  entries: string[],
  target: MemoryTarget,
  message: string,
): MemoryToolResult {
  return {
    success: true,
    done: true,
    target,
    usage: formatMemoryUsage(entries, target),
    entry_count: entries.length,
    message,
    note: "Write saved. This update is complete — do not repeat it.",
  };
}

function batchError(entries: string[], target: MemoryTarget, error: string): MemoryMutation {
  return {
    result: {
      success: false,
      error,
      current_entries: entries,
      usage: `${formatCount(memoryCharCount(entries))}/${formatCount(memoryCharLimit(target))}`,
    },
  };
}

function parseLegacyMarkdown(raw: string): string[] {
  const withoutHeadings = raw.replace(/^#{1,6}\s+.*$/gm, "").trim();
  if (!withoutHeadings) return [];
  const items: string[] = [];
  for (const chunk of withoutHeadings.split(/\n{2,}/)) {
    let paragraph: string[] = [];
    for (const line of chunk.split("\n")) {
      const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
      if (bullet) {
        if (paragraph.length) {
          items.push(paragraph.join("\n").trim());
          paragraph = [];
        }
        items.push(bullet[1]!.trim());
      } else {
        paragraph.push(line);
      }
    }
    if (paragraph.length) items.push(paragraph.join("\n").trim());
  }
  return dedupe(items.filter(Boolean));
}

function normalizeTarget(value: unknown): MemoryTarget | null {
  if (value == null || value === "") return "memory";
  const target = String(value).trim();
  if (target === "memory" || target === "user") return target;
  return null;
}

function coalesceContent(content?: string, newText?: string): string {
  const primary = content ?? newText ?? "";
  return String(primary).trim();
}

function dedupe(entries: string[]): string[] {
  return [...new Set(entries)];
}

function preview(entry: string, width = 80): string {
  return entry.length > width ? `${entry.slice(0, width)}...` : entry;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
