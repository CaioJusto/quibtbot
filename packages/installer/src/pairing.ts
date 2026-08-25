import { bootstrapDeepLink, qrSvg } from "@quibt/core";

export interface SensitivePairingOutput {
  url: string;
  code: string;
  token: string;
  expiresAt: string;
  deepLink: string;
  qrSvg: string;
}

export function buildPairingOutput(
  publicUrl: string,
  apiBase: string,
  minted: { code: string; token: string; expiresAt: string },
): SensitivePairingOutput {
  const deepLink = bootstrapDeepLink(apiBase, minted.token);
  return {
    url: publicUrl,
    code: minted.code,
    token: minted.token,
    expiresAt: minted.expiresAt,
    deepLink,
    qrSvg: qrSvg(deepLink),
  };
}

export function pairingContainsSensitiveData(
  pairing: SensitivePairingOutput,
  serialized: string,
): boolean {
  return (
    serialized.includes(pairing.token) ||
    serialized.includes(pairing.code) ||
    serialized.includes(pairing.deepLink)
  );
}
