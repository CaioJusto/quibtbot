import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_WORKSPACE_SESSIONS } from "./computer-spec.js";
import {
  allocateDisplay,
  assertExecArgv,
  containerUsesWorkspaceHome,
  createDockerStreamDemuxer,
  DEFAULT_DOCKER_SOCKET,
  dockerEndpointCandidates,
  dockerUnreachableMessage,
  execEnvEntries,
  explainContainerExit,
  HOME_MODE_REPAIR_COMMAND,
  HOME_REPAIR_COMMAND,
  HOME_WRITABLE_PROBE,
  hasLiveSessions,
  homeIsWritable,
  homePreparationMarker,
  isAuthorizedSupervisorRequest,
  isWorkspaceSentinel,
  novncEnsureCommand,
  parseNovncEnsure,
  parseSessionProbe,
  parseSessionStart,
  publicError,
  resolveDockerEndpoint,
  retryableOnce,
  SESSION_PROBE_COMMAND,
  SupervisorError,
  sandboxTimeoutCommand,
  sessionRuntimeDir,
  sessionUser,
  shouldRemoveSharedContainer,
  splitSentinelSessions,
  WORKSPACE_SESSION_SENTINEL,
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
    const { hardenDesktopRoot } = await import("./index.js");
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
    const { hardenDesktopRoot } = await import("./index.js");
    const dir = mkdtempSync(path.join(tmpdir(), "quibt-desk-link-"));
    const root = path.join(dir, "desktops");
    symlinkSync(dir, root);
    await expect(hardenDesktopRoot(root)).rejects.toThrow(/link/);
  });
});
