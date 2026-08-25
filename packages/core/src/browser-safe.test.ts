import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `@quibt/core` is bundled by Vite (web) and Metro (mobile). Neither resolves Node builtins:
 * Vite only prints "externalized for browser compatibility" at build time and the app dies at
 * runtime with a white screen, which no other gate in this repo catches.
 *
 * So: nothing reachable from the barrel (`src/index.ts`) may import a Node builtin. Code that
 * genuinely needs Node stays out of the barrel and is published as a subpath, the way
 * `@quibt/core/secrets-guard` already is in package.json.
 */
const BARE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "url",
  "util",
  "worker_threads",
  "zlib",
]);

const SPECIFIER = /(?:import|export)[^"']*?from\s*["']([^"']+)["']/g;

function specifiersOf(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] as string);
}

/** Everything the barrel drags into a browser bundle. */
function barrelGraph(): Map<string, string[]> {
  const root = path.resolve(import.meta.dirname);
  const seen = new Map<string, string[]>();
  const queue = [path.join(root, "index.ts")];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const specifiers = specifiersOf(source);
    seen.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
      queue.push(resolved);
    }
  }
  return seen;
}

describe("the @quibt/core barrel stays browser safe", () => {
  it("reaches no Node builtin", () => {
    const offenders: string[] = [];
    for (const [file, specifiers] of barrelGraph()) {
      for (const specifier of specifiers) {
        if (specifier.startsWith("node:") || BARE_BUILTINS.has(specifier)) {
          offenders.push(`${path.basename(file)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually walks past index.ts", () => {
    const graph = barrelGraph();
    expect(graph.size).toBeGreaterThan(5);
    expect([...graph.keys()].some((file) => file.endsWith("control-lease.ts"))).toBe(true);
  });
});
