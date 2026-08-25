import { describe, expect, it } from "vitest";
import type { ProcessRunner } from "./orchestrator.js";
import {
  composeDownArgs,
  listComputersArgs,
  listImagesArgs,
  runUninstall,
  type UninstallEvent,
  wipeDataDirArgs,
} from "./uninstall.js";

function fakeDocker(
  responses: Record<string, { code?: number; stdout?: string; stderr?: string }>,
) {
  const calls: string[][] = [];
  const run: ProcessRunner = {
    async run(_command, args) {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      const hit =
        responses[args.join(" ")] ??
        responses[key] ??
        responses[args[0] ?? ""] ??
        ({} as { code?: number; stdout?: string; stderr?: string });
      return { code: hit.code ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
    },
  };
  return { run, calls };
}

const docker = { command: "docker", prefixArgs: [] };

describe("uninstall", () => {
  it("derruba o compose por arquivo e env, sem órfãos e com volumes", () => {
    expect(composeDownArgs("/x/compose.yml", "/d/quibt.env")).toEqual([
      "compose",
      "-f",
      "/x/compose.yml",
      "--env-file",
      "/d/quibt.env",
      "down",
      "--remove-orphans",
      "--volumes",
      "--timeout",
      "20",
    ]);
  });

  it("só toca no que tem a marca do Quibt: containers rotulados e imagens ghcr.io/quibt", () => {
    expect(listComputersArgs()).toEqual(["ps", "-aq", "--filter", "label=quibt.managed=true"]);
    expect(listImagesArgs()).toContain("reference=ghcr.io/quibt/*");
    expect(listImagesArgs()).toContain("{{.ID}}");
    expect(wipeDataDirArgs("/tmp/q")).toContain("/tmp/q:/data");
  });

  it("remove serviços, computadores, imagens e a pasta de dados, nessa ordem", async () => {
    const { run, calls } = fakeDocker({
      ps: { stdout: "abc\ndef\n" },
      images: { stdout: "sha256:stack\nsha256:computer\nsha256:stack\n" },
    });
    const removed: string[] = [];
    const events: UninstallEvent[] = [];
    const result = await runUninstall({
      dataDir: "/data/quibt",
      composeFile: "/x/compose.yml",
      run,
      docker,
      exists: () => true,
      removeDir: (target) => removed.push(target),
      onEvent: (event) => events.push(event),
    });
    expect(result.ok).toBe(true);
    expect(result.leftovers).toEqual([]);
    expect(calls.map((c) => c[0])).toEqual(["compose", "ps", "rm", "images", "rmi", "run"]);
    expect(calls[2]).toEqual(["rm", "-f", "abc", "def"]);
    expect(calls[4]).toEqual(["rmi", "-f", "sha256:stack", "sha256:computer"]);
    expect(removed).toEqual(["/data/quibt"]);
    expect(events.filter((e) => e.status === "succeeded").map((e) => e.step)).toEqual([
      "containers",
      "computers",
      "images",
      "data",
    ]);
  });

  it("mantém dados e imagens quando pedido, e diz o que ficou", async () => {
    const { run, calls } = fakeDocker({ ps: { stdout: "" }, images: { stdout: "x" } });
    const removed: string[] = [];
    const result = await runUninstall({
      dataDir: "/data/quibt",
      composeFile: "/x/compose.yml",
      run,
      docker,
      keepData: true,
      keepImages: true,
      exists: () => true,
      removeDir: (target) => removed.push(target),
    });
    expect(result.ok).toBe(true);
    expect(removed).toEqual([]);
    expect(calls.some((c) => c[0] === "rmi")).toBe(false);
    expect(result.leftovers).toEqual(["Pasta de dados mantida: /data/quibt"]);
  });

  it("sem Docker, ainda apaga a pasta e avisa que containers e imagens ficaram", async () => {
    const removed: string[] = [];
    const result = await runUninstall({
      dataDir: "/data/quibt",
      composeFile: "/x/compose.yml",
      run: {
        async run() {
          return { code: 1, stdout: "", stderr: "" };
        },
      },
      exists: () => true,
      removeDir: (target) => removed.push(target),
    });
    expect(removed).toEqual(["/data/quibt"]);
    expect(result.ok).toBe(false);
    expect(result.leftovers[0]).toMatch(/Docker não respondeu/);
  });

  it("um compose down que falha não impede o resto, e aparece no resultado", async () => {
    const { run } = fakeDocker({ compose: { code: 1, stderr: "boom" }, ps: { stdout: "" } });
    const result = await runUninstall({
      dataDir: "/data/quibt",
      composeFile: "/x/compose.yml",
      run,
      docker,
      exists: () => true,
      removeDir: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("compose down falhou");
    expect(result.leftovers.some((l) => l.includes("quibt-desktop"))).toBe(true);
  });
});
