export const INSTALL_RELEASE = "0.2.9";
export const QUIBT_IMAGE_PREFIX = "ghcr.io/quibt";

export function requiredQuibtImages(release = INSTALL_RELEASE): string[] {
  return [
    `${QUIBT_IMAGE_PREFIX}/quibt-stack:${release}`,
    `${QUIBT_IMAGE_PREFIX}/quibt-supervisor:${release}`,
    `${QUIBT_IMAGE_PREFIX}/quibt-computer:${release}`,
  ];
}

export interface ComposeManifest {
  services?: Record<
    string,
    {
      image?: string;
      environment?: Record<string, string>;
    }
  >;
}

export type ComposeMode = "source" | "packaged";
export type ComposeStep = "pull" | "up";

const APP_SERVICES = ["supervisor", "api", "worker", "web", "computer"] as const;

function composeBaseArgs(composeFile: string, envFile: string): string[] {
  return ["compose", "-f", composeFile, "--env-file", envFile];
}

export function resolveQuibtImage(image: string, release = INSTALL_RELEASE): string {
  return image.replace(`\${QUIBT_STACK_VERSION:?}`, release);
}

export function allQuibtImages(manifest: ComposeManifest, release = INSTALL_RELEASE): string[] {
  const services = (manifest.services ?? {}) as Record<
    string,
    { image?: string; environment?: Record<string, string> }
  >;
  const images = new Set<string>();

  for (const service of Object.values(services)) {
    const image = service.image;
    if (image?.startsWith(`${QUIBT_IMAGE_PREFIX}/`)) {
      images.add(resolveQuibtImage(image, release));
    }
  }

  const envComputer = services.supervisor?.environment?.QUIBT_COMPUTER_IMAGE;
  if (envComputer?.startsWith(`${QUIBT_IMAGE_PREFIX}/`)) {
    images.add(resolveQuibtImage(envComputer, release));
  }

  const order = requiredQuibtImages(release);
  return order.filter((image) => images.has(image));
}

export function composeInvocation(
  mode: ComposeMode,
  composeFile: string,
  envFile: string,
  step: ComposeStep = "up",
): string[] {
  const base = composeBaseArgs(composeFile, envFile);
  if (step === "pull") return mode === "source" ? [...base, "build"] : [...base, "pull"];
  if (mode === "source") return [...base, "up", "-d", "--build"];
  return [...base, "up", "-d", "--wait"];
}

export function postgresUpInvocation(
  mode: ComposeMode,
  composeFile: string,
  envFile: string,
): string[] {
  const base = composeBaseArgs(composeFile, envFile);
  if (mode === "source") return [...base, "up", "-d", "--build", "postgres", "--wait"];
  return [...base, "up", "-d", "--wait", "postgres"];
}

export function appServicesUpInvocation(
  mode: ComposeMode,
  composeFile: string,
  envFile: string,
): string[] {
  const base = composeBaseArgs(composeFile, envFile);
  if (mode === "source") {
    return [...base, "up", "-d", "--build", "--wait", ...APP_SERVICES];
  }
  return [...base, "up", "-d", "--wait", ...APP_SERVICES];
}
