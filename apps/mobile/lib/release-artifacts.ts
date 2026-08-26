import embeddedManifest from "../assets/release-manifest.json";

/**
 * Valor local de propósito: `@quibt/installer` é um pacote Node (child_process, fs) e o
 * Metro não consegue empacotá-lo para o celular — importar dali quebrava o build do
 * iOS. O teste ao lado confere que este número bate com o do installer.
 */
export const INSTALL_RELEASE = "0.2.12";
export const PLACEHOLDER_DIGEST = "0".repeat(64);
export const LINUX_ARTIFACTS = ["quibtbot-linux-x64", "quibtbot-linux-arm64"] as const;

export interface EmbeddedReleaseManifest {
  schemaVersion: 1;
  release: string;
  baseUrl: string;
  digests: Record<(typeof LINUX_ARTIFACTS)[number], string>;
  pipelineStatus: "pending" | "ready";
}

export interface VerifiedReleaseArtifacts {
  release: string;
  baseUrl: string;
  digests: Record<string, string>;
}

/**
 * Os digests vêm de `apps/mobile/assets/release-manifest.json`, escrito pelo pipeline de
 * release a partir dos binários que ele acabou de publicar — o mesmo arquivo que o app do
 * computador usa. Antes eles eram zeros escritos aqui à mão e ninguém os preenchia nunca:
 * a instalação por SSH morria em "Release manifest is not ready for remote install", depois
 * de já ter conectado no servidor.
 */
const EMBEDDED_MANIFEST = embeddedManifest as EmbeddedReleaseManifest;

export function isPlaceholderDigest(digest: string): boolean {
  return digest === PLACEHOLDER_DIGEST || /^0+$/i.test(digest);
}

export function assertReleaseManifestReady(manifest: EmbeddedReleaseManifest): void {
  if (manifest.release !== INSTALL_RELEASE) {
    throw new Error(
      `Release manifest release ${manifest.release} does not match installer release ${INSTALL_RELEASE}.`,
    );
  }
  if (manifest.pipelineStatus !== "ready") {
    throw new Error("Release manifest is not ready for remote install.");
  }
  for (const artifact of LINUX_ARTIFACTS) {
    const digest = manifest.digests[artifact];
    if (isPlaceholderDigest(digest)) {
      throw new Error(`Release manifest digest for ${artifact} is not populated.`);
    }
  }
}

export function resolveEmbeddedReleaseArtifacts(
  manifest: EmbeddedReleaseManifest = EMBEDDED_MANIFEST,
): VerifiedReleaseArtifacts {
  assertReleaseManifestReady(manifest);
  return {
    release: manifest.release,
    baseUrl: manifest.baseUrl,
    digests: { ...manifest.digests },
  };
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

export function buildRemoteBootstrapShell(input: VerifiedReleaseArtifacts): string {
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

export function releaseManifestFixture(
  overrides: Partial<EmbeddedReleaseManifest> = {},
): EmbeddedReleaseManifest {
  return {
    schemaVersion: 1,
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
