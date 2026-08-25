import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Repo-level ops invariants: the CI workflow and `.env.example` are the two files that
 * promise "this is exercised" and "this is configurable" without any type system behind
 * them. They live with the supervisor because this is the ops-owned package the root
 * vitest run already picks up.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  engines: { node: string };
  scripts: Record<string, string>;
};

function parseVersion(value: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = value.split(".").map(Number);
  return [major, minor, patch];
}

/** Enough semver for `>=x.y.z`: CI must pin a version, never a floating major. */
function satisfiesMinimum(version: string, range: string): boolean {
  const minimum = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  if (!minimum?.[1]) throw new Error(`unsupported engines range: ${range}`);
  const [major, minor, patch] = parseVersion(version);
  const [wantMajor, wantMinor, wantPatch] = parseVersion(minimum[1]);
  if (major !== wantMajor) return major > wantMajor;
  if (minor !== wantMinor) return minor > wantMinor;
  return patch >= wantPatch;
}

describe("ci workflow", () => {
  it("pins a Node version that satisfies package.json engines", () => {
    const pinned = /^\s*NODE_VERSION:\s*"(\d+\.\d+\.\d+)"\s*$/m.exec(workflow)?.[1];
    expect(pinned, "the workflow must pin an exact Node version").toBeTruthy();
    expect(satisfiesMinimum(pinned ?? "0.0.0", packageJson.engines.node)).toBe(true);

    // Every job must use the pinned value: `node-version: 22` resolves to whatever 22.x the
    // runner happens to offer, which is how CI ran a Node the repo does not support.
    const versions = [...workflow.matchAll(/^\s*node-version:\s*(.+)$/gm)].map((match) =>
      (match[1] ?? "").trim(),
    );
    expect(versions.length).toBeGreaterThan(0);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the GitHub Actions expression itself
    const pinnedReference = "${{ env.NODE_VERSION }}";
    expect([...new Set(versions)]).toEqual([pinnedReference]);
  });

  it("runs the Playwright golden journey against a real Postgres", () => {
    const e2e = jobBlock("e2e");
    expect(e2e).toContain("image: postgres:16");
    expect(e2e).toContain("pnpm db:migrate");
    expect(e2e).toContain("playwright install --with-deps chromium");
    expect(e2e).toContain("playwright test");
    // Playwright's webServer only starts Vite; without these the journey has no backend.
    expect(e2e).toContain("@quibt/api start");
    expect(e2e).toContain("@quibt/worker start");
  });

  it("keeps a real Docker smoke wired to the supervisor script", () => {
    const smoke = jobBlock("docker-smoke");
    expect(packageJson.scripts["sandbox:build"]).toContain("docker build");
    expect(smoke).toContain("pnpm sandbox:build");
    expect(smoke).toContain("@quibt/sandbox-supervisor start");
    expect(smoke).toContain("infra/sandboxes/supervisor/src/smoke.ts");
    // Expensive, so it may skip pushes — but it must stay reachable on a schedule.
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron:/);
    expect(smoke).toContain("github.event_name == 'schedule'");
  });
});

describe(".env.example", () => {
  it("only documents variables the code actually reads", () => {
    const example = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    const documented = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(documented.length).toBeGreaterThan(20);
    const sources = sourceFiles();
    const unread = documented.filter((name) => !sources.some((file) => file.includes(name)));
    expect(unread, "these are offered in .env.example but nothing reads them").toEqual([]);
  });
});

function jobBlock(job: string): string {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  expect(start, `job ${job} is missing from ci.yml`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

const SKIPPED_DIRECTORIES = new Set([
  ".astro",
  ".git",
  ".turbo",
  ".vercel",
  "android",
  "coverage",
  "dist",
  "generated",
  "ios",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);
const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yml",
]);

/** Everything the running product could read an env var from — docs deliberately excluded. */
function sourceFiles(): string[] {
  const contents: string[] = [];
  for (const root of ["apps", "packages", "infra", "services", "scripts", ".github"]) {
    walk(path.join(repoRoot, root), contents);
  }
  return contents;
}

function walk(directory: string, contents: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = path.join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, contents);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry))) continue;
    if (stats.size > 2_000_000) continue;
    contents.push(readFileSync(full, "utf8"));
  }
}
