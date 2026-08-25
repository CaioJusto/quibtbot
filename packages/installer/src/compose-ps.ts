export interface ComposePsRow {
  Service?: string;
  State?: string;
  Health?: string;
  Name?: string;
}

function parseComposePsChunk(chunk: string): ComposePsRow[] {
  const parsed = JSON.parse(chunk) as ComposePsRow | ComposePsRow[];
  if (Array.isArray(parsed)) return parsed;
  return [parsed];
}

export function parseComposePsOutput(stdout: string): {
  rows: ComposePsRow[];
  errors: string[];
} {
  const trimmed = stdout.trim();
  if (!trimmed) return { rows: [], errors: [] };

  const errors: string[] = [];
  const rows: ComposePsRow[] = [];

  try {
    rows.push(...parseComposePsChunk(trimmed));
    return { rows, errors };
  } catch {
    // fall through to line-delimited parsing
  }

  for (const line of trimmed.split("\n")) {
    const chunk = line.trim();
    if (!chunk) continue;
    try {
      rows.push(...parseComposePsChunk(chunk));
    } catch {
      errors.push(`invalid compose ps line: ${chunk.slice(0, 120)}`);
    }
  }

  return { rows, errors };
}
