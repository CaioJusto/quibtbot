import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INSTALL_RELEASE } from "@quibt/installer";
import { describe, expect, it } from "vitest";
import {
  buildReleaseManifest,
  computeFileSha256,
  isHttpsReleaseBaseUrl,
  loadEmbeddedReleaseManifest,
  parseReleaseManifest,
  remoteInstallAvailability,
  writeReleaseManifestAtomic,
} from "./release-manifest.js";

describe("generate release manifest", () => {
  it("requires HTTPS base URLs and exact INSTALL_RELEASE", () => {
    expect(isHttpsReleaseBaseUrl("https://example.com/releases/v0.2.0")).toBe(true);
    expect(isHttpsReleaseBaseUrl("http://example.com/releases/v0.2.0")).toBe(false);
    const dir = mkdtempSync(path.join(tmpdir(), "quibt-manifest-"));
    const x64 = path.join(dir, "quibtbot-linux-x64");
    const arm64 = path.join(dir, "quibtbot-linux-arm64");
    writeFileSync(x64, "x64-binary");
    writeFileSync(arm64, "arm64-binary");
    expect(() =>
      buildReleaseManifest({
        release: "9.9.9",
        baseUrl: "https://example.com/releases/v9.9.9",
        binaries: {
          "quibtbot-linux-x64": x64,
          "quibtbot-linux-arm64": arm64,
        },
      }),
    ).toThrow(/does not match embedded installer release/i);
  });

  it("hashes CLI binaries and writes a ready manifest atomically", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quibt-manifest-ready-"));
    const x64 = path.join(dir, "quibtbot-linux-x64");
    const arm64 = path.join(dir, "quibtbot-linux-arm64");
    writeFileSync(x64, "x64-binary");
    writeFileSync(arm64, "arm64-binary");
    const manifest = buildReleaseManifest({
      release: INSTALL_RELEASE,
      baseUrl: "https://example.com/releases/v0.2.0",
      binaries: {
        "quibtbot-linux-x64": x64,
        "quibtbot-linux-arm64": arm64,
      },
    });
    expect(manifest.pipelineStatus).toBe("ready");
    expect(manifest.digests["quibtbot-linux-x64"]).toBe(computeFileSha256(x64));

    const out = path.join(dir, "release-manifest.json");
    writeReleaseManifestAtomic(out, manifest);
    const loaded = loadEmbeddedReleaseManifest(out);
    expect(loaded.pipelineStatus).toBe("ready");
    expect(JSON.parse(readFileSync(out, "utf8")).pipelineStatus).toBe("ready");
  });

  it("blocks remote install when the embedded manifest is pending", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quibt-manifest-pending-"));
    const pendingPath = path.join(dir, "release-manifest.json");
    writeReleaseManifestAtomic(
      pendingPath,
      parseReleaseManifest({
        schemaVersion: 1,
        release: INSTALL_RELEASE,
        baseUrl: "https://example.com/releases/v0.2.0",
        digests: {
          "quibtbot-linux-x64": "0".repeat(64),
          "quibtbot-linux-arm64": "0".repeat(64),
        },
        pipelineStatus: "pending",
      }),
    );
    const blocked = remoteInstallAvailability({ manifestPath: pendingPath });
    expect(blocked.available).toBe(false);
    expect(blocked.message).toMatch(/not ready|not populated/i);
  });
});
