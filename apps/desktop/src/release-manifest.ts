import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INSTALL_RELEASE } from "@quibt/installer";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const RELEASE_MANIFEST_FILENAME = "release-manifest.json";
export const PLACEHOLDER_DIGEST = "0".repeat(64);
export const LINUX_ARTIFACTS = ["quibtbot-linux-x64", "quibtbot-linux-arm64"] as const;

export type LinuxArtifactName = (typeof LINUX_ARTIFACTS)[number];

export interface EmbeddedReleaseManifest {
  schemaVersion: number;
  release: string;
  baseUrl: string;
  digests: Record<LinuxArtifactName, string>;
  pipelineStatus: "pending" | "ready";
}

export interface VerifiedReleaseArtifacts {
  release: string;
  baseUrl: string;
  digests: Record<string, string>;
}

function isHexDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function parseReleaseManifest(raw: unknown): EmbeddedReleaseManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("Release manifest is missing or invalid.");
  }
  const manifest = raw as Record<string, unknown>;
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Release manifest schema version is unsupported.");
  }
  if (typeof manifest.release !== "string" || !manifest.release.trim()) {
    throw new Error("Release manifest release is invalid.");
  }
  if (typeof manifest.baseUrl !== "string" || !manifest.baseUrl.trim()) {
    throw new Error("Release manifest baseUrl is invalid.");
  }
  if (manifest.pipelineStatus !== "pending" && manifest.pipelineStatus !== "ready") {
    throw new Error("Release manifest pipelineStatus is invalid.");
  }
  const digestsRaw = manifest.digests;
  if (!digestsRaw || typeof digestsRaw !== "object") {
    throw new Error("Release manifest digests are invalid.");
  }
  const digests = {} as Record<LinuxArtifactName, string>;
  for (const artifact of LINUX_ARTIFACTS) {
    const digest = (digestsRaw as Record<string, unknown>)[artifact];
    if (typeof digest !== "string" || !isHexDigest(digest)) {
      throw new Error(`Release manifest is missing ${artifact}.`);
    }
    digests[artifact] = digest.toLowerCase();
  }
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    release: manifest.release.trim(),
    baseUrl: manifest.baseUrl.replace(/\/+$/, ""),
    digests,
    pipelineStatus: manifest.pipelineStatus,
  };
}

export function isHttpsReleaseBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function computeFileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").toLowerCase();
}

export interface GenerateReleaseManifestInput {
  release: string;
  baseUrl: string;
  binaries: Record<LinuxArtifactName, string>;
}

export function buildReleaseManifest(input: GenerateReleaseManifestInput): EmbeddedReleaseManifest {
  if (input.release !== INSTALL_RELEASE) {
    throw new Error(
      `Release ${input.release} does not match embedded installer release ${INSTALL_RELEASE}.`,
    );
  }
  if (!isHttpsReleaseBaseUrl(input.baseUrl)) {
    throw new Error("Release baseUrl must use HTTPS.");
  }
  const digests = {} as Record<LinuxArtifactName, string>;
  for (const artifact of LINUX_ARTIFACTS) {
    const binaryPath = input.binaries[artifact];
    if (!binaryPath || !existsSync(binaryPath)) {
      throw new Error(`Missing CLI binary for ${artifact}: ${binaryPath ?? "(unset)"}`);
    }
    digests[artifact] = computeFileSha256(binaryPath);
  }
  return parseReleaseManifest({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    release: input.release,
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    digests,
    pipelineStatus: "ready",
  });
}

export function writeReleaseManifestAtomic(
  manifestPath: string,
  manifest: EmbeddedReleaseManifest,
): void {
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tempPath, manifestPath);
}

export function remoteInstallAvailability(options?: {
  allowPending?: boolean;
  manifestPath?: string;
}): { available: true; manifest: EmbeddedReleaseManifest } | { available: false; message: string } {
  try {
    const manifest = loadEmbeddedReleaseManifest(options?.manifestPath);
    assertReleaseManifestReady(manifest, { allowPending: options?.allowPending });
    return { available: true, manifest };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Remote install is unavailable in this build.";
    return { available: false, message };
  }
}

export function isPlaceholderDigest(digest: string): boolean {
  return digest === PLACEHOLDER_DIGEST || /^0+$/.test(digest);
}

export function assertReleaseManifestReady(
  manifest: EmbeddedReleaseManifest,
  options?: { allowPending?: boolean },
): void {
  if (manifest.release !== INSTALL_RELEASE) {
    throw new Error(
      `Release manifest release ${manifest.release} does not match installer release ${INSTALL_RELEASE}.`,
    );
  }
  if (!options?.allowPending && manifest.pipelineStatus !== "ready") {
    throw new Error("Release manifest is not ready for remote install.");
  }
  for (const artifact of LINUX_ARTIFACTS) {
    const digest = manifest.digests[artifact];
    if (!options?.allowPending && isPlaceholderDigest(digest)) {
      throw new Error(`Release manifest digest for ${artifact} is not populated.`);
    }
  }
}

export function defaultManifestPath(): string {
  const bundled = path.join(import.meta.dirname, RELEASE_MANIFEST_FILENAME);
  if (existsSync(bundled)) return bundled;
  return path.join(import.meta.dirname, "..", "assets", RELEASE_MANIFEST_FILENAME);
}

export function loadEmbeddedReleaseManifest(manifestPath?: string): EmbeddedReleaseManifest {
  const resolved = manifestPath ?? defaultManifestPath();
  if (!existsSync(resolved)) {
    throw new Error("Embedded release manifest is unavailable.");
  }
  return parseReleaseManifest(JSON.parse(readFileSync(resolved, "utf8")));
}

export function toVerifiedReleaseArtifacts(
  manifest: EmbeddedReleaseManifest,
): VerifiedReleaseArtifacts {
  return {
    release: manifest.release,
    baseUrl: manifest.baseUrl,
    digests: { ...manifest.digests },
  };
}

export function releaseManifestFixture(
  overrides: Partial<EmbeddedReleaseManifest> = {},
): EmbeddedReleaseManifest {
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    release: INSTALL_RELEASE,
    baseUrl: "https://example/releases/v0.2.0",
    digests: {
      "quibtbot-linux-x64": "1111111111111111111111111111111111111111111111111111111111111111",
      "quibtbot-linux-arm64": "2222222222222222222222222222222222222222222222222222222222222222",
    },
    pipelineStatus: "ready",
    ...overrides,
  };
}
