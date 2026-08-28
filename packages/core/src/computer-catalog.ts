import { OSS_MACHINE_COPY, OSS_MACHINES, type OssMachine, parseOssMachine } from "./edition.js";

export const MACHINE_CATEGORIES = ["local", "remote", "cloud", "vps"] as const;
export type MachineCategory = (typeof MACHINE_CATEGORIES)[number];

export interface VpsRecipe {
  provider: string;
  hint: string;
  docsUrl?: string;
  installScript: string;
}

export interface MachineCatalogDefinition {
  kind: string;
  family: OssMachine | "remote-supervisor";
  title: string;
  body: string;
  category: MachineCategory;
  needsKey: boolean;
  needsEndpoint: boolean;
  needsDocker: boolean;
  keyLabel?: string;
  endpointLabel?: string;
  searchable: string[];
  /** Recipe-only entries activate as `remote-supervisor` after the host is up. */
  activatesAs?: OssMachine;
  recipe?: VpsRecipe;
}

const GENERIC_VPS_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
# Bring-your-own VPS: use the versioned Quibt installer. It verifies the
# architecture-specific binary checksum and installs Docker through the distro path.
curl -fsSL https://raw.githubusercontent.com/CaioJusto/quibtbot/v0.2.14/scripts/install.sh \
  | QUIBT_RELEASE=0.2.14 sh
`;

export const MACHINE_CATALOG: MachineCatalogDefinition[] = [
  {
    kind: "docker",
    family: "docker",
    title: OSS_MACHINE_COPY.docker.title,
    body: OSS_MACHINE_COPY.docker.body,
    category: "local",
    needsKey: false,
    needsEndpoint: false,
    needsDocker: true,
    searchable: ["docker", "local", "nesta máquina", "linux", "container"],
  },
  {
    kind: "remote-supervisor",
    family: "remote-supervisor",
    title: OSS_MACHINE_COPY["remote-supervisor"].title,
    body: OSS_MACHINE_COPY["remote-supervisor"].body,
    category: "remote",
    needsKey: true,
    needsEndpoint: true,
    needsDocker: false,
    keyLabel: "Token do supervisor",
    endpointLabel: "URL https do supervisor (o outro host precisa do profile supervisor-tls)",
    searchable: ["vps", "supervisor", "remoto", "self-host", "ssh", "servidor"],
  },
  {
    kind: "e2b",
    family: "e2b",
    title: OSS_MACHINE_COPY.e2b.title,
    body: OSS_MACHINE_COPY.e2b.body,
    category: "cloud",
    needsKey: true,
    needsEndpoint: false,
    needsDocker: false,
    keyLabel: "E2B_API_KEY",
    searchable: ["e2b", "sandbox", "nuvem", "cloud"],
  },
  {
    kind: "box",
    family: "box",
    title: OSS_MACHINE_COPY.box.title,
    body: OSS_MACHINE_COPY.box.body,
    category: "cloud",
    needsKey: true,
    needsEndpoint: false,
    needsDocker: false,
    keyLabel: "BOX_API_KEY",
    searchable: ["box", "ascii", "vm", "ubuntu", "nuvem"],
  },
  {
    kind: "vps-hetzner",
    family: "remote-supervisor",
    title: "Hetzner (receita)",
    body: "Crie um CX22 com o token da sua conta Hetzner, ou rode o script na VM. Quibt não cobra a máquina.",
    category: "vps",
    needsKey: true,
    needsEndpoint: true,
    needsDocker: false,
    keyLabel: "Token do supervisor",
    endpointLabel: "URL do supervisor depois que a VM subir",
    activatesAs: "remote-supervisor",
    searchable: ["hetzner", "vps", "cx22", "cloud", "alemanha", "mercado"],
    recipe: {
      provider: "hetzner",
      hint: "Crie um CX22 (Ubuntu 24.04), cole o script no cloud-init ou rode por SSH, depois volte com a URL do supervisor.",
      docsUrl: "https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server",
      installScript: GENERIC_VPS_SCRIPT,
    },
  },
  {
    kind: "vps-digitalocean",
    family: "remote-supervisor",
    title: "DigitalOcean (receita)",
    body: "Droplet Ubuntu com Docker + Compose. Use o token da sua conta DigitalOcean — a Quibt não revende VPS.",
    category: "vps",
    needsKey: true,
    needsEndpoint: true,
    needsDocker: false,
    keyLabel: "Token do supervisor",
    endpointLabel: "URL do supervisor depois que o Droplet subir",
    activatesAs: "remote-supervisor",
    searchable: ["digitalocean", "droplet", "vps", "do", "mercado"],
    recipe: {
      provider: "digitalocean",
      hint: "Crie um Droplet Ubuntu 24.04 (2 GB+), rode o script, depois cole a URL do supervisor aqui.",
      docsUrl: "https://docs.digitalocean.com/products/droplets/how-to/create/",
      installScript: GENERIC_VPS_SCRIPT,
    },
  },
  {
    kind: "vps-generic",
    family: "remote-supervisor",
    title: "Qualquer VPS (script)",
    body: "Ubuntu com Docker. O script instala o stack; você cola a URL do supervisor quando ele responder.",
    category: "vps",
    needsKey: true,
    needsEndpoint: true,
    needsDocker: false,
    keyLabel: "Token do supervisor",
    endpointLabel: "URL do supervisor",
    activatesAs: "remote-supervisor",
    searchable: ["vps", "ubuntu", "script", "cloud-init", "oracle", "linode", "vultr"],
    recipe: {
      provider: "generic",
      hint: "Qualquer Ubuntu 22.04/24.04 com IP público. Com 80/443 livres o instalador liga HTTPS sozinho (nome sslip.io + Let's Encrypt, sem domínio). Mantenha o supervisor só na rede interna ou com token.",
      installScript: GENERIC_VPS_SCRIPT,
    },
  },
];

export function catalogDefinition(kind: string): MachineCatalogDefinition | undefined {
  const raw = kind.trim().toLowerCase();
  return MACHINE_CATALOG.find((entry) => entry.kind === raw);
}

export function bootableKind(kind: string): OssMachine | null {
  const entry = catalogDefinition(kind);
  if (entry?.activatesAs) return entry.activatesAs;
  return parseOssMachine(kind);
}

export function listPickableMachines(): OssMachine[] {
  return [...OSS_MACHINES];
}

/** The four choices the onboarding screen leads with. Recipes stay under VPS. */
export function isPrimaryMachine(kind: string): boolean {
  return OSS_MACHINES.includes(kind as OssMachine);
}

export function searchMachineCatalog(query: string): MachineCatalogDefinition[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return MACHINE_CATALOG;
  return MACHINE_CATALOG.filter((entry) => {
    const hay = [entry.kind, entry.title, entry.body, ...entry.searchable].join(" ").toLowerCase();
    return hay.includes(needle);
  });
}

export interface CatalogReadiness {
  e2bApiKey?: string;
  boxApiKey?: string;
  remoteSupervisorUrl?: string;
  remoteSupervisorToken?: string;
  dockerReady?: boolean;
}

export function machineIsReady(kind: string, readiness: CatalogReadiness): boolean {
  const boot = bootableKind(kind);
  if (boot === "docker") return readiness.dockerReady !== false;
  if (boot === "remote-supervisor") {
    return Boolean(readiness.remoteSupervisorUrl && readiness.remoteSupervisorToken);
  }
  if (boot === "e2b") return Boolean(readiness.e2bApiKey);
  if (boot === "box") return Boolean(readiness.boxApiKey);
  return false;
}

export function filterCatalog(query: string, readiness: CatalogReadiness) {
  return searchMachineCatalog(query).map((entry) => ({
    ...entry,
    ready: machineIsReady(entry.kind, readiness),
    configured: machineIsReady(entry.activatesAs ?? entry.kind, readiness),
  }));
}
