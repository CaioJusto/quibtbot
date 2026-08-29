import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

interface WorkflowJob {
  name?: string;
  needs?: string | string[];
  "runs-on"?: unknown;
  strategy?: { matrix?: Record<string, unknown> };
  permissions?: Record<string, string>;
  steps?: Array<Record<string, unknown>>;
}

interface Workflow {
  on?: { push?: { tags?: string[] } };
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
}

const workflowPath = path.resolve(".github/workflows/release.yml");
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = parseYaml(workflowSource) as Workflow;
const jobs = workflow.jobs ?? {};
const jobIds = Object.keys(jobs);

function needsOf(job: WorkflowJob | undefined): string[] {
  if (!job?.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

/** Every step's `run` body, flattened, so substring checks don't care which job/step it lives in. */
function allRunBodies(): string {
  return jobIds
    .flatMap((id) => jobs[id]?.steps ?? [])
    .map((step) => String(step.run ?? ""))
    .join("\n");
}

/** Every step's `uses:`, flattened the same way. */
function allUses(): string[] {
  return jobIds
    .flatMap((id) => jobs[id]?.steps ?? [])
    .map((step) => String(step.uses ?? ""))
    .filter(Boolean);
}

describe("release workflow trigger and permissions", () => {
  it("fires only on version tags (v*)", () => {
    expect(workflow.on?.push?.tags).toContain("v*");
  });

  it("scopes write permissions to the jobs that publish packages or the draft release", () => {
    expect(workflow.permissions?.contents).toBe("read");
    expect(workflow.permissions?.packages).toBeUndefined();
    expect(jobs.images?.permissions).toEqual({ contents: "read", packages: "write" });
    expect(jobs.publish?.permissions).toEqual({ contents: "write" });
  });
});

describe("release workflow job graph", () => {
  const imageJobId = jobIds.find((id) => /image/i.test(id));
  const smokeJobId = jobIds.find((id) => /smoke/i.test(id));
  const publishJobId = jobIds.find((id) => /publish|release/i.test(id));

  it("defines an image-build job before the smoke job", () => {
    expect(imageJobId, "expected a job id containing 'image'").toBeDefined();
    expect(smokeJobId, "expected a job id containing 'smoke'").toBeDefined();
    expect(jobIds.indexOf(imageJobId!)).toBeLessThan(jobIds.indexOf(smokeJobId!));
  });

  it("makes the smoke job wait on the image-build job", () => {
    expect(needsOf(jobs[smokeJobId!])).toContain(imageJobId);
  });

  it("makes publication depend on the smoke job", () => {
    expect(publishJobId, "expected a job id containing 'publish' or 'release'").toBeDefined();
    expect(needsOf(jobs[publishJobId!])).toContain(smokeJobId);
  });
});

describe("release workflow platform coverage", () => {
  it("runs a build matrix that covers Ubuntu, macOS and Windows", () => {
    const matrixOsValues = jobIds
      .map((id) => jobs[id]?.strategy?.matrix)
      .filter((matrix): matrix is Record<string, unknown> => Boolean(matrix))
      .flatMap((matrix) => {
        const values = Object.values(matrix).flat();
        return values.flatMap((entry) => {
          if (typeof entry === "string") return [entry];
          if (entry && typeof entry === "object") return Object.values(entry as object);
          return [];
        });
      })
      .map((value) => String(value).toLowerCase());

    expect(matrixOsValues.some((v) => v.includes("ubuntu"))).toBe(true);
    expect(matrixOsValues.some((v) => v.includes("macos"))).toBe(true);
    expect(matrixOsValues.some((v) => v.includes("windows"))).toBe(true);
  });
});

describe("release workflow artifacts", () => {
  it("generates a checksum file over the published artifacts", () => {
    const runBodies = allRunBodies().toLowerCase();
    expect(runBodies).toMatch(/sha256sum|shasum -a 256/);
    expect(runBodies).toMatch(/checksum/);
  });

  it("publishes the GitHub Release as a draft, not immediately public", () => {
    const releaseStep = jobIds
      .flatMap((id) => jobs[id]?.steps ?? [])
      .find((step) => String(step.uses ?? "").includes("action-gh-release"));
    expect(releaseStep, "expected a step using an action-gh-release-style action").toBeDefined();
    const withInputs = (releaseStep?.with ?? {}) as Record<string, unknown>;
    expect(String(withInputs.draft)).toMatch(/true/i);
  });

  it("only publishes once validate, image, smoke and packaging jobs have all passed", () => {
    const publishJobId = jobIds.find((id) => /publish|release/i.test(id))!;
    const needs = needsOf(jobs[publishJobId]);
    // "draft until all jobs pass" means the publish job's own gate (needs:) must span the
    // pipeline, not just the smoke test — a single needs: [smoke] would let a broken desktop
    // packaging job publish anyway once GitHub Actions marks the DAG satisfied.
    expect(needs.length).toBeGreaterThanOrEqual(3);
  });

  it("excludes Docker build records from checksum and release artifact downloads", () => {
    for (const jobId of ["checksums", "publish"]) {
      const downloadStep = (jobs[jobId]?.steps ?? []).find((step) =>
        String(step.uses ?? "").includes("actions/download-artifact"),
      );
      expect((downloadStep?.with as Record<string, unknown> | undefined)?.pattern).toBe(
        "!*.dockerbuild",
      );
    }
  });
});

describe("release workflow signing", () => {
  it("only claims signed/notarized artifacts when the corresponding secret is present", () => {
    const runBodies = allRunBodies();
    // Real evidence, not a claim: some step must branch on a secret-derived env var before
    // treating an artifact as signed, e.g. `if: env.CSC_LINK != ''` or `[ -n "$CSC_LINK" ]`.
    expect(runBodies).toMatch(/CSC_LINK|WIN_CSC_LINK|APPLE_ID/);
  });

  it("does not run actual signing/notarization steps unconditionally", () => {
    const signingSteps = jobIds
      .flatMap((id) => jobs[id]?.steps ?? [])
      .filter((step) =>
        /notariz|codesign|signtool/i.test(String(step.name ?? "") + String(step.run ?? "")),
      );
    for (const step of signingSteps) {
      expect(step.if, `signing step ${JSON.stringify(step.name)} must be conditional`).toBeTruthy();
    }
  });

  it("runs the Windows signing report with the Bash syntax it contains", () => {
    const reportStep = jobIds
      .flatMap((id) => jobs[id]?.steps ?? [])
      .find((step) => step.name === "Report Windows signing status");
    expect(reportStep?.shell).toBe("bash");
  });
});

describe("release workflow smoke image version", () => {
  it("pins the smoke job's QUIBT_STACK_VERSION to the release validate resolved, not a hardcoded default", () => {
    const smokeJobId = jobIds.find((id) => /smoke/i.test(id))!;
    const smokeRunBodies = (jobs[smokeJobId]?.steps ?? [])
      .map((step) => String(step.run ?? ""))
      .join("\n");
    // `ensureInstallEnvironment` only *defaults* QUIBT_STACK_VERSION (from a hardcoded
    // INSTALL_RELEASE) when the key isn't already set — the smoke job must set it itself,
    // tied to the same release the images job just built and pushed, or a future version
    // bump can let compose pull/smoke resolve a different tag than the digests just pushed.
    expect(smokeRunBodies).toMatch(/QUIBT_STACK_VERSION/);
    expect(smokeRunBodies).toMatch(
      /\$RELEASE|needs\.validate\.outputs\.release|needs\.validate\.outputs\.version/,
    );
  });

  it("resolves the installer workspace import from the repository checkout", () => {
    const smokeJobId = jobIds.find((id) => /smoke/i.test(id))!;
    const smokeRunBodies = (jobs[smokeJobId]?.steps ?? [])
      .map((step) => String(step.run ?? ""))
      .join("\n");
    expect(smokeRunBodies).toContain("./packages/installer/src/index.ts");
    expect(smokeRunBodies).not.toContain("/tmp/gen-smoke-env.mts");
  });
});

describe("release workflow signing status publication", () => {
  it("attaches signing-status.json to the draft release instead of excluding it", () => {
    const publishJobId = jobIds.find((id) => /publish|release/i.test(id))!;
    const publishRunBodies = (jobs[publishJobId]?.steps ?? [])
      .map((step) => String(step.run ?? ""))
      .join("\n");
    expect(publishRunBodies).toMatch(/signing-status/);
    // The flatten step must still copy every signing-status.json it finds somewhere into
    // dist/release (renamed per platform to avoid one overwriting another) — not just skip it.
    const findsSigningStatus = /find\s+release-artifacts[^\n]*-name\s+"signing-status\.json"/;
    expect(publishRunBodies).toMatch(findsSigningStatus);
  });

  it("does not claim installers are signed/notarized in the release body", () => {
    const publishJobId = jobIds.find((id) => /publish|release/i.test(id))!;
    const releaseStep = (jobs[publishJobId]?.steps ?? []).find((step) =>
      String(step.uses ?? "").includes("action-gh-release"),
    );
    expect(releaseStep, "expected a step using an action-gh-release-style action").toBeDefined();
    const withInputs = (releaseStep?.with ?? {}) as Record<string, unknown>;
    const body = String(withInputs.body ?? "");
    expect(body.length, "expected a non-empty body noting signing status").toBeGreaterThan(0);
    expect(body).toMatch(/signing status/i);
    expect(body).not.toMatch(/is signed|is notarized|has been signed|has been notarized/i);
  });
});

describe("release workflow uses build-cli-binary.mjs and pack-desktop.mjs", () => {
  it("builds CLI binaries with scripts/build-cli-binary.mjs", () => {
    expect(allRunBodies()).toContain("scripts/build-cli-binary.mjs");
  });

  it("builds Electron installers with scripts/pack-desktop.mjs", () => {
    expect(allRunBodies()).toContain("scripts/pack-desktop.mjs");
  });

  it("passes downloaded CLI paths relative to the desktop package working directory", () => {
    const desktopJobId = jobIds.find((id) => /desktop|installer/i.test(id))!;
    const desktopRunBodies = (jobs[desktopJobId]?.steps ?? [])
      .map((step) => String(step.run ?? ""))
      .join("\n");
    expect(desktopRunBodies).toContain("../../dist/cli-binaries/quibtbot-linux-x64");
    expect(desktopRunBodies).toContain("../../dist/cli-binaries/quibtbot-linux-arm64");
  });

  it("checks out the repository and sets up pnpm/Node before running scripts", () => {
    expect(allUses().some((u) => u.includes("actions/checkout"))).toBe(true);
    expect(allUses().some((u) => u.includes("pnpm/action-setup"))).toBe(true);
    expect(allUses().some((u) => u.includes("actions/setup-node"))).toBe(true);
  });
});
