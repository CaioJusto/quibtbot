import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_RELEASE } from "@quibt/installer";
import { describe, expect, it } from "vitest";
import {
  assertReleaseManifestReady,
  loadEmbeddedReleaseManifest,
  PLACEHOLDER_DIGEST,
  parseReleaseManifest,
  releaseManifestFixture,
  toVerifiedReleaseArtifacts,
} from "./release-manifest.js";

const assetsManifest = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "release-manifest.json",
);

describe("embedded release manifest", () => {
  it("parses schema version, release, digests, and pipeline status", () => {
    const manifest = parseReleaseManifest(releaseManifestFixture());
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.release).toBe(INSTALL_RELEASE);
    expect(manifest.digests["quibtbot-linux-x64"]).toHaveLength(64);
    expect(manifest.pipelineStatus).toBe("ready");
  });

  it("fails closed when pipeline status is pending or digests are placeholders", () => {
    expect(() =>
      assertReleaseManifestReady(
        releaseManifestFixture({
          pipelineStatus: "pending",
          digests: {
            "quibtbot-linux-x64": PLACEHOLDER_DIGEST,
            "quibtbot-linux-arm64": PLACEHOLDER_DIGEST,
          },
        }),
      ),
    ).toThrow(/not ready/i);
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

  it("allows pending manifests only when explicitly opted in for dev", () => {
    const pending = releaseManifestFixture({
      pipelineStatus: "pending",
      digests: {
        "quibtbot-linux-x64": PLACEHOLDER_DIGEST,
        "quibtbot-linux-arm64": PLACEHOLDER_DIGEST,
      },
    });
    expect(() => assertReleaseManifestReady(pending, { allowPending: true })).not.toThrow();
  });

  it("maps manifest digests into verified release artifacts", () => {
    const verified = toVerifiedReleaseArtifacts(releaseManifestFixture());
    expect(verified.release).toBe(INSTALL_RELEASE);
    expect(verified.digests["quibtbot-linux-arm64"]).toHaveLength(64);
  });

  it("loads the repository assets manifest fixture", () => {
    const manifest = loadEmbeddedReleaseManifest(assetsManifest);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.release).toBe(INSTALL_RELEASE);
    expect(manifest.pipelineStatus).toBe("ready");
    expect(() => assertReleaseManifestReady(manifest)).not.toThrow();
  });
});
