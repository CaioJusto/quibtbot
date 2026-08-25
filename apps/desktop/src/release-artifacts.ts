import { INSTALL_RELEASE } from "@quibt/installer";
import {
  assertReleaseManifestReady,
  type EmbeddedReleaseManifest,
  loadEmbeddedReleaseManifest,
  releaseManifestFixture,
  toVerifiedReleaseArtifacts,
  type VerifiedReleaseArtifacts,
} from "./release-manifest.js";

export type { EmbeddedReleaseManifest, VerifiedReleaseArtifacts };

export function releaseDownloadBase(release = INSTALL_RELEASE): string {
  return `https://github.com/CaioJusto/quibtbot/releases/download/v${release}`;
}

export function selectLinuxArtifact(unameMachine: string): string | null {
  switch (unameMachine.trim()) {
    case "x86_64":
    case "amd64":
      return "quibtbot-linux-x64";
    case "aarch64":
    case "arm64":
      return "quibtbot-linux-arm64";
    default:
      return null;
  }
}

export function resolveEmbeddedReleaseArtifacts(
  manifest?: EmbeddedReleaseManifest,
  options?: { allowPending?: boolean },
): VerifiedReleaseArtifacts {
  const resolved = manifest ?? loadEmbeddedReleaseManifest();
  assertReleaseManifestReady(resolved, options);
  return toVerifiedReleaseArtifacts(resolved);
}

export function buildRemoteBootstrapShell(input: {
  baseUrl: string;
  release: string;
  digests: Record<string, string>;
}): string {
  const digestX64 = input.digests["quibtbot-linux-x64"] ?? "";
  const digestArm64 = input.digests["quibtbot-linux-arm64"] ?? "";
  return `set -euo pipefail
BASE="${input.baseUrl}"
RELEASE="${input.release}"
DIGEST_X64="${digestX64}"
DIGEST_ARM64="${digestArm64}"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARTIFACT="quibtbot-linux-x64"; EXPECTED="$DIGEST_X64" ;;
  aarch64|arm64) ARTIFACT="quibtbot-linux-arm64"; EXPECTED="$DIGEST_ARM64" ;;
  *) echo "unsupported architecture: $ARCH"; exit 1 ;;
esac
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
curl -fsSL "$BASE/$ARTIFACT" -o "$tmpdir/quibtbot"
ACTUAL=$(sha256sum "$tmpdir/quibtbot" | awk '{print $1}')
if [ "$ACTUAL" != "$EXPECTED" ]; then echo "checksum mismatch for $ARTIFACT"; exit 1; fi
chmod +x "$tmpdir/quibtbot"
VERSION=$("$tmpdir/quibtbot" --version 2>/dev/null | tr -d '\\r\\n')
if [ "$VERSION" != "$RELEASE" ]; then echo "unexpected quibtbot version: $VERSION"; exit 1; fi
"$tmpdir/quibtbot" install --non-interactive --show-sensitive
`;
}

export function encodeBootstrapScript(script: string): string {
  return Buffer.from(script, "utf8").toString("base64");
}

export function guidedVpsBootstrapCommand(manifest?: EmbeddedReleaseManifest): string {
  const verified = resolveEmbeddedReleaseArtifacts(manifest);
  const script = buildRemoteBootstrapShell(verified);
  const encoded = encodeBootstrapScript(script);
  return `echo ${encoded} | base64 -d | bash -s`;
}

export { releaseManifestFixture };
