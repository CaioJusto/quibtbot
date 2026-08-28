import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pnpmCandidates as devDesktopCandidates, startPnpm } from "./dev-desktop.mjs";
import { missingPnpmMessage, pnpmCandidates, runPnpmSync } from "./smoke-installer.mjs";

/**
 * Estes scripts chamavam `spawnSync("pnpm", …)` sem olhar `result.error`. Numa máquina
 * com corepack e sem `pnpm` no PATH isso dava `status: null`, saída vazia e código 1:
 * a pessoa não descobria nem que o comando não chegou a existir.
 */

const enoent = Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" });

function fakeChild() {
  return new EventEmitter() as EventEmitter & { on: EventEmitter["on"] };
}

describe("onde achar o pnpm", () => {
  it("prefere o npm_execpath do próprio pnpm, rodado pelo Node atual", () => {
    const candidates = pnpmCandidates({ npm_execpath: "/usr/lib/pnpm/bin/pnpm.cjs" }, "darwin");
    expect(candidates[0]).toEqual({
      command: process.execPath,
      args: ["/usr/lib/pnpm/bin/pnpm.cjs"],
      shell: false,
    });
  });

  it("aceita um npm_execpath que já é executável", () => {
    const candidates = pnpmCandidates({ npm_execpath: "/usr/local/bin/pnpm" }, "darwin");
    expect(candidates[0]).toEqual({ command: "/usr/local/bin/pnpm", args: [], shell: false });
  });

  it("sem npm_execpath, tenta o PATH e depois o corepack", () => {
    const candidates = pnpmCandidates({}, "linux");
    expect(candidates.map((candidate) => [candidate.command, candidate.args])).toEqual([
      ["pnpm", []],
      ["corepack", ["pnpm"]],
    ]);
    expect(candidates.every((candidate) => candidate.shell === false)).toBe(true);
  });

  it("no Windows os shims .cmd só rodam pelo shell", () => {
    expect(pnpmCandidates({}, "win32").every((candidate) => candidate.shell)).toBe(true);
  });

  it("os dois scripts procuram o pnpm do mesmo jeito", () => {
    expect(devDesktopCandidates({}, "linux")).toEqual(pnpmCandidates({}, "linux"));
  });

  it("a mensagem diz o comando que falhou e o que instalar", () => {
    const lines = missingPnpmMessage(["exec", "vitest"], enoent);
    expect(lines[0]).toContain("pnpm exec vitest");
    expect(lines[0]).toContain("spawn pnpm ENOENT");
    expect(lines[1]).toContain("corepack enable pnpm");
    expect(lines[1]).toContain("pnpm@9");
  });
});

describe("smoke-installer: runPnpmSync", () => {
  it("falha alto quando nenhum candidato existe, em vez de sair calado", () => {
    const failures: string[][] = [];
    const result = runPnpmSync(
      ["exec", "vitest"],
      {},
      {
        env: {},
        platform: "linux",
        spawn: () => ({ error: enoent, status: null }),
        fail: (lines: string[]) => {
          failures.push(lines);
          return undefined;
        },
      },
    );
    expect(result).toBeUndefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[0]).toContain('Não deu para rodar "pnpm exec vitest"');
    expect(failures[0]?.[1]).toContain("corepack enable pnpm");
  });

  it("cai para o próximo candidato quando o primeiro não existe", () => {
    const tried: string[] = [];
    const result = runPnpmSync(
      ["--version"],
      {},
      {
        env: {},
        platform: "linux",
        spawn: (command: string) => {
          tried.push(command);
          return command === "pnpm" ? { error: enoent, status: null } : { status: 0 };
        },
        fail: () => {
          throw new Error("não devia falhar");
        },
      },
    );
    expect(tried).toEqual(["pnpm", "corepack"]);
    expect(result).toEqual({ status: 0 });
  });

  it("erro que não é ENOENT para na hora e é dito por extenso", () => {
    const tried: string[] = [];
    const failures: string[][] = [];
    runPnpmSync(
      ["--version"],
      {},
      {
        env: {},
        platform: "linux",
        spawn: (command: string) => {
          tried.push(command);
          return { error: Object.assign(new Error("permission denied"), { code: "EACCES" }) };
        },
        fail: (lines: string[]) => {
          failures.push(lines);
          return undefined;
        },
      },
    );
    expect(tried).toEqual(["pnpm"]);
    expect(failures[0]?.[0]).toContain("permission denied");
  });
});

describe("dev-desktop: startPnpm", () => {
  it("tenta o próximo candidato quando o primeiro não existe", () => {
    const children: EventEmitter[] = [];
    const tried: string[] = [];
    startPnpm(
      ["--filter", "@quibt/desktop", "dev"],
      { cwd: "/repo" },
      {
        env: {},
        platform: "linux",
        spawn: (command: string) => {
          tried.push(command);
          const child = fakeChild();
          children.push(child);
          return child;
        },
        fail: () => {
          throw new Error("não devia falhar");
        },
      },
    );
    children[0]?.emit("error", enoent);
    expect(tried).toEqual(["pnpm", "corepack"]);
  });

  it("sem nenhum pnpm, explica a falha em vez de derrubar com ENOENT cru", () => {
    const children: EventEmitter[] = [];
    const failures: string[][] = [];
    startPnpm(
      ["dev"],
      {},
      {
        env: {},
        platform: "linux",
        spawn: () => {
          const child = fakeChild();
          children.push(child);
          return child;
        },
        fail: (lines: string[]) => {
          failures.push(lines);
          return undefined;
        },
      },
    );
    children[0]?.emit("error", enoent);
    children[1]?.emit("error", enoent);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[1]).toContain("npm install -g pnpm@9");
  });

  it("repassa a saída do filho para quem chamou", () => {
    const children: EventEmitter[] = [];
    const exits: (number | null)[] = [];
    startPnpm(
      ["dev"],
      {
        onExit: (code: number | null) => {
          exits.push(code);
        },
      },
      {
        env: {},
        platform: "linux",
        spawn: () => {
          const child = fakeChild();
          children.push(child);
          return child;
        },
        fail: () => undefined,
      },
    );
    children[0]?.emit("exit", 3);
    expect(exits).toEqual([3]);
  });
});

describe("packages/testkit/src/cli/verify.ts", () => {
  const source = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../packages/testkit/src/cli/verify.ts",
    ),
    "utf8",
  );

  it("não chama mais o pnpm pelo shell sem checar o erro", () => {
    expect(source).not.toContain('execSync("pnpm');
    expect(source).not.toContain('spawn("pnpm"');
  });

  it("usa a mesma procura e a mesma mensagem dos scripts", () => {
    expect(source).toContain("pnpmCandidates");
    expect(source).toContain("missingPnpmMessage");
    expect(source).toContain("corepack enable pnpm");
  });
});
