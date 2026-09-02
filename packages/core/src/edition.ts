export const QUIBT_EDITIONS = ["oss", "cloud"] as const;
export type QuibtEdition = (typeof QUIBT_EDITIONS)[number];

export const OSS_MACHINES = ["docker", "remote-supervisor", "e2b", "box", "daytona"] as const;
export type OssMachine = (typeof OSS_MACHINES)[number];

export function resolveEdition(input: {
  edition?: string | undefined;
  billingEnabled: boolean;
}): QuibtEdition {
  const raw = (input.edition ?? "").trim().toLowerCase();
  if (raw === "cloud") return "cloud";
  if (raw === "oss" || raw === "open-source" || raw === "opensource") return "oss";
  return input.billingEnabled ? "cloud" : "oss";
}

/** Cloud is the paid hosted product. OSS is unlimited self-host. They cannot mix. */
export function assertEditionConfig(edition: QuibtEdition, billingEnabled: boolean): void {
  if (edition === "cloud" && !billingEnabled) {
    throw new Error("QUIBT_EDITION=cloud requires BILLING_ENABLED=true and Stripe settings.");
  }
  if (edition === "oss" && billingEnabled) {
    throw new Error("QUIBT_EDITION=oss cannot run with BILLING_ENABLED=true.");
  }
}

/**
 * Machines that isolate one tenant from another. Docker is deliberately absent: the supervisor
 * holds the host Docker socket and every workspace shares that kernel, which the docs call a
 * "trusted single machine" setup. Cloud is the opposite of that by definition.
 */
const CLOUD_MACHINES = ["e2b", "box", "daytona"] as const;
/** Emulators never talk to a real tenant, so they stay legal outside production. */
const EMULATED_MACHINES = ["e2b-emulator", "box-emulator", "daytona-emulator", "fake"] as const;

/** Loud opt-out for someone who hosts "cloud" only for themselves on one box. */
export function allowsSharedDocker(source: {
  QUIBT_ALLOW_SHARED_DOCKER?: string | undefined;
}): boolean {
  const raw = (source.QUIBT_ALLOW_SHARED_DOCKER ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1";
}

/**
 * Cloud is a public multi-tenant deploy, and `SANDBOX_PROVIDER` defaults to docker, so without
 * this check the paid product boots silently in the configuration the docs call unsafe for
 * multi-user hosting. Fails at boot instead.
 */
export function assertEditionMachine(input: {
  edition: QuibtEdition;
  sandboxProvider: string;
  nodeEnv?: string | undefined;
  allowSharedDocker?: boolean;
}): void {
  if (input.edition !== "cloud") return;
  const machine = (input.sandboxProvider ?? "").trim().toLowerCase();
  if ((CLOUD_MACHINES as readonly string[]).includes(machine)) return;
  if (input.allowSharedDocker && (machine === "docker" || machine === "remote-supervisor")) return;
  if ((input.nodeEnv ?? "development") !== "production") {
    if ((EMULATED_MACHINES as readonly string[]).includes(machine)) return;
  }
  throw new Error(
    `QUIBT_EDITION=cloud cannot run on SANDBOX_PROVIDER="${machine || "docker"}": every workspace would share one host kernel. Use ${CLOUD_MACHINES.join(" or ")}, or set QUIBT_ALLOW_SHARED_DOCKER=true if this deploy is single-tenant.`,
  );
}

export interface EditionGate {
  edition: QuibtEdition;
  billingEnabled: boolean;
  /** Only the unpaid self-host edition lets a human pick the machine. */
  canChooseMachine: boolean;
}

/**
 * One place decides what edition a process is serving. Callers used to spell this out inline and
 * disagreed: `edition ?? "oss"` handed the machine picker to a Cloud deploy whose QUIBT_EDITION
 * was simply unset. Missing information now resolves through billing and, when even that is
 * unknown, closes the gate instead of opening it.
 */
export function editionGate(input: {
  edition?: string | undefined;
  billingEnabled?: boolean | undefined;
}): EditionGate {
  const billingEnabled = input.billingEnabled === true;
  const edition = resolveEdition({ edition: input.edition, billingEnabled });
  return { edition, billingEnabled, canChooseMachine: edition === "oss" && !billingEnabled };
}

export function parseOssMachine(value: string | undefined): OssMachine | null {
  const raw = (value ?? "").trim().toLowerCase();
  return OSS_MACHINES.includes(raw as OssMachine) ? (raw as OssMachine) : null;
}

export function availableOssMachines(input: {
  e2bApiKey?: string;
  boxApiKey?: string;
  daytonaApiKey?: string;
  remoteSupervisorUrl?: string;
}): OssMachine[] {
  const machines: OssMachine[] = ["docker"];
  if (input.remoteSupervisorUrl) machines.push("remote-supervisor");
  if (input.e2bApiKey) machines.push("e2b");
  if (input.boxApiKey) machines.push("box");
  if (input.daytonaApiKey) machines.push("daytona");
  return machines;
}

/** The machine family a provider id belongs to; emulators answer for the real thing. */
export function machineFamily(kind: string | undefined | null): OssMachine | null {
  const raw = (kind ?? "").trim().toLowerCase();
  if (raw === "e2b-emulator") return "e2b";
  if (raw === "box-emulator") return "box";
  if (raw === "daytona-emulator") return "daytona";
  return parseOssMachine(raw);
}

export interface ResolvedMachine {
  /** The machine a new computer boots into, or null for an emulator/fake process. */
  machine: OssMachine | null;
  /** Where that answer came from, so the UI never claims a saved choice that is not in force. */
  source: "deployment" | "env";
}

/**
 * The only answer to "which computer does this deploy use?". The saved choice wins whenever the
 * edition allows one and the deploy can actually reach that provider; otherwise the process env
 * answers. Both the API responses and the sandbox routing read this, so they cannot disagree.
 */
export function resolveDeploymentMachine(input: {
  saved?: string | null;
  envProvider: string;
  canChooseMachine: boolean;
  available?: readonly string[];
}): ResolvedMachine {
  const saved = parseOssMachine(input.saved ?? undefined);
  const available = input.available ?? OSS_MACHINES;
  if (input.canChooseMachine && saved && available.includes(saved)) {
    return { machine: saved, source: "deployment" };
  }
  return { machine: machineFamily(input.envProvider), source: "env" };
}

export const OSS_MACHINE_COPY: Record<OssMachine, { title: string; body: string }> = {
  docker: {
    title: "Nesta máquina (Docker)",
    body: "O computador dos bots sobe neste aparelho. Instale o Docker Desktop, sem chave e sem VPS. É o padrão para começar.",
  },
  "remote-supervisor": {
    title: "Minha VPS",
    body: "O computador fica no seu servidor. Cole o alias SSH do ~/.ssh/config (tela ao vivo no notebook) ou a URL e o token do supervisor. O celular 24 h pede o stack inteiro na VPS.",
  },
  e2b: {
    title: "E2B",
    body: "Desktop isolado na nuvem da E2B. Crie a conta, cole a chave. Cada bot tem o próprio sandbox — a Quibt não cobra a máquina.",
  },
  box: {
    title: "Box",
    body: "VM Ubuntu persistente na Box. Crie a conta, cole a chave. Cada bot tem a própria máquina — a Quibt não cobra a VM.",
  },
  daytona: {
    title: "Daytona",
    body: "Sandbox isolado na Daytona com terminal e desktop VNC. Cole a chave; cada bot ganha o próprio computador.",
  },
};
