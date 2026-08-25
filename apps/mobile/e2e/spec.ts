import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type JourneyStep = {
  id: string;
  description?: string;
};

export type JourneySpec = {
  name: string;
  description?: string;
  steps: JourneyStep[];
};

const DEFAULT_SPEC_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "bootstrap-flow.yaml",
);

/**
 * Reads and validates `bootstrap-flow.yaml`. The harness trusts this file as the source
 * of truth for step order, so a malformed or empty step list fails loudly instead of the
 * test suite silently doing nothing.
 */
export function loadJourneySpec(specPath: string = DEFAULT_SPEC_PATH): JourneySpec {
  const raw = readFileSync(specPath, "utf8");
  const parsed = parse(raw) as Partial<JourneySpec> | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${specPath} did not parse to an object`);
  }
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(`${specPath} must declare a non-empty "steps" list`);
  }
  for (const step of parsed.steps) {
    if (!step || typeof step.id !== "string" || !step.id.trim()) {
      throw new Error(`${specPath} has a step without a string "id"`);
    }
  }
  return {
    name: typeof parsed.name === "string" ? parsed.name : "Mobile journey",
    description: typeof parsed.description === "string" ? parsed.description : undefined,
    steps: parsed.steps as JourneyStep[],
  };
}
