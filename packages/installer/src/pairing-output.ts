export function canRevealPairingSecrets(options: {
  isTty?: boolean;
  showSensitive?: boolean;
}): boolean {
  const isTty = options.isTty ?? Boolean(process.stdout.isTTY);
  return Boolean(options.showSensitive || isTty);
}

export const PAIRING_OUTPUT_REFUSED_MESSAGE =
  "Pairing secrets were not printed because stdout is not an interactive terminal. Re-run with --show-sensitive to opt in.";
