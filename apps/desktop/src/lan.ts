import { networkInterfaces } from "node:os";

type Entry = { family: string; address: string; internal: boolean };

/** Faixa CGNAT do Tailscale: 100.64.0.0/10. */
function isTailnet(address: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);
}

/**
 * A bridge do Docker aparece como interface comum no Linux, mas nenhum celular
 * alcança esse endereço — um QR apontando para lá nunca conecta.
 */
function isDockerBridge(name: string): boolean {
  return /^(docker|br-|veth)/.test(name);
}

/**
 * O endereço que o QR de "Conectar o celular" carrega. O do tailnet vem primeiro
 * porque é o único que continua valendo quando o celular sai do wi-fi de casa —
 * e porque o IP da LAN muda sozinho ao trocar de rede, o que deixa o QR velho.
 */
export function firstLanIPv4(
  interfaces: NodeJS.Dict<Array<Entry>> = networkInterfaces(),
): string | null {
  const candidates: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (isDockerBridge(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== "4") continue;
      if (entry.address.startsWith("169.254.")) continue;
      candidates.push(entry.address);
    }
  }
  // Ordinary Wi-Fi HTTP exposes the reusable mobile session to the local network. A tailnet
  // address is still HTTP at the app layer, but WireGuard authenticates and encrypts it.
  return candidates.find(isTailnet) ?? null;
}

export function lanApiUrl(port = 3100): string | null {
  const ip = firstLanIPv4();
  return ip ? `http://${ip}:${port}` : null;
}
