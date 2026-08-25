const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseStrictSemver(input: string): string | null {
  if (input.includes("\n") || input.includes("\r")) return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed !== input) return null;
  if (!SEMVER_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function assertSupportedRelease(
  release: string,
  supported: readonly string[],
): { ok: true; release: string } | { ok: false; message: string } {
  const parsed = parseStrictSemver(release);
  if (!parsed) {
    return { ok: false, message: "Release must be a strict semver without newlines." };
  }
  if (!supported.includes(parsed)) {
    return {
      ok: false,
      message: `Release ${parsed} is not supported by this installer manifest.`,
    };
  }
  return { ok: true, release: parsed };
}
