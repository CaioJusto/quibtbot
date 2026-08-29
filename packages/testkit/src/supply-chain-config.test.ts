import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const rootPackage = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
  packageManager?: string;
  engines?: { pnpm?: string };
  scripts?: Record<string, string>;
  pnpm?: { onlyBuiltDependencies?: string[]; ignoredBuiltDependencies?: string[] };
};
const workflowFiles = ["ci.yml", "publish-images.yml", "release.yml"];
const workflowSources = workflowFiles.map((name) => ({
  name,
  source: readFileSync(path.resolve(".github/workflows", name), "utf8"),
}));
const installerSource = readFileSync(path.resolve("scripts/install.sh"), "utf8");
const publicInstallerReferenceFiles = ["README.md", "docs/onboarding.md", "scripts/install.sh"];
const installScriptModuleSource = readFileSync(
  path.resolve("packages/core/src/install-script.ts"),
  "utf8",
);
const installScriptConsumerFiles = [
  "packages/core/src/computer-catalog.ts",
  "apps/mobile/lib/server-setup.ts",
  "apps/www/src/site.ts",
];
const workspaceConfig = parseYaml(readFileSync(path.resolve("pnpm-workspace.yaml"), "utf8")) as {
  minimumReleaseAge?: number;
  blockExoticSubdeps?: boolean;
};
const dependabotSource = readFileSync(path.resolve(".github/dependabot.yml"), "utf8");
const codeownersSource = readFileSync(path.resolve(".github/CODEOWNERS"), "utf8");
const dockerfiles = [
  "infra/compose/Dockerfile",
  "infra/release/Dockerfile.cli-binary",
  "infra/sandboxes/computer/Dockerfile",
  "infra/sandboxes/desktop/Dockerfile",
  "infra/sandboxes/supervisor/Dockerfile",
];

describe("dependency installer hardening", () => {
  it("pins the patched pnpm 10 line by registry integrity and refuses older majors", () => {
    expect(rootPackage.packageManager).toMatch(/^pnpm@10\.34\.5\+sha512\.[a-f0-9]{128}$/);
    expect(rootPackage.engines?.pnpm).toBe(">=10.34.5 <11");
  });

  it("allows lifecycle scripts only for the reviewed native/runtime dependencies", () => {
    expect(rootPackage.pnpm?.onlyBuiltDependencies).toEqual([
      "@prisma/engines",
      "cpu-features",
      "electron-winstaller",
      "esbuild",
      "prisma",
      "protobufjs",
      "ssh2",
    ]);
    expect(rootPackage.pnpm?.ignoredBuiltDependencies).toEqual([
      "@google/genai",
      "onnxruntime-node",
    ]);
  });

  it("delays new registry releases and blocks nested git/tarball dependency bypasses", () => {
    expect(workspaceConfig.minimumReleaseAge).toBe(1_440);
    expect(workspaceConfig.blockExoticSubdeps).toBe(true);
  });

  it("anchors CLI downloads in the release metadata and verified aggregate manifest", () => {
    expect(installerSource).toContain("api.github.com/repos/$REPO/releases");
    expect(installerSource).toContain('checksums_asset="checksums-$release_version.txt"');
    expect(installerSource).toContain("manifest_digest=$(asset_digest");
    expect(installerSource).not.toContain('"$base/$asset.sha256"');
  });

  it("pins every public curl-pipe-shell bootstrap to an immutable commit", () => {
    const canonicalRevision = /INSTALL_SCRIPT_REVISION\s*=\s*"([a-f0-9]+)"/.exec(
      installScriptModuleSource,
    )?.[1];
    expect(canonicalRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(installScriptModuleSource).toMatch(
      /quibtbot\/\$\{INSTALL_SCRIPT_REVISION\}\/scripts\/install\.sh/,
    );

    for (const file of publicInstallerReferenceFiles) {
      const source = readFileSync(path.resolve(file), "utf8");
      const revisions = [
        ...source.matchAll(
          /raw\.githubusercontent\.com\/CaioJusto\/quibtbot\/([^/"'\\\s]+)\/scripts\/install\.sh/g,
        ),
      ].map((match) => match[1]);
      expect(revisions.length, file).toBeGreaterThan(0);
      for (const revision of revisions) {
        expect(revision, file).toMatch(/^[a-f0-9]{40}$/);
      }
    }

    for (const file of installScriptConsumerFiles) {
      const source = readFileSync(path.resolve(file), "utf8");
      expect(source, file).toContain("INSTALL_SCRIPT_RAW_URL");
      expect(source, file).not.toContain("raw.githubusercontent.com");
    }

    const ci = workflowSources.find(({ name }) => name === "ci.yml")?.source ?? "";
    const release = workflowSources.find(({ name }) => name === "release.yml")?.source ?? "";
    expect(rootPackage.scripts?.["verify:install-pin"]).toBe(
      "node scripts/verify-install-script-pin.mjs",
    );
    expect(ci).toContain("pnpm verify:install-pin");
    expect(release).toContain("pnpm verify:install-pin");
  });
});

describe("workflow supply-chain policy", () => {
  const workflowVersionExpression = "$" + "{{ inputs.version }}";

  it("pins every third-party Action to a full commit SHA", () => {
    for (const { name, source } of workflowSources) {
      const uses = [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
      expect(uses.length, `${name} should contain actions`).toBeGreaterThan(0);
      for (const action of uses) {
        expect(action, `${name}: ${action}`).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
      }
    }
  });

  it("makes every CI/release install audibly frozen and runs audit plus actionlint", () => {
    for (const { name, source } of workflowSources.filter(
      ({ name }) => name !== "publish-images.yml",
    )) {
      expect(source, name).not.toMatch(/- run: pnpm install\s*$/m);
      expect(source, name).toMatch(/pnpm install --frozen-lockfile/);
    }
    const ci = workflowSources.find(({ name }) => name === "ci.yml")?.source ?? "";
    expect(ci).toContain("pnpm audit --audit-level moderate");
    expect(ci).toContain("pnpm lint:actions");
  });

  it("does not interpolate the manual image version into a shell program", () => {
    const source = workflowSources.find(({ name }) => name === "publish-images.yml")?.source ?? "";
    const workflow = parseYaml(source) as {
      jobs?: Record<
        string,
        { steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }> }
      >;
    };
    const merge = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name === "Merge multi-arch manifest");
    expect(merge?.env?.VERSION).toBe(workflowVersionExpression);
    expect(merge?.run).not.toContain(workflowVersionExpression);
    expect(merge?.run).toContain('[[ ! "$VERSION" =~');
  });

  it("publishes image SBOM and provenance and enables automated updates", () => {
    for (const name of ["publish-images.yml", "release.yml"]) {
      const source = workflowSources.find((workflow) => workflow.name === name)?.source ?? "";
      for (const block of source.split(/uses: docker\/build-push-action@/).slice(1)) {
        expect(block, name).toMatch(/provenance:\s*mode=max/);
        expect(block, name).toMatch(/sbom:\s*true/);
      }
      expect(source, name).toContain("imagetools inspect");
      expect(source, name).toContain(".SBOM");
      expect(source, name).toContain(".Provenance");
    }
    expect(dependabotSource).toContain("package-ecosystem: github-actions");
    expect(dependabotSource).toContain("directory: /infra/sandboxes/desktop");
    expect(codeownersSource).toContain("/.github/ @CaioJusto");
    expect(codeownersSource).toContain("/infra/ @CaioJusto");
    expect(codeownersSource).toContain("/pnpm-workspace.yaml @CaioJusto");
  });

  it("pins every non-scratch Docker stage to an immutable manifest digest", () => {
    for (const file of dockerfiles) {
      const fromLines = readFileSync(path.resolve(file), "utf8")
        .split("\n")
        .filter((line) => line.startsWith("FROM "));
      expect(fromLines.length, file).toBeGreaterThan(0);
      for (const line of fromLines) {
        if (/^FROM\s+scratch(?:\s|$)/.test(line)) continue;
        expect(line, `${file}: ${line}`).toMatch(/@sha256:[a-f0-9]{64}(?:\s|$)/);
      }
    }
  });

  it("compiles the generated Android native app and tests E2E through the production server", () => {
    const ci = workflowSources.find(({ name }) => name === "ci.yml")?.source ?? "";
    const playwright = readFileSync(path.resolve("apps/web/playwright.config.ts"), "utf8");
    expect(ci).toContain("expo prebuild --platform android --clean --no-install");
    expect(ci).toContain("./gradlew assembleDebug --stacktrace");
    expect(ci).toContain("NODE_ENV: production");
    expect(ci).toContain('AUTH_EMAIL_DISABLED: "true"');
    expect(ci).toContain("SANDBOX_SUPERVISOR_TOKEN: ci-e2e-supervisor-token-");
    expect(playwright).toContain('command: "pnpm build && pnpm start"');
  });
});
