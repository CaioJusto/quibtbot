import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MAX_WORKSPACE_SESSIONS } from "./computer-spec.js";
import {
  allocateDisplay,
  allocateStableDisplay,
  applyStoppedContainerPolicy,
  assertExecArgv,
  COMPUTER_REVIVE_DOCKER_DOWN_MESSAGE,
  computerStoppedError,
  containerNeedsRestartPolicy,
  containerUsesWorkspaceHome,
  createDockerStreamDemuxer,
  DEFAULT_DOCKER_SOCKET,
  dockerDownError,
  dockerEndpointCandidates,
  dockerUnreachableMessage,
  execEnvEntries,
  explainContainerExit,
  explainReviveFailure,
  forgetWorkspaceMemory,
  HOME_MODE_REPAIR_COMMAND,
  HOME_REPAIR_COMMAND,
  HOME_WRITABLE_PROBE,
  hardenDesktopRoot,
  hasLiveSessions,
  homeIsWritable,
  homePreparationMarker,
  isAuthorizedSupervisorRequest,
  isDockerAlreadyStarted,
  isDockerNotFound,
  isDockerUnreachable,
  isWorkspaceSentinel,
  novncEnsureCommand,
  parseNovncEnsure,
  parseSessionProbe,
  parseSessionStart,
  publicError,
  type ReviveDocker,
  recordSessionDisplayCommand,
  resolveDockerEndpoint,
  retryableOnce,
  reviveStoppedContainer,
  SESSION_DISPLAY_RECORD_DIR,
  SESSION_PROBE_COMMAND,
  SESSION_RECORDED_PROBE_COMMAND,
  SupervisorError,
  sandboxTimeoutCommand,
  sessionRuntimeDir,
  sessionUser,
  shouldRemoveSharedContainer,
  splitSentinelSessions,
  WORKSPACE_SESSION_SENTINEL,
  type WorkspaceMemory,
  withGroupWritableUmask,
  withWorkspaceSessionLock,
} from "./supervisor-core.js";

describe("supervisor authorization", () => {
  it("accepts the configured token and rejects everything else without throwing", () => {
    const token = "s".repeat(48);
    expect(isAuthorizedSupervisorRequest(`Bearer ${token}`, token)).toBe(true);
    expect(isAuthorizedSupervisorRequest(`bearer ${token}`, token)).toBe(true);
    expect(isAuthorizedSupervisorRequest(`Bearer ${token}x`, token)).toBe(false);
    expect(isAuthorizedSupervisorRequest("Bearer short", token)).toBe(false);
    expect(isAuthorizedSupervisorRequest(undefined, token)).toBe(false);
    expect(isAuthorizedSupervisorRequest("Basic user:pass", token)).toBe(false);
    expect(isAuthorizedSupervisorRequest("Bearer ", token)).toBe(false);
  });

  it("never authorizes an empty configured token", () => {
    expect(isAuthorizedSupervisorRequest("Bearer ", "")).toBe(false);
    expect(isAuthorizedSupervisorRequest("Bearer x", "")).toBe(false);
  });

  it("compares digests so unicode tokens of different byte lengths are safe", () => {
    const token = "chave-supervisor-ção-32-caracteres!!";
    expect(isAuthorizedSupervisorRequest(`Bearer ${token}`, token)).toBe(true);
    expect(isAuthorizedSupervisorRequest("Bearer a", token)).toBe(false);
    expect(createHash("sha256").update(token).digest().length).toBe(32);
  });
});

describe("exec payload validation", () => {
  it("keeps the session display authoritative so a bot cannot drive a workspace mate's screen", () => {
    const entries = execEnvEntries({ DISPLAY: ":7", FOO: "bar" }, 3);
    expect(entries).toContain("DISPLAY=:3");
    expect(entries).toContain("XAUTHORITY=/run/quibt/sessions/3/Xauthority");
    expect(entries).not.toContain("DISPLAY=:7");
    expect(entries).toContain("FOO=bar");
    expect(entries.filter((entry) => entry.startsWith("DISPLAY=")).length).toBe(1);
  });

  it("assigns every graphical session a distinct uid and private runtime path", () => {
    expect(sessionUser(1)).toBe("10001:1000");
    expect(sessionUser(2)).toBe("10002:1000");
    expect(sessionRuntimeDir(2)).toBe("/run/quibt/sessions/2");
    expect(() => sessionUser(0)).toThrow(SupervisorError);
  });

  it("omits DISPLAY when the request has no session and rejects bad names", () => {
    expect(execEnvEntries(undefined, undefined).some((entry) => entry.startsWith("DISPLAY="))).toBe(
      false,
    );
    expect(() => execEnvEntries({ "A=B": "c" }, 1)).toThrow(SupervisorError);
    expect(() => execEnvEntries({ "": "c" }, 1)).toThrow(SupervisorError);
    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`VAR_${index}`, "x"] as const),
    );
    expect(() => execEnvEntries(many, 1)).toThrow(SupervisorError);
  });

  it("rejects NUL bytes in argv", () => {
    expect(assertExecArgv(["ls", "-la"])).toEqual(["ls", "-la"]);
    expect(() => assertExecArgv(["ls", "a\u0000b"])).toThrow(SupervisorError);
  });

  it("wraps sandbox commands in a process-tree timeout", () => {
    expect(sandboxTimeoutCommand(["bash", "-lc", "sleep 10"], 2_500)).toEqual([
      "/usr/bin/timeout",
      "--kill-after=1s",
      "2.5s",
      "bash",
      "-lc",
      "sleep 10",
    ]);
  });

  it("keeps new workspace files group-writable without interpolating command text", () => {
    expect(withGroupWritableUmask(["printf", "%s", "a;$(touch nope)"])).toEqual([
      "bash",
      "-lc",
      'umask 0002; exec "$@"',
      "quibt-exec",
      "printf",
      "%s",
      "a;$(touch nope)",
    ]);
  });
});

describe("workspace home preparation", () => {
  it("stores the privileged marker outside the sandbox-writable home", () => {
    expect(homePreparationMarker("/data/workspaces/ws-1/home")).toBe(
      "/data/workspaces/ws-1/.quibt-home-prepared",
    );
    expect(homePreparationMarker("/data/workspaces/ws-1/desktops", "desktops")).toBe(
      "/data/workspaces/ws-1/.quibt-desktops-prepared",
    );
  });
});

describe("shared container teardown", () => {
  it("skips container removal when preserveComputer is true", () => {
    expect(shouldRemoveSharedContainer(true, new Map())).toBe(false);
    expect(shouldRemoveSharedContainer(true, new Map([["bot-a", 1]]))).toBe(false);
  });

  it("removes the container only when preserveComputer is false and no sessions remain", () => {
    expect(shouldRemoveSharedContainer(false, new Map())).toBe(true);
    expect(shouldRemoveSharedContainer(false, undefined)).toBe(false);
    expect(shouldRemoveSharedContainer(false, new Map([["bot-b", 2]]))).toBe(false);
  });
});

describe("public errors", () => {
  it("returns supervisor errors verbatim and hides docker internals", () => {
    expect(publicError(new SupervisorError("session not found", 404))).toEqual({
      status: 404,
      message: "session not found",
    });
    expect(
      publicError(new Error("connect ENOENT /var/run/docker.sock (uid=0 /Users/op/data)")),
    ).toEqual({ status: 500, message: "computer request failed" });
  });

  it("carrega o código junto da mensagem, para o adapter saber o que dizer", () => {
    expect(publicError(dockerDownError())).toEqual({
      status: 503,
      message: expect.stringMatching(/abra o Docker/),
      code: "docker-down",
    });
    expect(publicError(computerStoppedError())).toEqual({
      status: 409,
      message: expect.stringMatching(/desligado/),
      code: "computer-stopped",
    });
    // Sem código, sem chave: o corpo antigo continua igual.
    expect(publicError(new SupervisorError("x", 404))).not.toHaveProperty("code");
  });
});

describe("erros do Docker", () => {
  it("separa 'não existe' de 'o daemon não respondeu'", () => {
    const notFound = Object.assign(new Error("(HTTP code 404) no such container"), {
      statusCode: 404,
    });
    const refused = Object.assign(new Error("connect ECONNREFUSED /var/run/docker.sock"), {
      code: "ECONNREFUSED",
    });
    const missingSocket = Object.assign(new Error("connect ENOENT ~/.colima/docker.sock"), {
      code: "ENOENT",
    });
    const hungUp = new Error("socket hang up");
    expect(isDockerNotFound(notFound)).toBe(true);
    expect(isDockerUnreachable(notFound)).toBe(false);
    for (const down of [refused, missingSocket, hungUp]) {
      expect(isDockerNotFound(down)).toBe(false);
      expect(isDockerUnreachable(down)).toBe(true);
    }
    expect(isDockerUnreachable(new Error("exec failed"))).toBe(false);
    expect(isDockerUnreachable(undefined)).toBe(false);
  });

  it("um start que perdeu a corrida (304) não é falha", () => {
    expect(
      isDockerAlreadyStarted(
        Object.assign(new Error("(HTTP code 304) container already started"), {
          statusCode: 304,
        }),
      ),
    ).toBe(true);
    expect(isDockerAlreadyStarted(new Error("boom"))).toBe(false);
  });
});

describe("religar um container parado", () => {
  it("com o Docker fora, diz para abrir o Docker e mantém o código", () => {
    const error = explainReviveFailure(dockerDownError());
    expect(error.code).toBe("docker-down");
    expect(error.status).toBe(503);
    expect(error.message).toBe(COMPUTER_REVIVE_DOCKER_DOWN_MESSAGE);
  });

  it("noutra falha, conta o motivo do start e marca computer-stopped", () => {
    const error = explainReviveFailure(explainContainerExit(255, "eagain"));
    expect(error.code).toBe("computer-stopped");
    expect(error.message).toMatch(/^O computador estava desligado e não conseguiu religar\./);
    expect(error.message).toMatch(/EAGAIN/);
    // Erro cru do Docker não vaza caminho de socket nenhum.
    const raw = explainReviveFailure(new Error("connect /Users/op/.colima/docker.sock"));
    expect(raw.message).toBe("O computador estava desligado e não conseguiu religar.");
  });

  it("só containers antigos precisam ganhar a política de reinício", () => {
    expect(containerNeedsRestartPolicy({ HostConfig: { RestartPolicy: { Name: "no" } } })).toBe(
      true,
    );
    expect(containerNeedsRestartPolicy({ HostConfig: {} })).toBe(true);
    expect(containerNeedsRestartPolicy({})).toBe(true);
    expect(
      containerNeedsRestartPolicy({ HostConfig: { RestartPolicy: { Name: "unless-stopped" } } }),
    ).toBe(false);
  });
});

describe("session probe", () => {
  it("lists live sessions from the container instead of trusting process memory", () => {
    expect(SESSION_PROBE_COMMAND[0]).toBe("bash");
    expect(SESSION_PROBE_COMMAND[2]).toContain("session.pid");
    const probe = parseSessionProbe("bot-a 1\nbot-b 4\n\nbroken\nbot-c 999\n");
    expect([...probe]).toEqual([
      ["bot-a", 1],
      ["bot-b", 4],
    ]);
  });

  it("treats a failed probe as busy so a live workspace container is never destroyed", () => {
    expect(hasLiveSessions(undefined)).toBe(true);
    expect(hasLiveSessions(new Map([["bot-a", 1]]))).toBe(true);
    expect(hasLiveSessions(new Map())).toBe(false);
  });
});

describe("novnc ensure", () => {
  it("probes embed.html inside the container and restarts websockify when it is dead", () => {
    const command = novncEnsureCommand("bot-a_1");
    expect(command[0]).toBe("bash");
    expect(command[2]).toContain("/quibt-desktops/bot-a_1");
    expect(command[2]).toContain("/embed.html");
    expect(command[2]).toContain("websockify");
    expect(command[2]).toContain("repaired");
    expect(command[2]).not.toMatch(/[;&|]\s*rm/);
  });

  it("refuses a bot id that could break out of the shell path", () => {
    expect(() => novncEnsureCommand("bot; rm -rf /")).toThrow(SupervisorError);
    expect(() => novncEnsureCommand("../other")).toThrow(SupervisorError);
    expect(() => novncEnsureCommand("")).toThrow(SupervisorError);
  });

  it("reads the container's healthy/repaired/broken verdict", () => {
    expect(parseNovncEnsure("healthy\n")).toBe("healthy");
    expect(parseNovncEnsure("repaired\n")).toBe("repaired");
    expect(parseNovncEnsure("broken\n")).toBe("broken");
    expect(parseNovncEnsure("")).toBe("broken");
  });
});

describe("parseSessionStart", () => {
  it("takes the display the container reports for a fresh session", () => {
    expect(parseSessionStart("started display=3 novnc=6082 cdp=9224\n", 3)).toBe(3);
  });

  it("believes the live session over the display the supervisor asked for", () => {
    // `quibt-session start bot 5` on a bot already running on 3 answers with 3. Trusting the
    // request instead published a screen URL for display 5, a port this bot never serves.
    expect(parseSessionStart("already-running display=3\n", 5)).toBe(3);
  });

  it("falls back to the requested display when the answer says nothing usable", () => {
    expect(parseSessionStart("already-running", 4)).toBe(4);
    expect(parseSessionStart("started display=0", 4)).toBe(4);
    expect(parseSessionStart(`started display=${MAX_WORKSPACE_SESSIONS + 1}`, 4)).toBe(4);
    expect(parseSessionStart("", 4)).toBe(4);
  });
});

describe("display allocation", () => {
  it("never hands a display that another bot already runs on", () => {
    const used = new Map([
      ["bot-a", 1],
      ["bot-b", 2],
    ]);
    expect(allocateDisplay(used, "bot-c")).toBe(3);
    expect(allocateDisplay(used, "bot-a")).toBe(1);
    expect(allocateDisplay(used, "bot-a", 9)).toBe(1);
    expect(() => allocateDisplay(used, "bot-c", 2)).toThrow(/already assigned/);
    expect(() => allocateDisplay(used, "bot-c", -1)).toThrow(SupervisorError);
    expect(() => allocateDisplay(used, "bot-c", MAX_WORKSPACE_SESSIONS + 1)).toThrow(
      SupervisorError,
    );
  });

  it("fills gaps and refuses to overflow the workspace", () => {
    expect(allocateDisplay(new Map([["bot-a", 2]]), "bot-b")).toBe(1);
    const full = new Map(
      Array.from({ length: MAX_WORKSPACE_SESSIONS }, (_, index) => [`bot-${index}`, index + 1]),
    );
    expect(() => allocateDisplay(full, "extra")).toThrow(/no free graphical sessions/);
  });
});

describe("retryableOnce", () => {
  it("caches success once but retries after a failure", async () => {
    let calls = 0;
    const step = retryableOnce(async () => {
      calls += 1;
      if (calls === 1) throw new Error("build failed");
      return calls;
    });
    await expect(step()).rejects.toThrow("build failed");
    expect(await step()).toBe(2);
    expect(await step()).toBe(2);
    expect(calls).toBe(2);
  });
});

describe("docker exec stream demultiplexing", () => {
  function frame(type: number, payload: string | Buffer) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  }

  it("keeps stderr apart from stdout instead of merging both into stdout", () => {
    const demuxer = createDockerStreamDemuxer();
    demuxer.push(frame(1, "hello\n"));
    demuxer.push(frame(2, "bash: nope: command not found\n"));
    demuxer.push(frame(1, "bye\n"));
    const result = demuxer.end();
    expect(result.stdout).toBe("hello\nbye\n");
    expect(result.stderr).toBe("bash: nope: command not found\n");
    expect(result.truncated).toBe(false);
  });

  it("gives the agent the error text of a command that only writes to stderr", () => {
    const demuxer = createDockerStreamDemuxer();
    demuxer.push(frame(2, "permission denied"));
    const result = demuxer.end();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("permission denied");
  });

  it("reassembles frames split across chunks, in the header and in the payload", () => {
    const stream = Buffer.concat([frame(1, "abc"), frame(2, "err"), frame(1, "def")]);
    for (const cut of [1, 3, 8, 9, 11, 14, 20]) {
      const demuxer = createDockerStreamDemuxer();
      demuxer.push(stream.subarray(0, cut));
      demuxer.push(stream.subarray(cut));
      const result = demuxer.end();
      expect(result.stdout).toBe("abcdef");
      expect(result.stderr).toBe("err");
    }
  });

  it("decodes once so a multi-byte character split across frames is not corrupted", () => {
    const bytes = Buffer.from("ação", "utf8");
    const demuxer = createDockerStreamDemuxer();
    demuxer.push(frame(1, bytes.subarray(0, 2)));
    demuxer.push(frame(1, bytes.subarray(2)));
    expect(demuxer.end().stdout).toBe("ação");
  });

  it("falls back to raw output when the stream is not framed (TTY)", () => {
    const demuxer = createDockerStreamDemuxer();
    demuxer.push(Buffer.from("plain "));
    demuxer.push(Buffer.from("output"));
    const result = demuxer.end();
    expect(result.stdout).toBe("plain output");
    expect(result.stderr).toBe("");
  });

  it("caps stdout and stderr together and reports truncation", () => {
    const demuxer = createDockerStreamDemuxer(10);
    demuxer.push(frame(1, "12345"));
    demuxer.push(frame(2, "abcdefgh"));
    demuxer.push(frame(1, "ignored"));
    const result = demuxer.end();
    expect(result.stdout).toBe("12345");
    expect(result.stderr).toBe("abcde");
    expect(result.truncated).toBe(true);
  });
});

describe("resolveDockerEndpoint", () => {
  const noSockets = () => false;

  it("honours DOCKER_HOST first, in unix and tcp form", () => {
    expect(
      resolveDockerEndpoint(
        { DOCKER_HOST: "unix:///Users/me/.colima/default/docker.sock" },
        noSockets,
      ),
    ).toEqual({
      source: "DOCKER_HOST",
      description: "unix:///Users/me/.colima/default/docker.sock",
      options: { socketPath: "/Users/me/.colima/default/docker.sock" },
    });
    expect(resolveDockerEndpoint({ DOCKER_HOST: "tcp://10.0.0.5:2375" }, noSockets)).toEqual({
      source: "DOCKER_HOST",
      description: "tcp://10.0.0.5:2375",
      options: { host: "10.0.0.5", port: 2375, protocol: "http" },
    });
    expect(
      resolveDockerEndpoint({ DOCKER_HOST: "https://docker.internal" }, noSockets).options,
    ).toEqual({ host: "docker.internal", port: 2376, protocol: "https" });
  });

  it("keeps DOCKER_SOCKET working, but below DOCKER_HOST", () => {
    expect(resolveDockerEndpoint({ DOCKER_SOCKET: "/tmp/docker.sock" }, noSockets).options).toEqual(
      {
        socketPath: "/tmp/docker.sock",
      },
    );
    expect(
      resolveDockerEndpoint(
        {
          DOCKER_HOST: "unix:///from-host.sock",
          DOCKER_SOCKET: "/from-socket.sock",
        },
        noSockets,
      ).options,
    ).toEqual({ socketPath: "/from-host.sock" });
  });

  it("finds the socket a Mac really has when nothing is configured", () => {
    const home = "/Users/me";
    const desktop = `${home}/.docker/run/docker.sock`;
    const endpoint = resolveDockerEndpoint({ HOME: home }, (path) => path === desktop);
    expect(endpoint).toEqual({
      source: "auto",
      description: `unix://${desktop}`,
      options: { socketPath: desktop },
    });
    const colima = `${home}/.colima/default/docker.sock`;
    expect(resolveDockerEndpoint({ HOME: home }, (path) => path === colima).options).toEqual({
      socketPath: colima,
    });
  });

  it("offers every socket that exists, so a stale file cannot hide a live daemon", () => {
    const home = "/Users/me";
    // Docker Desktop left its socket behind and Colima is the one actually running.
    const endpoints = dockerEndpointCandidates({ HOME: home }, (path) => path.startsWith(home));
    expect(endpoints.map((endpoint) => endpoint.description)).toEqual([
      `unix://${home}/.docker/run/docker.sock`,
      `unix://${home}/.colima/default/docker.sock`,
      `unix://${home}/.rd/docker.sock`,
    ]);
  });

  it("does not look further once an endpoint is configured", () => {
    expect(
      dockerEndpointCandidates({ DOCKER_HOST: "tcp://h:1", HOME: "/Users/me" }, () => true),
    ).toHaveLength(1);
    expect(
      dockerEndpointCandidates({ DOCKER_SOCKET: "/s.sock", HOME: "/Users/me" }, () => true),
    ).toHaveLength(1);
  });

  it("prefers the standard socket when it exists", () => {
    expect(resolveDockerEndpoint({ HOME: "/Users/me" }, () => true).options).toEqual({
      socketPath: DEFAULT_DOCKER_SOCKET,
    });
  });

  it("falls back to the standard path so the error names something concrete", () => {
    expect(resolveDockerEndpoint({ HOME: "/Users/me" }, noSockets).options).toEqual({
      socketPath: DEFAULT_DOCKER_SOCKET,
    });
  });

  it("refuses an endpoint it cannot honour instead of silently using the default", () => {
    expect(() =>
      resolveDockerEndpoint({ DOCKER_HOST: "npipe:////./pipe/docker_engine" }, noSockets),
    ).toThrow(/not a Docker endpoint/);
    expect(() => resolveDockerEndpoint({ DOCKER_HOST: "nonsense" }, noSockets)).toThrow(
      /DOCKER_HOST/,
    );
  });
});

describe("dockerUnreachableMessage", () => {
  it("names the endpoint, what was tried, and the way out", () => {
    const env = { HOME: "/Users/me" };
    const endpoint = resolveDockerEndpoint(env, () => false);
    const message = dockerUnreachableMessage(endpoint, env, new Error("ENOENT"));
    expect(message).toContain(DEFAULT_DOCKER_SOCKET);
    expect(message).toContain("ENOENT");
    expect(message).toContain("/Users/me/.colima/default/docker.sock");
    expect(message).toContain("DOCKER_HOST");
  });
});

describe("workspace home permissions", () => {
  // A supervisor that is not root cannot chown the bind mount, which is every macOS install:
  // the container then fails to create ~/.local and the session dies as "framebuffer failed".
  it("reads the probe verdict and never guesses writable", () => {
    expect(homeIsWritable("writable\n")).toBe(true);
    expect(homeIsWritable("blocked\n")).toBe(false);
    expect(homeIsWritable("")).toBe(false);
    expect(homeIsWritable("mkdir: cannot create directory")).toBe(false);
  });

  it("probes as the container user and repairs to the uid the image runs as", () => {
    expect(HOME_WRITABLE_PROBE[2]).toContain("/home/quibt");
    // The image declares `USER quibt` with uid 1000; repairing to anything else keeps it broken.
    expect(HOME_REPAIR_COMMAND).toEqual(["chown", "-R", "1000:1000", "/home/quibt"]);
    // Docker Desktop can reject chown on bind mounts even for root; mode repair is the fallback.
    expect(HOME_MODE_REPAIR_COMMAND).toEqual(["chmod", "-R", "a+rwX", "/home/quibt"]);
  });

  it("rejects a same-labelled container mounted from another checkout", () => {
    const expected = "/Users/me/quibt/data/workspaces/team/home";
    const desktops = "/Users/me/quibt/data/workspaces/team/desktops";
    expect(
      containerUsesWorkspaceHome(
        [
          { Source: expected, Destination: "/home/quibt", RW: true },
          { Source: expected, Destination: "/workspace", RW: true },
          { Source: desktops, Destination: "/quibt-desktops", RW: true },
        ],
        expected,
        desktops,
      ),
    ).toBe(true);
    expect(
      containerUsesWorkspaceHome(
        [
          { Source: "/tmp/other/home", Destination: "/home/quibt", RW: true },
          { Source: "/tmp/other/home", Destination: "/workspace", RW: true },
        ],
        expected,
        desktops,
      ),
    ).toBe(false);
    expect(
      containerUsesWorkspaceHome(
        [
          { Source: expected, Destination: "/home/quibt", RW: true },
          { Source: expected, Destination: "/workspace", RW: true },
        ],
        expected,
        desktops,
      ),
    ).toBe(false);
  });
});

describe("workspace sentinel", () => {
  it("separa ligar o computador do workspace de abrir a tela de um bot", () => {
    expect(isWorkspaceSentinel(WORKSPACE_SESSION_SENTINEL)).toBe(true);
    expect(isWorkspaceSentinel("workspace")).toBe(true);
    // Ids de bot são cuids: nenhum bot real cai no sentinela.
    expect(isWorkspaceSentinel("cmsz2ued8000k0zp8jm6cwva1")).toBe(false);
    expect(isWorkspaceSentinel("workspace-2")).toBe(false);
  });
});

describe("splitSentinelSessions", () => {
  it("separa a tela órfã do sentinela das telas de bots de verdade", () => {
    const { sessions, sentinels } = splitSentinelSessions([
      ["workspace", 1],
      ["cmsz2ued8000k0zp8jm6cwva1", 2],
    ]);
    expect(sessions).toEqual([["cmsz2ued8000k0zp8jm6cwva1", 2]]);
    expect(sentinels).toEqual(["workspace"]);
  });

  it("sem sentinela, não mexe em nada", () => {
    const probed: Array<[string, number]> = [["bot-a", 1]];
    expect(splitSentinelSessions(probed)).toEqual({
      sessions: probed,
      sentinels: [],
    });
  });
});

describe("fila de sessões por workspace", () => {
  it("serializa chamadas do mesmo workspace e deixa workspaces diferentes em paralelo", async () => {
    const running: string[] = [];
    let peak = 0;
    let active = 0;
    const task = (workspaceId: string, label: string) =>
      withWorkspaceSessionLock(workspaceId, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running.push(label);
        active -= 1;
        return label;
      });
    const results = await Promise.all([task("w1", "a"), task("w1", "b"), task("w1", "c")]);
    expect(results).toEqual(["a", "b", "c"]);
    // Nada de dois `quibt-session start` do mesmo workspace ao mesmo tempo.
    expect(peak).toBe(1);
    expect(running).toEqual(["a", "b", "c"]);
  });

  it("uma falha não trava a fila nem contamina a próxima chamada", async () => {
    await expect(
      withWorkspaceSessionLock("w2", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withWorkspaceSessionLock("w2", async () => "ok")).resolves.toBe("ok");
  });
});

describe("container exit", () => {
  it("names EAGAIN instead of a generic supervisor failure", () => {
    const error = explainContainerExit(
      255,
      "exec /usr/local/bin/quibt-computer: resource temporarily unavailable",
    );
    expect(error.status).toBe(500);
    expect(error.message).toMatch(/EAGAIN|RLIMIT_NPROC/);
  });

  it("keeps the last log lines when the exit is unknown", () => {
    const error = explainContainerExit(1, "fluxbox: cannot open display\nnovnc failed");
    expect(error.message).toContain("novnc failed");
    expect(error.message).toContain("código 1");
  });
});

describe("hardenDesktopRoot", () => {
  it("cria a raiz dos desktops e garante 1777, relendo o modo", async () => {
    const { mkdtempSync, lstatSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = path.join(mkdtempSync(path.join(tmpdir(), "quibt-desk-")), "desktops");
    await hardenDesktopRoot(root);
    expect((lstatSync(root).mode & 0o7777).toString(8)).toBe("1777");
    // Idempotente: rodar de novo não muda nada nem lança.
    await hardenDesktopRoot(root);
    expect((lstatSync(root).mode & 0o7777).toString(8)).toBe("1777");
  });

  it("recusa uma raiz que virou link simbólico", async () => {
    const { mkdtempSync, symlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "quibt-desk-link-"));
    const root = path.join(dir, "desktops");
    symlinkSync(dir, root);
    await expect(hardenDesktopRoot(root)).rejects.toThrow(/link/);
  });
});

describe("display estável por bot depois de religar", () => {
  it("depois do reboot cada bot volta ao display que está gravado no disco dele", () => {
    // Reboot: o container voltou pelo `unless-stopped`, nenhum Xvfb vivo, memória vazia.
    // O disco ainda lembra quem tinha o quê — e é isso que decide, não quem acorda antes.
    const recorded = new Map([
      ["bot-a", 1],
      ["bot-b", 2],
    ]);
    const used = new Map<string, number>();

    const forB = allocateStableDisplay(used, "bot-b", { recorded });
    expect(forB).toBe(2);
    used.set("bot-b", forB);
    // Sem isto, B levava o display 1 e o `chmod 700` de /quibt-desktops/bot-b falhava com
    // o uid do bot A: nenhum dos dois voltava a ter tela.
    expect(allocateStableDisplay(used, "bot-a", { recorded })).toBe(1);
  });

  it("um bot novo não ocupa o display reservado de quem está fora do ar", () => {
    const recorded = new Map([["bot-a", 1]]);
    expect(allocateStableDisplay(new Map(), "bot-novo", { recorded })).toBe(2);
  });

  it("o preferido do banco vale mais que o gravado, e cede a quem está vivo", () => {
    const recorded = new Map([["bot-b", 3]]);
    expect(allocateStableDisplay(new Map(), "bot-b", { preferred: 5, recorded })).toBe(5);
    // Display 5 ocupado por um bot vivo: preferência não rouba, só pede.
    const used = new Map([["bot-a", 5]]);
    expect(allocateStableDisplay(used, "bot-b", { preferred: 5, recorded })).toBe(3);
  });

  it("sessão viva manda: o mapa em memória vence disco e preferência", () => {
    const used = new Map([["bot-b", 7]]);
    expect(
      allocateStableDisplay(used, "bot-b", { preferred: 2, recorded: new Map([["bot-b", 4]]) }),
    ).toBe(7);
  });

  it("o pedido explícito do provision continua firme, com 409 quando está ocupado", () => {
    const used = new Map([["bot-a", 2]]);
    expect(allocateStableDisplay(used, "bot-b", { requested: 4 })).toBe(4);
    expect(() => allocateStableDisplay(used, "bot-b", { requested: 2 })).toThrow(SupervisorError);
  });

  it("com todos os displays reservados por sessões mortas, ainda entrega um", () => {
    const recorded = new Map(
      Array.from({ length: MAX_WORKSPACE_SESSIONS }, (_, i) => [`morto-${i}`, i + 1] as const),
    );
    expect(allocateStableDisplay(new Map(), "bot-novo", { recorded })).toBe(1);
  });

  it("a lembrança mora fora da pasta 700 do bot, senão ninguém a lê", () => {
    // `CapDrop: ALL`: dentro do container nem o root atravessa modo de arquivo, então
    // `/quibt-desktops/<bot>/display` é ilegível para todo mundo menos o dono da sessão.
    expect(SESSION_DISPLAY_RECORD_DIR).toBe("/quibt-desktops/.displays");
    const script = SESSION_RECORDED_PROBE_COMMAND[2] ?? "";
    expect(SESSION_RECORDED_PROBE_COMMAND[0]).toBe("bash");
    expect(script).toContain(SESSION_DISPLAY_RECORD_DIR);
    // Ao contrário do probe de sessões vivas, este não olha `session.pid`.
    expect(script).not.toContain("session.pid");
    // O ponto no nome esconde a pasta do glob `*/` que procura sessões vivas.
    expect(SESSION_PROBE_COMMAND[2] ?? "").toContain("/quibt-desktops/*/");
    expect(parseSessionProbe("bot-a 1\nbot-b 2\n")).toEqual(
      new Map([
        ["bot-a", 1],
        ["bot-b", 2],
      ]),
    );
  });

  it("grava o display sem deixar o id do bot virar shell", () => {
    const command = recordSessionDisplayCommand("bot-b", 2);
    expect(command.slice(-2)).toEqual(["bot-b", "2"]);
    // Interpolado como argumento posicional, nunca dentro do texto do script.
    expect(command[2]).not.toContain("bot-b");
    expect(command[2]).toContain(`dir="${SESSION_DISPLAY_RECORD_DIR}"`);
    expect(command[2]).toContain('"$dir/$1"');
    // Um bot que deixasse um link no lugar faria o root escrever do outro lado dele.
    expect(command[2]).toContain('test ! -L "$dir"');
    expect(() => recordSessionDisplayCommand("bot b; rm -rf /", 2)).toThrow(SupervisorError);
    expect(() => recordSessionDisplayCommand("bot-b", 0)).toThrow(SupervisorError);
  });
});

describe("religar um container parado", () => {
  function memory(): WorkspaceMemory {
    return {
      sessions: new Map([["ws-1:bot-a", { containerId: "c1", workspaceId: "ws-1" }]]),
      workspaceBoxes: new Map([["ws-1", { containerId: "c1", displays: new Map([["bot-a", 1]]) }]]),
    };
  }

  function fakeDocker(options: { startFails?: unknown } = {}) {
    const state = { running: false, verified: 0 };
    const info = (running: boolean) => ({ State: { Running: running, Status: "exited" } });
    const start = vi.fn(async () => {
      if (options.startFails) throw options.startFails;
      // O `start` de verdade demora; sem o await o teste não veria a corrida.
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.running = true;
      return info(true);
    });
    const docker: ReviveDocker<{ State: { Running: boolean; Status?: string } }> = {
      id: "container-workspace",
      inspect: async () => info(state.running),
      start,
      verify: async () => {
        state.verified += 1;
      },
    };
    return { docker, start, state };
  }

  it("dois revives ao mesmo tempo dão um único start", async () => {
    const { docker, start } = fakeDocker();
    const mem = memory();

    const [first, second] = await Promise.all([
      reviveStoppedContainer(docker, "ws-race", mem),
      reviveStoppedContainer(docker, "ws-race", mem),
    ]);

    expect(start).toHaveBeenCalledTimes(1);
    expect([first?.revived, second?.revived].filter(Boolean)).toHaveLength(1);
    expect(first?.info.State.Running).toBe(true);
    expect(second?.info.State.Running).toBe(true);
  });

  it("religar esquece a memória daquela caixa e reconfere o container", async () => {
    const { docker, state } = fakeDocker();
    const mem = memory();

    const result = await reviveStoppedContainer(docker, "ws-1", mem);

    expect(result.revived).toBe(true);
    // Displays e telas guardados morreram com o container: mantê-los devolvia depois a
    // URL de um Xvfb que já não existe.
    expect(mem.workspaceBoxes.size).toBe(0);
    expect(mem.sessions.size).toBe(0);
    // `/run` é tmpfs: as conferências do provision valem de novo.
    expect(state.verified).toBe(1);
  });

  it("com o Docker fora, o start vira 503 'abra o Docker', não um ECONNREFUSED cru", async () => {
    const { docker } = fakeDocker({
      startFails: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
    });

    const failure = await reviveStoppedContainer(docker, "ws-2", memory()).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SupervisorError);
    expect((failure as SupervisorError).status).toBe(503);
    expect((failure as SupervisorError).code).toBe("docker-down");
    expect((failure as Error).message).toBe(COMPUTER_REVIVE_DOCKER_DOWN_MESSAGE);
  });

  it("um container que já subiu não é religado de novo", async () => {
    const { docker, start, state } = fakeDocker();
    state.running = true;
    const mem = memory();

    const result = await reviveStoppedContainer(docker, "ws-1", mem);

    expect(result.revived).toBe(false);
    expect(start).not.toHaveBeenCalled();
    // Nada morreu, nada é esquecido.
    expect(mem.sessions.size).toBe(1);
  });
});

describe("política de container parado", () => {
  const memory = (): WorkspaceMemory => ({
    sessions: new Map([["ws-1:bot-a", { containerId: "c1", workspaceId: "ws-1" }]]),
    workspaceBoxes: new Map([["ws-1", { containerId: "c1", displays: new Map() }]]),
  });
  const stopped = { State: { Running: false, Status: "exited" } };
  const docker = (start: () => Promise<typeof stopped>): ReviveDocker<typeof stopped> => ({
    id: "c1",
    inspect: async () => stopped,
    start,
    verify: async () => undefined,
  });

  it("`allow` devolve o container como está, sem ligar nada", async () => {
    const start = vi.fn(async () => stopped);
    const mem = memory();

    const decided = await applyStoppedContainerPolicy("allow", docker(start), stopped, "ws-1", mem);

    expect(start).not.toHaveBeenCalled();
    expect(decided).toMatchObject({ halted: true, revived: false });
    // Quem só quer parar ou apagar não deve continuar com a memória de antes de parar.
    expect(mem.sessions.size).toBe(0);
  });

  it("`reject` recusa com 409 e o código que o adapter lê", async () => {
    const failure = await applyStoppedContainerPolicy(
      "reject",
      docker(async () => stopped),
      stopped,
      "ws-1",
      memory(),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SupervisorError);
    expect((failure as SupervisorError).status).toBe(409);
    expect((failure as SupervisorError).code).toBe("computer-stopped");
  });

  it("`revive` liga e segue", async () => {
    const running = { State: { Running: true, Status: "running" } };
    const start = vi.fn(async () => running);
    const decided = await applyStoppedContainerPolicy(
      "revive",
      docker(start) as ReviveDocker<typeof stopped>,
      stopped,
      "ws-1",
      memory(),
    );

    expect(start).toHaveBeenCalledTimes(1);
    expect(decided).toMatchObject({ halted: false, revived: true });
  });
});

describe("forgetWorkspaceMemory", () => {
  it("apaga as sessões do workspace e as do container, e nada mais", () => {
    const mem: WorkspaceMemory = {
      sessions: new Map([
        ["ws-1:bot-a", { containerId: "c1", workspaceId: "ws-1" }],
        ["ws-2:bot-b", { containerId: "c1", workspaceId: "ws-2" }],
        ["ws-3:bot-c", { containerId: "c9", workspaceId: "ws-3" }],
      ]),
      workspaceBoxes: new Map([
        ["ws-1", { containerId: "c1", displays: new Map() }],
        ["ws-3", { containerId: "c9", displays: new Map() }],
      ]),
    };

    forgetWorkspaceMemory(mem, "ws-1", "c1");

    expect([...mem.sessions.keys()]).toEqual(["ws-3:bot-c"]);
    expect([...mem.workspaceBoxes.keys()]).toEqual(["ws-3"]);
  });
});
