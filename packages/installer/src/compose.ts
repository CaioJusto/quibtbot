import { PUBLIC_PROFILE } from "./public-access.js";

export const INSTALL_RELEASE = "0.2.19";

export interface DesktopSigning {
  mac: { signed: boolean; notarized: boolean };
  win: { signed: boolean };
  linux: { signed: boolean };
}

/**
 * Como os instaladores da tag `v${INSTALL_RELEASE}` foram publicados de fato. O checklist de
 * release preenche isto a partir dos `signing-status-*.json` anexados à tag (o CI gera o
 * arquivo; a notarização acontece só no Mac do mantenedor, que substitui o DMG e o status
 * quando a faz). Site, README e docs escolhem a frase de download por este objeto — nunca
 * chame um build de assinado ou notarizado sem o status da tag dizer isso.
 *
 * v0.2.19: candidato ainda sem tag. O status permanece falso até o artefato exato ser
 * assinado, aceito pela Apple, grampeado e anexado à release com o status correspondente.
 * Na v0.2.14 (assim como v0.2.10 e v0.2.9) o mantenedor provou todas essas etapas.
 */
export const DESKTOP_SIGNING: DesktopSigning = {
  mac: { signed: false, notarized: false },
  win: { signed: false },
  linux: { signed: false },
};
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

/**
 * Religa um stack já instalado: todos os serviços de uma vez; a sondagem HTTP logo
 * depois é a barreira de saúde. Numa instalação pública o profile acorda o Caddy.
 */
export function stackUpInvocation(
  mode: ComposeMode,
  composeFile: string,
  envFile: string,
  options: { publicAccess?: boolean } = {},
): string[] {
  const base = options.publicAccess
    ? [...composeBaseArgs(composeFile, envFile), "--profile", PUBLIC_PROFILE]
    : composeBaseArgs(composeFile, envFile);
  const services = options.publicAccess ? [...APP_SERVICES, "caddy"] : [...APP_SERVICES];
  // The API/public readiness probe below this command is the real health gate. `computer`
  // intentionally exits after proving the image, so a project-wide `--wait` can stall a
  // restart even though every long-running service is already healthy.
  if (mode === "source") return [...base, "up", "-d", "--build", ...services];
  return [...base, "up", "-d", ...services];
}

/**
 * As imagens que o Compose vai puxar, já resolvidas (versão, digests do binário de
 * release e o Caddy só com o profile público). É a lista que vira "imagem 2 de 4".
 */
export function composeImagesInvocation(
  composeFile: string,
  envFile: string,
  options: { publicAccess?: boolean } = {},
): string[] {
  const base = options.publicAccess
    ? [...composeBaseArgs(composeFile, envFile), "--profile", PUBLIC_PROFILE]
    : composeBaseArgs(composeFile, envFile);
  return [...base, "config", "--images"];
}

export function appServicesUpInvocation(
  mode: ComposeMode,
  composeFile: string,
  envFile: string,
  options: { publicAccess?: boolean } = {},
): string[] {
  // `--profile public` acorda o Caddy (HTTPS via sslip.io). Sem o profile o serviço nem
  // existe para o Compose, então uma instalação local não paga nada por ele.
  const base = options.publicAccess
    ? [...composeBaseArgs(composeFile, envFile), "--profile", PUBLIC_PROFILE]
    : composeBaseArgs(composeFile, envFile);
  const services = options.publicAccess ? [...APP_SERVICES, "caddy"] : [...APP_SERVICES];
  if (mode === "source") {
    return [...base, "up", "-d", "--build", ...services];
  }
  // The API readiness probe immediately after this command is the health gate. Keeping
  // `--wait` here makes Compose wait forever for the intentional one-shot `computer`
  // dependency even after every long-running service is healthy.
  return [...base, "up", "-d", ...services];
}
