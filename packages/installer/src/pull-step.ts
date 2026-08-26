import path from "node:path";
import { type ComposeMode, composeImagesInvocation, composeInvocation } from "./compose.js";
import type { DockerInvocation } from "./docker-invocation.js";
import { runDockerCommand } from "./docker-invocation.js";
import { explainDockerFailure } from "./failure-messages.js";
import {
  checkDiskSpace,
  downloadNotice,
  listComposeImages,
  missingImagesLocally,
  NOTHING_TO_DOWNLOAD_NOTICE,
  PULL_ABSOLUTE_TIMEOUT_MS,
  type PullProgress,
  pullImagesWithProgress,
  pullWithProgress,
  requiredFreeBytesFor,
  type StatfsLike,
} from "./image-pull.js";
import type { Clock, ProcessRunner } from "./orchestrator.js";

/** A construção a partir do código não tem camadas para contar, mas é igualmente longa. */
const BUILD_INACTIVITY_TIMEOUT_MS = 10 * 60_000;

export interface PullStepDeps {
  run: ProcessRunner;
  docker: DockerInvocation;
  clock: Pick<Clock, "sleep">;
  dataDir: string;
  composeFile: string;
  envFile: string;
  composeMode: ComposeMode;
  /** Instalação pública: o Caddy entra na lista das imagens. */
  publicAccess?: boolean;
  /** Só os testes trocam: mede o espaço livre antes do download. */
  statfs?: StatfsLike;
  onProgress: (progress: PullProgress, message: string) => void;
  onNotice: (message: string) => void;
  /** Só os testes trocam. */
  inactivityTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

export type PullStepOutcome = { ok: true } | { ok: false; message: string; detail: string };

/** A raiz onde o Docker guarda as imagens; se não der para descobrir, ignora. */
export async function dockerRootDir(
  run: ProcessRunner,
  docker: DockerInvocation,
): Promise<string | null> {
  const info = await runDockerCommand(run, docker, ["info", "--format", "{{.DockerRootDir}}"], {
    timeoutMs: 30_000,
  });
  if (info.code !== 0) return null;
  return info.stdout.trim() || null;
}

/**
 * O download das imagens, com o que faltava: as que já estão no disco saem da lista
 * (o aviso de tamanho e o "imagem N de M" ficam honestos e a exigência de disco encolhe
 * junto), checagem de espaço antes, uma imagem por vez com progresso por camadas,
 * timeout por inatividade (e não de cinco minutos absolutos, que derrubava qualquer
 * conexão abaixo de ~45 Mbps) e até três tentativas.
 *
 * É o mesmo passo no `install`, na retomada de um stack já instalado e no `update`:
 * quem manda o usuário rodar a atualização não pode entregar lá o defeito que arrumou
 * aqui.
 */
export async function pullComposeImages(deps: PullStepDeps): Promise<PullStepOutcome> {
  const cwd = path.dirname(deps.composeFile);

  if (deps.composeMode === "source") {
    const build = await runDockerCommand(
      deps.run,
      deps.docker,
      composeInvocation(deps.composeMode, deps.composeFile, deps.envFile, "pull"),
      {
        cwd,
        timeoutMs: PULL_ABSOLUTE_TIMEOUT_MS,
        inactivityTimeoutMs: BUILD_INACTIVITY_TIMEOUT_MS,
      },
    );
    if (build.code !== 0) {
      const detail = `${build.stderr}\n${build.stdout}`.trim();
      return {
        ok: false,
        message:
          explainDockerFailure(detail, { phase: "pull" }) ??
          "A construção das imagens a partir do código falhou.",
        detail,
      };
    }
    return { ok: true };
  }

  const declared = await listComposeImages(
    deps.run,
    deps.docker,
    composeImagesInvocation(deps.composeFile, deps.envFile, { publicAccess: deps.publicAccess }),
    cwd,
  );
  const missing =
    declared.length > 0 ? await missingImagesLocally(deps.run, deps.docker, declared) : [];
  if (declared.length > 0 && missing.length === 0) {
    deps.onNotice(NOTHING_TO_DOWNLOAD_NOTICE);
    return { ok: true };
  }

  const dockerRoot = await dockerRootDir(deps.run, deps.docker);
  const disk = await checkDiskSpace(
    [path.resolve(deps.dataDir), ...(dockerRoot ? [dockerRoot] : [])],
    deps.statfs,
    requiredFreeBytesFor(missing.length, declared.length),
  );
  if (!disk.ok) return { ok: false, message: disk.message, detail: "" };

  deps.onNotice(downloadNotice(missing.length, declared.length));
  const pullDeps = {
    run: deps.run,
    docker: deps.docker,
    clock: deps.clock,
    cwd,
    onProgress: deps.onProgress,
    onNotice: deps.onNotice,
    inactivityTimeoutMs: deps.inactivityTimeoutMs,
    heartbeatIntervalMs: deps.heartbeatIntervalMs,
  };
  const outcome =
    missing.length > 0
      ? await pullImagesWithProgress(pullDeps, missing)
      : await pullWithProgress(
          pullDeps,
          composeInvocation(deps.composeMode, deps.composeFile, deps.envFile, "pull"),
          { image: "imagens do Quibt Bot", index: 1, count: 1 },
        );
  if (!outcome.ok) return { ok: false, message: outcome.message, detail: outcome.detail };
  return { ok: true };
}
