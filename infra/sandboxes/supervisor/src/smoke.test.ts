import { describe, expect, it } from "vitest";
import {
  checkSmokeExec,
  orphanContainers,
  runDockerSmoke,
  SMOKE_EXIT_CODE,
  type SmokeExec,
  smokeCommand,
  smokeHeaders,
} from "./smoke.js";

const MARKER = "smoke-1";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A supervisor that really "runs" the smoke command, so the test exercises the same
 * stdout / stderr / exit-code contract as the live one. Each case bends a single answer.
 */
function fakeSupervisor(
  overrides: { exec?: (result: SmokeExec) => SmokeExec; inspectAfterDestroy?: number } = {},
) {
  const calls: string[] = [];
  let destroyed = false;
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.endsWith("/health")) return json({ ok: true, image: "quibt/computer:local" });
    if (url.endsWith("/computers") && method === "POST") {
      return json({ id: "container-1", screenUrl: "http://127.0.0.1:6080/embed.html", display: 1 });
    }
    if (url.endsWith("/exec")) {
      const argv = (JSON.parse(String(init?.body)) as { argv: string[] }).argv;
      const script = argv[2] ?? "";
      const marker = /echo (\S+)-stdout/.exec(script)?.[1] ?? "";
      const code = Number(/exit (\d+)/.exec(script)?.[1] ?? 0);
      const result: SmokeExec = {
        stdout: `${marker}-stdout\n`,
        stderr: `${marker}-stderr\n`,
        code,
      };
      return json(overrides.exec ? overrides.exec(result) : result);
    }
    if (url.endsWith("/embed.html")) return new Response("<html></html>");
    if (method === "DELETE") {
      destroyed = true;
      return json({ ok: true });
    }
    return json(
      { error: "computer not found" },
      destroyed ? (overrides.inspectAfterDestroy ?? 404) : 200,
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function smoke(overrides: Parameters<typeof fakeSupervisor>[0] = {}, containers = "") {
  const supervisor = fakeSupervisor(overrides);
  return {
    supervisor,
    promise: runDockerSmoke({
      supervisorUrl: "http://127.0.0.1:7091/",
      token: "token",
      workspaceId: "ws-1",
      botId: "bot-1",
      log: () => undefined,
      timeoutMs: 50,
      fetchImpl: supervisor.impl,
      listWorkspaceContainers: async () => containers,
    }),
  };
}

describe("smokeCommand", () => {
  it("writes to both streams and fails with a status nobody defaults to", () => {
    const [shell, flag, script] = smokeCommand(MARKER);
    expect(shell).toBe("bash");
    expect(flag).toBe("-lc");
    expect(script).toContain(`echo ${MARKER}-stdout`);
    expect(script).toContain(`echo ${MARKER}-stderr 1>&2`);
    expect(SMOKE_EXIT_CODE).not.toBe(0);
    expect(SMOKE_EXIT_CODE).not.toBe(1);
    expect(script).toContain(`exit ${SMOKE_EXIT_CODE}`);
  });
});

describe("checkSmokeExec", () => {
  const good = {
    stdout: `${MARKER}-stdout\n`,
    stderr: `${MARKER}-stderr\n`,
    code: SMOKE_EXIT_CODE,
  };

  it("accepts stdout, stderr, and the exit code kept apart", () => {
    expect(checkSmokeExec(good, MARKER)).toEqual([]);
  });

  it("catches the demuxer regression that merged stderr into stdout", () => {
    const merged = {
      stdout: `${MARKER}-stdout\n${MARKER}-stderr\n`,
      stderr: "",
      code: SMOKE_EXIT_CODE,
    };
    expect(checkSmokeExec(merged, MARKER)).toEqual([
      expect.stringContaining("stderr lost the command output"),
      "stderr was merged into stdout",
    ]);
  });

  it("catches a swallowed exit code", () => {
    expect(checkSmokeExec({ ...good, code: 0 }, MARKER)).toEqual([
      `exit code 0 instead of ${SMOKE_EXIT_CODE}`,
    ]);
  });

  it("catches lost stdout", () => {
    expect(checkSmokeExec({ ...good, stdout: "" }, MARKER)).toEqual([
      expect.stringContaining("stdout lost the command output"),
    ]);
  });
});

describe("orphanContainers", () => {
  it("reads an empty docker ps as clean", () => {
    expect(orphanContainers("\n  \n")).toEqual([]);
  });

  it("reports every container still labelled with the workspace", () => {
    expect(orphanContainers("quibt-ws-a Up 2 minutes\nquibt-ws-b Exited (0)\n")).toEqual([
      "quibt-ws-a Up 2 minutes",
      "quibt-ws-b Exited (0)",
    ]);
  });
});

describe("smokeHeaders", () => {
  it("always sends the bearer token and both identity headers", () => {
    expect(smokeHeaders("t", "bot-1", "ws-1")).toEqual({
      authorization: "Bearer t",
      "content-type": "application/json",
      "x-quibt-bot-id": "bot-1",
      "x-quibt-workspace-id": "ws-1",
    });
  });
});

describe("runDockerSmoke", () => {
  it("provisions, execs, checks the screen, and destroys", async () => {
    const { promise, supervisor } = smoke();
    await expect(promise).resolves.toBeUndefined();
    expect(supervisor.calls).toEqual([
      "GET http://127.0.0.1:7091/health",
      "POST http://127.0.0.1:7091/computers",
      "POST http://127.0.0.1:7091/computers/container-1/exec",
      "GET http://127.0.0.1:6080/embed.html",
      "DELETE http://127.0.0.1:7091/computers/container-1",
      "GET http://127.0.0.1:7091/computers/container-1",
    ]);
  });

  it("fails when the supervisor merges stderr into stdout", async () => {
    const { promise } = smoke({
      exec: (result) => ({ stdout: result.stdout + result.stderr, stderr: "", code: result.code }),
    });
    await expect(promise).rejects.toThrow(/stderr was merged into stdout/);
  });

  it("fails when the supervisor loses the exit code", async () => {
    const { promise } = smoke({ exec: (result) => ({ ...result, code: 0 }) });
    await expect(promise).rejects.toThrow(/exit code 0 instead of 7/);
  });

  it("destroys the computer even when the exec check fails", async () => {
    const { promise, supervisor } = smoke({ exec: (result) => ({ ...result, code: 0 }) });
    await expect(promise).rejects.toThrow();
    expect(supervisor.calls).toContain("DELETE http://127.0.0.1:7091/computers/container-1");
  });

  it("fails when a destroyed computer still answers", async () => {
    const { promise } = smoke({ inspectAfterDestroy: 200 });
    await expect(promise).rejects.toThrow(/still answers with 200/);
  });

  it("fails when docker still lists a container for the workspace", async () => {
    const { promise } = smoke({}, "quibt-ws-ws1 Up 3 seconds\n");
    await expect(promise).rejects.toThrow(/orphan containers left behind/);
  });
});
