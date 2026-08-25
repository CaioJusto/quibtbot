import {
  formatMemoryBlock,
  parseMemoryEntries,
  sanitizeEntriesForSnapshot,
} from "./hermes-memory.js";

export type SkillInstall = {
  name: string;
  source: string;
  config?: Record<string, unknown>;
};

export function skillBody(skill: SkillInstall): string {
  const fromConfig =
    typeof skill.config?.instructions === "string" ? skill.config.instructions.trim() : "";
  if (fromConfig) return fromConfig;
  return skill.source.trim();
}

export function formatSkillPrompt(skills: SkillInstall[]): string {
  // The prompt tells the model "when the user types /Name, follow that skill exactly", so two
  // skills sharing a name would put two `### /Name` blocks in front of it with no way to choose.
  // The first install of a name wins; comparison ignores case and surrounding space because
  // `/Deploy` and `/deploy ` are the same token to the person typing it.
  const seen = new Set<string>();
  const usable = skills.filter((skill) => {
    if (!skill.name.trim() || !skillBody(skill)) return false;
    const key = skill.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!usable.length) return "";
  const blocks = usable
    .slice(0, 20)
    .map((skill) => `### /${skill.name}\n${skillBody(skill)}`)
    .join("\n\n");
  return [
    "Installed skills. When the user types /Name, follow that skill exactly.",
    "A skill is how to do the work. A routine is when to run it.",
    blocks,
  ].join("\n\n");
}

export function formatMemoryPrompt(
  documents: Array<{ scope: string; path: string; content: string }>,
): string {
  const botDoc = documents.find((doc) => doc.scope === "bot" && doc.path === "MEMORY.md");
  const userDoc =
    documents.find((doc) => doc.scope === "user" && doc.path === "USER.md") ??
    documents.find((doc) => doc.scope === "user" && doc.path === "MEMORY.md");
  const botEntries = sanitizeEntriesForSnapshot(
    parseMemoryEntries(botDoc?.content ?? ""),
    "MEMORY.md",
  );
  const userEntries = sanitizeEntriesForSnapshot(
    parseMemoryEntries(userDoc?.content ?? ""),
    "USER.md",
  );
  const blocks = [
    formatMemoryBlock("memory", botEntries),
    formatMemoryBlock("user", userEntries),
  ].filter(Boolean);
  if (!blocks.length) return "";
  return [
    "Persistent notes survive across sessions. Writes persist immediately but this snapshot stays frozen until the next turn.",
    "Update with the memory tool: add, replace, or remove. If a file hits its limit, consolidate entries first, then retry.",
    ...blocks,
  ].join("\n\n");
}
