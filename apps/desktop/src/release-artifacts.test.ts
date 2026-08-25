import { INSTALL_RELEASE } from "@quibt/installer";
import { describe, expect, it } from "vitest";
import {
  buildRemoteBootstrapShell,
  encodeBootstrapScript,
  guidedVpsBootstrapCommand,
  releaseManifestFixture,
  resolveEmbeddedReleaseArtifacts,
  selectLinuxArtifact,
} from "./release-artifacts.js";
import { assertReleaseManifestReady, PLACEHOLDER_DIGEST } from "./release-manifest.js";

describe("embedded release bootstrap", () => {
  it("maps machine types to release artifact names", () => {
    expect(selectLinuxArtifact("x86_64")).toBe("quibtbot-linux-x64");
    expect(selectLinuxArtifact("aarch64")).toBe("quibtbot-linux-arm64");
    expect(selectLinuxArtifact("riscv64")).toBeNull();
  });

  it("resolves embedded digests for both linux artifacts", () => {
    const verified = resolveEmbeddedReleaseArtifacts(releaseManifestFixture());
    expect(verified.digests["quibtbot-linux-x64"]).toHaveLength(64);
    expect(verified.digests["quibtbot-linux-arm64"]).toHaveLength(64);
    expect(verified.release).toBe(INSTALL_RELEASE);
  });

  it("builds a remote shell that compares explicit digests and checks version exactly", () => {
    const script = buildRemoteBootstrapShell({
      baseUrl: "https://example/releases/v0.2.0",
      release: INSTALL_RELEASE,
      digests: {
        "quibtbot-linux-x64": "a".repeat(64),
        "quibtbot-linux-arm64": "b".repeat(64),
      },
    });
    expect(script).not.toContain("sha256sum -c");
    expect(script).toContain('if [ "$ACTUAL" != "$EXPECTED" ]');
    expect(script).toContain('" --version');
    expect(script).toContain('if [ "$VERSION" != "$RELEASE" ]');
    expect(script).toContain("tr -d");
  });

  it("fails closed for pending or placeholder manifests", () => {
    expect(() =>
      resolveEmbeddedReleaseArtifacts(
        releaseManifestFixture({
          pipelineStatus: "pending",
          digests: {
            "quibtbot-linux-x64": PLACEHOLDER_DIGEST,
            "quibtbot-linux-arm64": PLACEHOLDER_DIGEST,
          },
        }),
      ),
    ).toThrow(/not ready|not populated/i);
    expect(() =>
      assertReleaseManifestReady(
        releaseManifestFixture({
          digests: {
            "quibtbot-linux-x64": PLACEHOLDER_DIGEST,
            "quibtbot-linux-arm64":
              "2222222222222222222222222222222222222222222222222222222222222222",
          },
        }),
      ),
    ).toThrow(/not populated/i);
  });

  it("uses base64 piping instead of JSON shell quoting for guided bootstrap", () => {
    const command = guidedVpsBootstrapCommand(releaseManifestFixture());
    expect(command).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d \| bash -s$/);
    expect(command).not.toContain("bash -lc");
    expect(command).not.toContain(JSON.stringify("set -euo pipefail"));
    const encoded = command.split(" ")[1];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toContain(
      'if [ "$ACTUAL" != "$EXPECTED" ]',
    );
  });

  it("round-trips bootstrap scripts through base64", () => {
    const script = buildRemoteBootstrapShell(
      resolveEmbeddedReleaseArtifacts(releaseManifestFixture()),
    );
    expect(Buffer.from(encodeBootstrapScript(script), "base64").toString("utf8")).toBe(script);
  });
});
