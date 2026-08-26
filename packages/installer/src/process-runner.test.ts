import { describe, expect, it } from "vitest";
import { createProcessRunner } from "./index.js";

const NODE = process.execPath;

describe("createProcessRunner", () => {
  it("entrega cada linha assim que sai, sem esperar o processo acabar", async () => {
    const lines: string[] = [];
    const result = await createProcessRunner().run(
      NODE,
      [
        "-e",
        "process.stdout.write('a: Pulling fs layer\\n'); setTimeout(() => { process.stdout.write('a: Pull complete\\r\\nfim'); process.stderr.write('aviso\\n'); }, 50);",
      ],
      { onOutput: (line, stream) => lines.push(`${stream}:${line}`) },
    );
    expect(result.code).toBe(0);
    expect(result.timedOut).toBeUndefined();
    expect(lines).toEqual([
      "stdout:a: Pulling fs layer",
      "stdout:a: Pull complete",
      "stderr:aviso",
      "stdout:fim",
    ]);
    expect(result.stdout).toContain("a: Pull complete");
  });

  it("mata um download que parou de falar, mesmo dentro do teto absoluto", async () => {
    const started = Date.now();
    const result = await createProcessRunner().run(
      NODE,
      ["-e", "process.stdout.write('x: Pulling fs layer\\n'); setInterval(() => {}, 1000);"],
      { timeoutMs: 20_000, inactivityTimeoutMs: 300, onOutput: () => undefined },
    );
    expect(result.code).toBe(124);
    expect(result.timedOut).toBe("inactivity");
    expect(result.stderr).toContain("no output");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("linhas novas adiam o timeout de inatividade; o teto absoluto ainda vale", async () => {
    const result = await createProcessRunner().run(
      NODE,
      ["-e", "setInterval(() => process.stdout.write('tick\\n'), 50);"],
      { timeoutMs: 600, inactivityTimeoutMs: 300 },
    );
    expect(result.code).toBe(124);
    expect(result.timedOut).toBe("absolute");
    expect(result.stdout).toContain("tick");
  });
});
