import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { QUIBT_IMAGE_PREFIX } from "./compose.js";
import type { DockerInvocation } from "./docker-invocation.js";
import { resolveDockerInvocation, runDockerCommand } from "./docker-invocation.js";
import type { ProcessRunner } from "./orchestrator.js";

/**
 * Desinstalar de verdade.
 *
 * Instalar o Quibt põe bastante coisa na máquina: os containers do compose, um
 * container por computador de bot, três imagens de vários GB, e uma pasta de dados com o
 * Postgres, as casas dos bots e os segredos. Apagar o app sozinho deixava tudo isso para
 * trás. Este módulo sabe exatamente o que foi criado e desfaz só isso — nunca encosta
 * em containers, imagens ou volumes que não sejam do Quibt.
 */

export type UninstallStep = "containers" | "computers" | "images" | "data";

export interface UninstallEvent {
  step: UninstallStep;
  status: "running" | "succeeded" | "skipped" | "failed";
  message: string;
}

export interface UninstallOptions {
  /** Manter a pasta de dados (banco, casas dos bots, segredos). */
  keepData?: boolean;
  /** Manter as imagens Docker (reinstalar depois não baixa de novo). */
  keepImages?: boolean;
}

export interface UninstallDeps extends UninstallOptions {
  dataDir: string;
  composeFile: string;
  run: ProcessRunner;
  docker?: DockerInvocation;
  onEvent?: (event: UninstallEvent) => void;
  /** Para teste: apagar a pasta sem tocar no disco de verdade. */
  removeDir?: (target: string) => void;
  exists?: (target: string) => boolean;
}

export interface UninstallResult {
  /** `false` quando algum passo falhou; o que foi mantido de propósito não conta. */
  ok: boolean;
  /** O que ficou para trás e por quê — a tela e o terminal mostram isto. */
  leftovers: string[];
  error?: string;
}

/** O rótulo que o supervisor põe em todo computador de bot que cria. */
export const MANAGED_LABEL = "quibt.managed=true";

export function envFilePathFor(dataDir: string): string {
  return path.join(path.resolve(dataDir), "quibt.env");
}

/**
 * O compose do Quibt é sempre o mesmo projeto (`name:` no manifesto); derrubar por
 * arquivo + env-file acerta exatamente os containers que o install subiu, e
 * `--remove-orphans` pega os que sobraram de uma versão anterior do manifesto.
 */
export function composeDownArgs(composeFile: string, envFile: string): string[] {
  return [
    "compose",
    "-f",
    composeFile,
    "--env-file",
    envFile,
    "down",
    "--remove-orphans",
    "--volumes",
    "--timeout",
    "20",
  ];
}

/** Lista todo container (parado ou não) criado pelo supervisor para um bot. */
export function listComputersArgs(): string[] {
  return ["ps", "-aq", "--filter", `label=${MANAGED_LABEL}`];
}

/** Lista toda imagem do Quibt, em qualquer versão — inclusive a de builds locais. */
export function listImagesArgs(): string[] {
  return ["images", "--format", "{{.ID}}", "--filter", `reference=${QUIBT_IMAGE_PREFIX}/*`];
}

export function parseLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Apagar a pasta de dados pode esbarrar em arquivos que o Postgres criou como outro
 * usuário (numa VPS, o bind mount é do root). Um container descartável apaga o
 * conteúdo com os mesmos direitos que o criou; depois, a pasta vazia sai pelo Node.
 */
export function wipeDataDirArgs(dataDir: string): string[] {
  return [
    "run",
    "--rm",
    "-v",
    `${path.resolve(dataDir)}:/data`,
    "alpine:3.20",
    "sh",
    "-c",
    "rm -rf /data/* /data/.[!.]* 2>/dev/null || true",
  ];
}

export async function runUninstall(deps: UninstallDeps): Promise<UninstallResult> {
  const emit = (event: UninstallEvent) => deps.onEvent?.(event);
  const exists = deps.exists ?? existsSync;
  const removeDir =
    deps.removeDir ?? ((target: string) => rmSync(target, { recursive: true, force: true }));
  const leftovers: string[] = [];
  const failures: string[] = [];
  const dataDir = path.resolve(deps.dataDir);
  const envFile = envFilePathFor(dataDir);

  const docker = deps.docker ?? (await resolveDockerInvocation(deps.run));
  if (!docker) {
    // Sem Docker, nada do que o Quibt subiu está rodando; só a pasta de dados fica.
    emit({ step: "containers", status: "skipped", message: "Docker não está disponível." });
    emit({ step: "computers", status: "skipped", message: "Docker não está disponível." });
    emit({ step: "images", status: "skipped", message: "Docker não está disponível." });
    leftovers.push("Containers e imagens do Quibt no Docker (o Docker não respondeu).");
    failures.push("O Docker não respondeu.");
  } else {
    emit({ step: "containers", status: "running", message: "Parando os serviços do Quibt…" });
    if (exists(envFile)) {
      const down = await runDockerCommand(
        deps.run,
        docker,
        composeDownArgs(deps.composeFile, envFile),
        {
          timeoutMs: 180_000,
        },
      );
      if (down.code === 0) {
        emit({ step: "containers", status: "succeeded", message: "Serviços removidos." });
      } else {
        emit({
          step: "containers",
          status: "failed",
          message: down.stderr.trim() || "docker compose down falhou.",
        });
        leftovers.push("Containers do compose quibt-desktop (o compose down falhou).");
        failures.push("docker compose down falhou.");
      }
    } else {
      emit({
        step: "containers",
        status: "skipped",
        message: "Sem quibt.env: nenhum serviço deste install para derrubar.",
      });
    }

    emit({ step: "computers", status: "running", message: "Removendo os computadores dos bots…" });
    const listed = await runDockerCommand(deps.run, docker, listComputersArgs());
    const computers = listed.code === 0 ? parseLines(listed.stdout) : [];
    if (computers.length) {
      const removed = await runDockerCommand(deps.run, docker, ["rm", "-f", ...computers], {
        timeoutMs: 180_000,
      });
      if (removed.code === 0) {
        emit({
          step: "computers",
          status: "succeeded",
          message: `${computers.length} computador(es) de bot removido(s).`,
        });
      } else {
        emit({ step: "computers", status: "failed", message: removed.stderr.trim() });
        leftovers.push("Containers quibt-ws-* (o docker rm falhou).");
        failures.push("docker rm falhou.");
      }
    } else {
      emit({ step: "computers", status: "skipped", message: "Nenhum computador de bot." });
    }

    if (deps.keepImages) {
      emit({ step: "images", status: "skipped", message: "Imagens mantidas a pedido." });
    } else {
      emit({ step: "images", status: "running", message: "Apagando as imagens do Quibt…" });
      const images = await runDockerCommand(deps.run, docker, listImagesArgs());
      // Pulls pinned by digest appear as `repository:<none>` in `docker images`.
      // Removing by the immutable image ID handles both tagged and digest-only
      // images; deduplication avoids passing the same shared image to `rmi` twice.
      const imageIds = images.code === 0 ? [...new Set(parseLines(images.stdout))] : [];
      if (imageIds.length) {
        const rmi = await runDockerCommand(deps.run, docker, ["rmi", "-f", ...imageIds], {
          timeoutMs: 300_000,
        });
        if (rmi.code === 0) {
          emit({
            step: "images",
            status: "succeeded",
            message: `${imageIds.length} imagem(ns) apagada(s).`,
          });
        } else {
          emit({ step: "images", status: "failed", message: rmi.stderr.trim() });
          leftovers.push(`Imagens ${QUIBT_IMAGE_PREFIX}/* (o docker rmi falhou).`);
          failures.push("docker rmi falhou.");
        }
      } else {
        emit({ step: "images", status: "skipped", message: "Nenhuma imagem do Quibt." });
      }
    }
  }

  if (deps.keepData) {
    emit({ step: "data", status: "skipped", message: `Dados mantidos em ${dataDir}.` });
    leftovers.push(`Pasta de dados mantida: ${dataDir}`);
  } else if (!exists(dataDir)) {
    emit({ step: "data", status: "skipped", message: "Nenhuma pasta de dados." });
  } else {
    emit({ step: "data", status: "running", message: `Apagando ${dataDir}…` });
    if (docker) {
      // Se o container falhar (sem rede para puxar o alpine, por exemplo), o rmSync
      // abaixo ainda tenta; o que sobrar é dito, não escondido.
      await runDockerCommand(deps.run, docker, wipeDataDirArgs(dataDir), { timeoutMs: 120_000 });
    }
    try {
      removeDir(dataDir);
      emit({ step: "data", status: "succeeded", message: "Pasta de dados apagada." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ step: "data", status: "failed", message });
      leftovers.push(`Pasta de dados: ${dataDir} (${message})`);
      failures.push(`A pasta de dados não saiu: ${message}`);
    }
  }

  return {
    ok: failures.length === 0,
    leftovers,
    error: failures.length ? failures.join(" ") : undefined,
  };
}
