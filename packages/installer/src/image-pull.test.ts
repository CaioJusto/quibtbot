import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDiskSpace,
  downloadNotice,
  formatElapsed,
  formatGigabytes,
  listComposeImages,
  MIN_REQUIRED_FREE_BYTES,
  missingImagesLocally,
  PULL_ATTEMPTS,
  PULL_INACTIVITY_TIMEOUT_MS,
  PullLayerTracker,
  type PullProgress,
  progressMessage,
  pullImagesWithProgress,
  pullWithProgress,
  quietProgressMessage,
  REQUIRED_FREE_BYTES,
  requiredFreeBytesFor,
  shortImageName,
} from "./image-pull.js";
import { createProcessRunner } from "./index.js";
import type { ProcessRunner, ProcessRunResult } from "./orchestrator.js";

const DOCKER = { command: "docker", prefixArgs: [] };

describe("PullLayerTracker", () => {
  it("conta camadas pelo que o docker pull imprime sem TTY", () => {
    const tracker = new PullLayerTracker();
    expect(tracker.observe("0.2.11: Pulling from quibt/quibt-stack")).toBe(false);
    expect(tracker.observe("a2abf6c4d29d: Pulling fs layer")).toBe(true);
    expect(tracker.observe("c5a5c9d0f5d1: Pulling fs layer")).toBe(true);
    expect(tracker.observe("a2abf6c4d29d: Waiting")).toBe(false);
    expect(tracker.observe("a2abf6c4d29d: Verifying Checksum")).toBe(false);
    expect(tracker.observe("a2abf6c4d29d: Download complete")).toBe(false);
    expect(tracker.snapshot()).toEqual({ done: 0, total: 2 });
    expect(tracker.observe("a2abf6c4d29d: Pull complete")).toBe(true);
    expect(tracker.snapshot()).toEqual({ done: 1, total: 2 });
    // Camada em cache: nasce pronta.
    expect(tracker.observe("9f1b2c3d4e5f: Already exists")).toBe(true);
    expect(tracker.snapshot()).toEqual({ done: 2, total: 3 });
    expect(tracker.observe("Digest: sha256:abc")).toBe(false);
    expect(tracker.observe("Status: Downloaded newer image for ghcr.io/quibt/quibt-stack")).toBe(
      false,
    );
  });
});

describe("nomes e mensagens", () => {
  it("encurta a referência para o que cabe numa linha", () => {
    expect(shortImageName("ghcr.io/quibt/quibt-stack:0.2.11")).toBe("quibt-stack:0.2.11");
    expect(shortImageName("postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece")).toBe(
      "postgres:16@e17e86066e5e",
    );
    expect(shortImageName(`ghcr.io/quibt/quibt-computer@sha256:${"a".repeat(64)}`)).toBe(
      "quibt-computer@aaaaaaaaaaaa",
    );
  });

  it("diz imagem N de M e as camadas quando já as conhece", () => {
    const base: PullProgress = {
      image: "ghcr.io/quibt/quibt-stack:0.2.11",
      label: "quibt-stack:0.2.11",
      index: 2,
      count: 4,
      layersDone: 0,
      layersTotal: 0,
    };
    expect(progressMessage(base)).toBe("Baixando imagem 2 de 4: quibt-stack:0.2.11…");
    expect(progressMessage({ ...base, layersDone: 3, layersTotal: 12 })).toBe(
      "Baixando imagem 2 de 4: quibt-stack:0.2.11 — 3/12 camadas",
    );
    expect(progressMessage({ ...base, count: 1, index: 1, layersDone: 1, layersTotal: 2 })).toBe(
      "Baixando quibt-stack:0.2.11 — 1/2 camadas",
    );
  });

  it("formata gigabytes do jeito que o Finder mostra", () => {
    expect(formatGigabytes(10_000_000_000)).toBe("10 GB");
    expect(formatGigabytes(6_350_000_000)).toBe("6,4 GB");
    expect(formatGigabytes(123_456_789_000)).toBe("123 GB");
  });
});

describe("checkDiskSpace", () => {
  it("falha cedo dizendo quanto falta e onde", async () => {
    const result = await checkDiskSpace(
      ["/Users/x/Library/Application Support/Quibt", "/var/lib/docker"],
      async (target) => {
        if (target === "/var/lib/docker") throw new Error("ENOENT");
        return { bsize: 4096, bavail: 1_000_000 }; // 4,1 GB livres
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.path).toBe("/Users/x/Library/Application Support/Quibt");
    expect(result.message).toContain("Faltam 5,9 GB em /Users/x/Library/Application Support/Quibt");
    expect(result.message).toContain("10 GB livres");
  });

  it("ignora caminhos que não dão para medir e aceita bigint", async () => {
    const result = await checkDiskSpace(["/nada", "/dados"], async (target) => {
      if (target === "/nada") throw new Error("ENOENT");
      return { bsize: 4096n, bavail: 10_000_000n };
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("listComposeImages", () => {
  it("lê uma referência por linha, sem repetir e ignorando avisos", async () => {
    const run: ProcessRunner = {
      async run() {
        return {
          code: 0,
          stdout:
            "WARN[0000] The QUIBT_PUBLIC_HOST variable is not set\npostgres:16@sha256:abc\nghcr.io/quibt/quibt-stack:0.2.11\nghcr.io/quibt/quibt-stack:0.2.11\n\nghcr.io/quibt/quibt-computer:0.2.11\n",
          stderr: "",
        };
      },
    };
    expect(await listComposeImages(run, DOCKER, ["compose", "config", "--images"])).toEqual([
      "postgres:16@sha256:abc",
      "ghcr.io/quibt/quibt-stack:0.2.11",
      "ghcr.io/quibt/quibt-computer:0.2.11",
    ]);
  });

  it("devolve vazio quando o compose não responde", async () => {
    const run: ProcessRunner = {
      async run() {
        return { code: 1, stdout: "", stderr: "boom" };
      },
    };
    expect(await listComposeImages(run, DOCKER, ["compose", "config", "--images"])).toEqual([]);
  });
});

describe("pullImagesWithProgress", () => {
  function fakePullRunner(
    behaviour: (image: string, attempt: number) => ProcessRunResult | "stream",
  ): { run: ProcessRunner; attempts: Map<string, number>; options: unknown[] } {
    const attempts = new Map<string, number>();
    const options: unknown[] = [];
    const run: ProcessRunner = {
      async run(_command, args, opts) {
        const image = args[1] as string;
        const attempt = (attempts.get(image) ?? 0) + 1;
        attempts.set(image, attempt);
        options.push(opts);
        const outcome = behaviour(image, attempt);
        if (outcome !== "stream") return outcome;
        opts?.onOutput?.(`${image.split(":")[1]}: Pulling from quibt`, "stdout");
        opts?.onOutput?.("aaaaaaaaaaaa: Pulling fs layer", "stdout");
        opts?.onOutput?.("bbbbbbbbbbbb: Pulling fs layer", "stdout");
        opts?.onOutput?.("aaaaaaaaaaaa: Pull complete", "stdout");
        opts?.onOutput?.("bbbbbbbbbbbb: Pull complete", "stdout");
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    return { run, attempts, options };
  }

  it("emite progresso por imagem e por camada, com timeout de inatividade", async () => {
    const { run, options } = fakePullRunner(() => "stream");
    const progress: PullProgress[] = [];
    const messages: string[] = [];
    const outcome = await pullImagesWithProgress(
      {
        run,
        docker: DOCKER,
        clock: { sleep: async () => undefined },
        onProgress: (p, message) => {
          progress.push(p);
          messages.push(message);
        },
        onNotice: () => undefined,
      },
      ["ghcr.io/quibt/quibt-stack:0.2.11", "postgres:16"],
    );
    expect(outcome).toEqual({ ok: true });
    expect(progress[0]).toEqual({
      image: "ghcr.io/quibt/quibt-stack:0.2.11",
      label: "quibt-stack:0.2.11",
      index: 1,
      count: 2,
      layersDone: 0,
      layersTotal: 0,
    });
    expect(progress).toContainEqual({
      image: "ghcr.io/quibt/quibt-stack:0.2.11",
      label: "quibt-stack:0.2.11",
      index: 1,
      count: 2,
      layersDone: 1,
      layersTotal: 2,
    });
    expect(progress.at(-1)).toEqual({
      image: "postgres:16",
      label: "postgres:16",
      index: 2,
      count: 2,
      layersDone: 2,
      layersTotal: 2,
    });
    expect(messages).toContain("Baixando imagem 1 de 2: quibt-stack:0.2.11 — 1/2 camadas");
    expect(messages).toContain("postgres:16 pronta");
    for (const opts of options as Array<{ inactivityTimeoutMs?: number; timeoutMs?: number }>) {
      expect(opts.inactivityTimeoutMs).toBe(900_000);
      expect(opts.timeoutMs).toBe(3_600_000);
    }
  });

  it("tenta de novo até três vezes e avisa que o que baixou fica guardado", async () => {
    const { run, attempts } = fakePullRunner((image, attempt) =>
      image.startsWith("ghcr.io") && attempt < 3
        ? { code: 1, stdout: "", stderr: "dial tcp: i/o timeout" }
        : "stream",
    );
    const notices: string[] = [];
    const sleeps: number[] = [];
    const outcome = await pullImagesWithProgress(
      {
        run,
        docker: DOCKER,
        clock: {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
        onProgress: () => undefined,
        onNotice: (message) => notices.push(message),
      },
      ["ghcr.io/quibt/quibt-stack:0.2.11", "postgres:16"],
    );
    expect(outcome).toEqual({ ok: true });
    expect(attempts.get("ghcr.io/quibt/quibt-stack:0.2.11")).toBe(3);
    expect(attempts.get("postgres:16")).toBe(1);
    expect(sleeps).toEqual([5_000, 15_000]);
    expect(notices[0]).toContain("A internet falhou no meio do download");
    expect(notices[0]).toContain("tentativa 1 de 3");
    expect(notices[0]).toContain("o que já baixou fica guardado");
  });

  it("desiste depois de três tentativas com a causa e o stderr cru separados", async () => {
    const { run, attempts } = fakePullRunner(() => ({
      code: 124,
      stdout: "",
      stderr: "process produced no output for 180 s",
      timedOut: "inactivity",
    }));
    const outcome = await pullImagesWithProgress(
      {
        run,
        docker: DOCKER,
        clock: { sleep: async () => undefined },
        onProgress: () => undefined,
        onNotice: () => undefined,
      },
      ["ghcr.io/quibt/quibt-computer:0.2.11"],
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(attempts.get("ghcr.io/quibt/quibt-computer:0.2.11")).toBe(PULL_ATTEMPTS);
    expect(outcome.message).toContain("quibt-computer:0.2.11 falhou 3 vezes");
    expect(outcome.message).toContain("ficou 15 minutos sem progresso");
    expect(outcome.message).toContain("rode a instalação de novo");
    expect(outcome.message).not.toContain("clique");
    expect(outcome.message).toContain("o que já baixou fica guardado");
    expect(outcome.detail).toBe("process produced no output for 180 s");
  });
});

describe("paciência com uma camada grande", () => {
  it("tolera quinze minutos de silêncio, não três", () => {
    // Sem TTY o docker não imprime nada enquanto baixa; três minutos matavam a camada
    // do apt do quibt-computer numa conexão doméstica.
    expect(PULL_INACTIVITY_TIMEOUT_MS).toBe(15 * 60_000);
  });

  it("formata o tempo decorrido do jeito que se lê esperando", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(20_000)).toBe("20s");
    expect(formatElapsed(80_000)).toBe("1m20s");
    expect(formatElapsed(120_000)).toBe("2m");
  });

  it("diz em que camada está e há quanto tempo", () => {
    const progress: PullProgress = {
      image: "ghcr.io/quibt/quibt-computer:0.2.11",
      label: "quibt-computer:0.2.11",
      index: 3,
      count: 4,
      layersDone: 2,
      layersTotal: 9,
    };
    expect(quietProgressMessage(progress, 80_000)).toBe(
      "Baixando imagem 3 de 4: quibt-computer:0.2.11 — baixando a camada 3 de 9 há 1m20s…",
    );
    expect(quietProgressMessage({ ...progress, layersTotal: 0, layersDone: 0 }, 15_000)).toBe(
      "Baixando imagem 3 de 4: quibt-computer:0.2.11 — sem novidade há 15s; o download continua.",
    );
  });

  it("um pull real que fica mudo enquanto baixa não é morto e dá sinal de vida", async () => {
    const binDir = mkdtempSync(path.join(tmpdir(), "quibt-quiet-pull-"));
    const dockerPath = path.join(binDir, "docker");
    const bytesPath = path.join(binDir, "layer.bytes");
    // Como o docker de verdade sem TTY: anuncia a camada e cala a boca enquanto baixa.
    writeFileSync(
      dockerPath,
      `#!/bin/sh
echo "aaaaaaaaaaaa: Pulling fs layer"
i=0
while [ $i -lt 12 ]; do
  printf 'x' >> "${bytesPath}"
  sleep 0.1
  i=$((i+1))
done
echo "aaaaaaaaaaaa: Pull complete"
exit 0
`,
      { mode: 0o755 },
    );
    chmodSync(dockerPath, 0o755);

    try {
      const progress: PullProgress[] = [];
      const messages: string[] = [];
      const started = Date.now();
      const outcome = await pullWithProgress(
        {
          run: createProcessRunner(),
          docker: { command: dockerPath, prefixArgs: [] },
          clock: { sleep: async () => undefined },
          onProgress: (entry, message) => {
            progress.push(entry);
            messages.push(message);
          },
          onNotice: () => undefined,
          // A janela de silêncio continua a de produção (15 min): o que o teste encurta
          // é só o sinal de vida.
          heartbeatIntervalMs: 100,
        },
        ["pull", "ghcr.io/quibt/quibt-computer:0.2.11"],
        { image: "ghcr.io/quibt/quibt-computer:0.2.11", index: 1, count: 1 },
      );

      expect(outcome).toEqual({ ok: true });
      expect(Date.now() - started).toBeGreaterThan(500);
      // O download estava mesmo andando enquanto o docker não falava.
      expect(readFileSync(bytesPath, "utf8").length).toBeGreaterThan(1);
      const alive = progress.filter((entry) => entry.quietMs !== undefined);
      expect(alive.length).toBeGreaterThan(1);
      expect(messages.some((message) => /baixando a camada 1 de 1 há \d+s…$/.test(message))).toBe(
        true,
      );
      expect(progress.at(-1)).toMatchObject({ layersDone: 1, layersTotal: 1 });
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("retomada: só o que falta", () => {
  it("separa as imagens que já estão no disco", async () => {
    const asked: string[] = [];
    const run: ProcessRunner = {
      async run(_command, args) {
        const reference = args.at(-1) as string;
        asked.push(reference);
        if (reference.includes("quibt-stack"))
          return { code: 0, stdout: "sha256:aa\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "Error: No such image" };
      },
    };
    expect(
      await missingImagesLocally(run, DOCKER, [
        "ghcr.io/quibt/quibt-stack:0.2.11",
        "ghcr.io/quibt/quibt-computer:0.2.11",
      ]),
    ).toEqual(["ghcr.io/quibt/quibt-computer:0.2.11"]);
    expect(asked).toHaveLength(2);
  });

  it("exige o disco proporcional ao que falta, com piso e teto", () => {
    expect(requiredFreeBytesFor(4, 4)).toBe(REQUIRED_FREE_BYTES);
    expect(requiredFreeBytesFor(0, 0)).toBe(REQUIRED_FREE_BYTES);
    expect(requiredFreeBytesFor(2, 4)).toBe(5_000_000_000);
    expect(requiredFreeBytesFor(1, 4)).toBe(2_500_000_000);
    expect(requiredFreeBytesFor(1, 10)).toBe(MIN_REQUIRED_FREE_BYTES);
  });

  it("anuncia só o tamanho do que falta", () => {
    expect(downloadNotice(4, 4)).toContain("1,7 GB");
    expect(downloadNotice(1, 4)).toBe(
      "Falta 1 imagem de 4 (cerca de 0,4 GB). O resto já está no disco.",
    );
    expect(downloadNotice(2, 4)).toBe(
      "Faltam 2 imagens de 4 (cerca de 0,9 GB). O resto já está no disco.",
    );
  });
});
