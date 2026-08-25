const REDACTED = "[REDACTED]";

const SENSITIVE_ASSIGNMENT_SUFFIXES = [
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PRIVATE_KEY",
  "API_KEY",
  "PASSPHRASE",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactExactSecrets(text: string, secrets: string[]): string {
  return secrets.reduce((acc, secret) => {
    if (!secret) return acc;
    return acc.replaceAll(secret, REDACTED);
  }, text);
}

function redactAllSensitiveAssignments(text: string): string {
  const suffixPattern = SENSITIVE_ASSIGNMENT_SUFFIXES.map(escapeRegExp).join("|");
  const assignmentPattern = new RegExp(`^([A-Z0-9_]*(?:${suffixPattern}))=(.+)$`, "gm");
  return text.replace(assignmentPattern, (_match, key: string) => `${key}=${REDACTED}`);
}

function redactKnownSensitiveAssignments(text: string, secrets: string[]): string {
  const secretSet = new Set(secrets.filter(Boolean));
  if (secretSet.size === 0) return text;

  const suffixPattern = SENSITIVE_ASSIGNMENT_SUFFIXES.map(escapeRegExp).join("|");
  const assignmentPattern = new RegExp(`^([A-Z0-9_]*(?:${suffixPattern}))=(.+)$`, "gm");

  return text.replace(assignmentPattern, (match, key: string, value: string) => {
    if (!secretSet.has(value)) return match;
    return `${key}=${REDACTED}`;
  });
}

export function redactInstallerText(text: string, secrets: string[] = []): string {
  return redactAllSensitiveAssignments(
    redactKnownSensitiveAssignments(redactExactSecrets(text, secrets), secrets),
  );
}
