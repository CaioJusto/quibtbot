import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  chown,
  cp,
  lchown,
  lstat,
  mkdir,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { boundedSandboxCommandTimeoutMs, resolveSupervisorToken } from "@quibt/core";
import Docker from "dockerode";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  COMPUTER_IMAGE,
  containerCreateOptions,
  containerNameForWorkspace,
  MAX_WORKSPACE_SESSIONS,
  type SandboxInput,
  screenUrlFor,
  sessionPorts,
  workspaceDesktopPath,
  workspaceHomePath,
  xdotoolCommand,
} from "./computer-spec.js";
import {
  allocateDisplay,
  assertExecArgv,
  containerUsesWorkspaceHome,
  createDockerStreamDemuxer,
  type DockerEndpoint,
  dockerEndpointCandidates,
  dockerUnreachableMessage,
  execEnvEntries,
  explainContainerExit,
  HOME_MODE_REPAIR_COMMAND,
  HOME_NOT_WRITABLE_MESSAGE,
  HOME_REPAIR_COMMAND,
  HOME_WRITABLE_PROBE,
  homeIsWritable,
  homePreparationMarker,
  isAuthorizedSupervisorRequest,
  isWorkspaceSentinel,
  MAX_EXEC_OUTPUT_BYTES,
  novncEnsureCommand,
  parseNovncEnsure,
  parseSessionProbe,
  parseSessionStart,
  publicError,
  retryableOnce,
  SESSION_PROBE_COMMAND,
  SupervisorError,
  sandboxTimeoutCommand,
  sessionRuntimeDir,
  sessionUser,
  shouldRemoveSharedContainer,
  splitSentinelSessions,
  withGroupWritableUmask,
  withWorkspaceSessionLock,
} from "./supervisor-core.js";

loadRootEnv();

// A Mac can have several stale socket files at once, so the endpoint is the first one that
// answers, not the first one that exists.
const { docker, dockerEndpoint } = await connectDocker();
const computerContext =
  process.env.QUIBT_COMPUTER_CONTEXT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../computer");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = path.resolve(repositoryRoot, process.env.DATA_DIR ?? "./data");
const sessions = new Map<
  string,
  {
    containerId: string;
    workspaceId: string;
    botId: string;
    display: number;
    screenUrl: string;
  }
>();
const workspaceBoxes = new Map<string, { containerId: string; displays: Map<string, number> }>();
const ensureComputerImage = retryableOnce(buildComputerImage);
let supervisorInfo: Docker.ContainerInspectInfo | undefined;
const supervisorToken = resolveSupervisorToken(process.env);

const app = new Hono();

/**
 * A supervisor that cannot talk to Docker is not healthy: it used to answer `{ok:true}`
 * without ever having reached the daemon, so orchestration believed the computer service
 * was fine while every provision failed.
 */
app.get("/health", async (c) => {
  const daemon = await pingDocker();
  return c.json(
    {
      ok: daemon.ok,
      image: COMPUTER_IMAGE,
      model: "workspace",
      docker: {
        ok: daemon.ok,
        endpoint: dockerEndpoint.description,
        ...(daemon.error ? { error: daemon.error } : {}),
      },
    },
    daemon.ok ? 200 : 503,
  );
});

app.use("/computers", async (c, next) => {
  if (!hasValidSupervisorToken(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
app.use("/computers/*", async (c, next) => {
  if (!hasValidSupervisorToken(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

const createComputerSchema = z.object({
  botId: z.string().min(1).max(200),
  homePath: z.string().min(1).max(4_096),
  workspaceId: z.string().min(1).max(200),
  display: z.number().int().min(1).max(MAX_WORKSPACE_SESSIONS).optional(),
});

app.post("/computers", async (c) => {
  try {
    const body = createComputerSchema.parse(await readJson(c.req.raw));
    assertRequestIdentity(c.req.header("x-quibt-bot-id"), c.req.header("x-quibt-workspace-id"), {
      botId: body.botId,
      workspaceId: body.workspaceId,
    });
    await ensureComputerImage();
    const runtimeInfo = await inspectSupervisorContainer();
    const networkMode = await computerNetworkMode(body.workspaceId, runtimeInfo);
    const serviceHomePath = workspaceHomePath(dataDir, body.workspaceId);
    const serviceDesktopPath = workspaceDesktopPath(dataDir, body.workspaceId);
    await mkdir(serviceHomePath, { recursive: true });
    await seedWorkspaceHome(body.botId, serviceHomePath);
    await prepareWorkspaceDesktopStorage(serviceHomePath, serviceDesktopPath);
    await chownWorkspaceTree(serviceHomePath);
    await chownWorkspaceTree(serviceDesktopPath, "desktops");
    // Depois do chown geral: a raiz dos desktops tem de terminar 1777 (sticky, como
    // /tmp) para cada sessão criar o próprio desktop com o uid dela. Falha alto se o
    // modo não ficar — antes o erro era engolido e a tela morria só ao assumir o controle.
    await hardenDesktopRoot(serviceDesktopPath);
    const homePath = hostHomePath(serviceHomePath, runtimeInfo);
    const desktopPath = hostHomePath(serviceDesktopPath, runtimeInfo);
    const existing = await findWorkspaceContainer(body.workspaceId);
    let container = existing;
    let resumed = Boolean(existing);
    if (existing) {
      const info = await existing.inspect();
      const desired = await docker.getImage(COMPUTER_IMAGE).inspect();
      if (
        info.Image !== desired.Id ||
        (networkMode && info.HostConfig.NetworkMode !== networkMode) ||
        !containerUsesWorkspaceHome(info.Mounts, homePath, desktopPath)
      ) {
        await existing.remove({ force: true }).catch(() => undefined);
        forgetWorkspace(body.workspaceId, existing.id);
        container = undefined;
        resumed = false;
      } else if (!info.State.Running) {
        await startWorkspaceContainer(existing);
      }
    }
    if (!container) {
      // O container vai nascer agora; qualquer sessão ainda em memória é de um que já
      // não existe (removido por fora, Docker reiniciado). Deixá-la aí fazia o start
      // da sessão devolver a entrada velha e o bot ficar sem Xvfb no container novo.
      forgetWorkspace(body.workspaceId, existing?.id ?? "");
      await removeLegacyBotContainers(body.workspaceId);
      const name = containerNameForWorkspace(body.workspaceId);
      container = await docker.createContainer(
        containerCreateOptions({
          name,
          image: COMPUTER_IMAGE,
          workspaceId: body.workspaceId,
          homePath,
          desktopPath,
          networkMode,
        }),
      );
      await startWorkspaceContainer(container);
    }
    await ensureHomeWritable(container);
    await ensureSharedHomePermissions(container);
    await assertPrivateDesktopRoot(container);
    // Ligar o computador do workspace não é abrir uma tela: o id sentinela pedia um
    // Xvfb + Chromium que ninguém olha e que ainda ocupava o display 1 de um bot.
    if (isWorkspaceSentinel(body.botId)) {
      return c.json({ id: container.id, image: COMPUTER_IMAGE, resumed });
    }
    const session = await ensureBotSession(container, body.botId, body.workspaceId, body.display);
    return c.json({
      id: container.id,
      image: COMPUTER_IMAGE,
      screenUrl: session.screenUrl,
      resumed,
      display: session.display,
    });
  } catch (error) {
    return failure(c, error, "provision");
  }
});

/**
 * Existir não é ter tela. O boot precisa saber se o container ainda está lá — depois de
 * uma imagem nova, um `docker rm` ou um Docker reiniciado — e nesse momento não há bot
 * nenhum pedindo sessão. A rota da tela exige identidade de bot e respondia 403 a esta
 * pergunta; o chamador lia "403 não é 404" como "ainda existe" e o app entregava a URL
 * de uma tela que não existe mais. Aqui basta ser o dono do workspace.
 */
app.get("/computers/:id/exists", async (c) => {
  const workspaceId = c.req.header("x-quibt-workspace-id");
  if (!workspaceId) return c.json({ error: "missing computer identity" }, 403);
  const info = await docker
    .getContainer(c.req.param("id"))
    .inspect()
    .catch(() => undefined);
  if (!info || !isWorkspaceContainer(info, workspaceId)) {
    return c.json({ error: "computer not found" }, 404);
  }
  return c.json({ id: c.req.param("id"), running: Boolean(info.State.Running) });
});

app.get("/computers/:id", async (c) => {
  const id = c.req.param("id");
  try {
    // Pedir a tela é o momento de abrir a sessão do bot, não de recusar por não existir.
    const found = await managedSession(
      id,
      c.req.header("x-quibt-bot-id"),
      c.req.header("x-quibt-workspace-id"),
      { ensureSession: true },
    );
    const session = requireSession(found.session);
    await ensureNovnc(found.container, session.botId, session.display);
    // The address below is only reachable if the app is on this computer's network.
    await ensureComputerNetworkMembers(session.workspaceId).catch(() => undefined);
    const screenUrl = await publishedSessionUrl(found.container, session.display, found.info);
    return c.json({
      id,
      running: Boolean(found.info.State.Running),
      image: found.info.Config.Image,
      screenUrl,
      display: session.display,
    });
  } catch (error) {
    return failure(c, error, "inspect", 404);
  }
});

const execSchema = z.object({
  argv: z.array(z.string().max(32_768)).max(128),
  cwd: z.string().max(4_096).optional(),
  env: z.record(z.string().max(256), z.string().max(32_768)).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

app.post("/computers/:id/exec", async (c) => {
  const id = c.req.param("id");
  try {
    const body = execSchema.parse(await readJson(c.req.raw));
    const argv = assertExecArgv(body.argv);
    const timeoutMs = boundedSandboxCommandTimeoutMs(body.timeoutMs);
    const { container, session } = await managedSession(
      id,
      c.req.header("x-quibt-bot-id"),
      c.req.header("x-quibt-workspace-id"),
      { allowMissingSession: true },
    );
    const timedCommand = sandboxTimeoutCommand(
      argv.length ? argv : ["/bin/echo", "ready"],
      timeoutMs,
    );
    const command = session ? withGroupWritableUmask(timedCommand) : timedCommand;
    const exec = await container.exec({
      Cmd: command,
      ...(session?.display ? { User: sessionUser(session.display) } : {}),
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: body.cwd ?? "/home/quibt",
      Env: execEnvEntries(body.env, session?.display),
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const output = await collectExecOutput(stream);
    const inspect = await exec.inspect();
    const code = inspect.ExitCode ?? 0;
    return c.json({
      stdout: `${output.stdout}${output.truncated ? "\n[output truncated]" : ""}`,
      stderr:
        code === 124
          ? `${output.stderr}${output.stderr && !output.stderr.endsWith("\n") ? "\n" : ""}command timed out after ${timeoutMs} ms\n`
          : output.stderr,
      code,
    });
  } catch (error) {
    const { status, message } = publicError(normalizeError(error));
    if (status >= 500) console.error("supervisor exec failed", error);
    return c.json({ stdout: "", stderr: message, code: 1 }, 200);
  }
});

app.get("/computers/:id/screen", async (c) => {
  const id = c.req.param("id");
  try {
    const found = await managedSession(
      id,
      c.req.header("x-quibt-bot-id"),
      c.req.header("x-quibt-workspace-id"),
    );
    const session = requireSession(found.session);
    await ensureComputerNetworkMembers(session.workspaceId).catch(() => undefined);
    const screenUrl = await publishedSessionUrl(found.container, session.display, found.info);
    return c.redirect(screenUrl);
  } catch {
    return c.json({ error: "computer not found" }, 404);
  }
});

const inputSchema = z.object({
  input: z.object({
    kind: z.enum(["key", "pointer", "clipboard"]),
    key: z.string().max(64).optional(),
    modifiers: z.array(z.string().max(64)).max(8).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    button: z.enum(["left", "right"]).optional(),
    type: z.enum(["move", "down", "up", "click"]).optional(),
    text: z.string().max(32_768).optional(),
  }),
  leaseId: z.string().max(200).optional(),
});

app.post("/computers/:id/input", async (c) => {
  const id = c.req.param("id");
  try {
    const body = inputSchema.parse(await readJson(c.req.raw));
    const input = toSandboxInput(body.input);
    const found = await managedSession(
      id,
      c.req.header("x-quibt-bot-id"),
      c.req.header("x-quibt-workspace-id"),
    );
    const session = requireSession(found.session);
    const exec = await found.container.exec({
      Cmd: ["env", `DISPLAY=:${session.display}`, ...xdotoolCommand(input)],
      User: sessionUser(session.display),
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: "/home/quibt",
      Env: [`HOME=/home/quibt`, `XAUTHORITY=${sessionRuntimeDir(session.display)}/Xauthority`],
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve, reject) => {
      stream.on("end", () => resolve());
      stream.on("error", reject);
      stream.resume();
    });
    const inspect = await exec.inspect();
    if ((inspect.ExitCode ?? 0) !== 0) {
      return c.json({ ok: false, error: "input failed" }, 500);
    }
    return c.json({ ok: true, leaseId: body.leaseId ?? null });
  } catch (error) {
    const { status, message } = publicError(normalizeError(error));
    if (status >= 500) console.error("supervisor input failed", error);
    return c.json({ ok: false, error: message }, status);
  }
});

app.post("/computers/:id/stop", async (c) => {
  try {
    const found = await managedSession(
      c.req.param("id"),
      c.req.header("x-quibt-bot-id"),
      c.req.header("x-quibt-workspace-id"),
    );
    const session = requireSession(found.session);
    await execIn(
      found.container,
      ["quibt-session", "stop", session.botId, String(session.display)],
      sessionUser(session.display),
    );
    dropSession(session.workspaceId, session.botId);
    return c.json({ ok: true });
  } catch (error) {
    return failure(c, error, "stop", 404);
  }
});

app.delete("/computers/:id", async (c) => {
  const id = c.req.param("id");
  const preserveComputer = c.req.header("x-quibt-preserve-computer") === "true";
  try {
    const found = await managedSession(
      id,
      c.req.header("x-quibt-bot-id"),
      c.req.header("x-quibt-workspace-id"),
    );
    const session = requireSession(found.session);
    await execIn(
      found.container,
      ["quibt-session", "stop", session.botId, String(session.display)],
      sessionUser(session.display),
    ).catch(() => undefined);
    dropSession(session.workspaceId, session.botId);
    if (shouldRemoveSharedContainer(preserveComputer, await probeSessions(found.container))) {
      await found.container.remove({ force: true }).catch(() => undefined);
      forgetWorkspace(session.workspaceId, found.container.id);
      await removeComputerNetwork(session.workspaceId);
    }
    return c.json({ ok: true, preserveComputer });
  } catch (error) {
    return failure(c, error, "destroy", 404);
  }
});

const port = Number(process.env.SUPERVISOR_PORT ?? 7091);
const hostname = process.env.SUPERVISOR_HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, hostname, port }, () => {
  console.log(
    `sandbox supervisor on http://${hostname}:${port} (docker ${dockerEndpoint.description})`,
  );
  void reconcileComputerNetworks();
  void retireOutdatedWorkspaceContainers();
});

/**
 * Ao subir com uma imagem de computador nova (o app foi atualizado), aposenta os containers
 * de workspace que ainda rodam a antiga. O provision já fazia isso — mas só quando alguém
 * provisionava; com a sessão "running" no banco ninguém provisionava, e o bot seguia
 * trabalhando num computador velho (ou sem a tela) até o sono por ociosidade. Removido
 * aqui, o próximo boot vê o 404, esquece a sessão e recria com a imagem atual. A casa do
 * bot é bind mount: nada se perde além das janelas abertas.
 */
async function retireOutdatedWorkspaceContainers(): Promise<void> {
  try {
    const desired = await docker
      .getImage(COMPUTER_IMAGE)
      .inspect()
      .catch(() => null);
    if (!desired) return;
    const listed = await docker.listContainers({
      all: true,
      filters: { label: ["quibt.kind=workspace", "quibt.managed=true"] },
    });
    for (const item of listed) {
      if (item.ImageID === desired.Id) continue;
      const container = docker.getContainer(item.Id);
      const info = await container.inspect().catch(() => null);
      if (!info || info.Image === desired.Id) continue;
      const workspaceId = info.Config.Labels?.["quibt.workspaceId"];
      console.log(
        `retiring workspace container ${item.Id.slice(0, 12)} (image ${info.Image.slice(7, 19)} -> ${desired.Id.slice(7, 19)})`,
      );
      await container.remove({ force: true }).catch(() => undefined);
      if (workspaceId) forgetWorkspace(workspaceId, item.Id);
    }
  } catch (error) {
    console.error("retire outdated workspace containers failed", error);
  }
}

/**
 * Ao subir, religa o próprio supervisor e os proxies de tela a toda rede de computador
 * que já existe. Sem isso, um `web` ou supervisor recriado ficava fora da rede até o
 * próximo pedido de status — e nesse meio tempo a tela do bot abria em branco.
 */
async function reconcileComputerNetworks(): Promise<void> {
  if (process.env.SANDBOX_SCREEN_NETWORK !== "internal") return;
  try {
    const networks = await docker.listNetworks({
      filters: { label: ["quibt.managed=true"] },
    });
    for (const network of networks) {
      const workspaceId = network.Labels?.["quibt.workspaceId"];
      if (!workspaceId) continue;
      await ensureComputerNetworkMembers(workspaceId).catch(() => undefined);
    }
  } catch {
    // Reconciliation is best effort: the status handler runs it again on the next call.
  }
}

/**
 * Picks the daemon at boot and fails loudly there instead of at the first bot message: the
 * supervisor exists to talk to Docker, and a raw ENOENT thirty minutes later is not an answer.
 */
async function connectDocker(): Promise<{
  docker: Docker;
  dockerEndpoint: DockerEndpoint;
}> {
  const candidates = dockerEndpointCandidates(process.env, existsSync);
  let lastError: string | undefined;
  for (const endpoint of candidates) {
    const client = new Docker(endpoint.options);
    const probe = await pingDocker(client);
    if (probe.ok) return { docker: client, dockerEndpoint: endpoint };
    lastError = probe.error;
  }
  const [first] = candidates;
  if (first) console.error(dockerUnreachableMessage(first, process.env, lastError));
  process.exit(1);
}

/** Short probe so /health cannot hang behind an unresponsive daemon. */
async function pingDocker(client: Docker = docker, timeoutMs = 2_000) {
  try {
    await Promise.race([
      client.ping(),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error(`no answer in ${timeoutMs}ms`)), timeoutMs).unref();
      }),
    ]);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Wrapped in `retryableOnce`: a failed build must not poison every later request. */
async function buildComputerImage() {
  try {
    await docker.getImage(COMPUTER_IMAGE).inspect();
    return;
  } catch {
    // build below
  }
  const dockerfile = path.join(computerContext, "Dockerfile");
  if (!existsSync(dockerfile)) {
    throw new Error(
      `Missing ${COMPUTER_IMAGE}. Build it with: docker build -t ${COMPUTER_IMAGE} infra/sandboxes/computer`,
    );
  }
  const stream = await docker.buildImage(
    {
      context: computerContext,
      src: [
        "Dockerfile",
        "start.sh",
        "quibt-browser",
        "quibt-session",
        "box-chrome",
        "embed.html",
        "fluxbox.init",
        "fluxbox.apps",
        "fluxbox.menu",
      ],
    },
    { t: COMPUTER_IMAGE },
  );
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
  await docker.getImage(COMPUTER_IMAGE).inspect();
}

async function findWorkspaceContainer(workspaceId: string) {
  const listed = await docker.listContainers({
    all: true,
    filters: {
      label: [`quibt.workspaceId=${workspaceId}`, "quibt.kind=workspace"],
    },
  });
  for (const item of listed) {
    const container = docker.getContainer(item.Id);
    const info = await container.inspect();
    if (isWorkspaceContainer(info, workspaceId)) return container;
  }
  return undefined;
}

async function removeLegacyBotContainers(workspaceId: string) {
  const listed = await docker.listContainers({
    all: true,
    filters: {
      label: [`quibt.workspaceId=${workspaceId}`, "quibt.managed=true"],
    },
  });
  for (const item of listed) {
    const container = docker.getContainer(item.Id);
    const info = await container.inspect();
    const labels = info.Config.Labels ?? {};
    if (labels["quibt.kind"] === "workspace") continue;
    if (labels["quibt.botId"]) {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }
}

function requireSession<T>(session: T | undefined): T {
  if (!session) throw new SupervisorError("session not found", 404);
  return session;
}

async function startWorkspaceContainer(container: Docker.Container) {
  try {
    await container.start();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    throw explainContainerExit(255, raw);
  }
  const info = await container.inspect();
  if (info.State.Running) return info;
  const logs = await container
    .logs({ stdout: true, stderr: true, tail: 30 })
    .catch(() => Buffer.alloc(0));
  const text = Buffer.isBuffer(logs) ? logs.toString("utf8") : String(logs);
  throw explainContainerExit(info.State.ExitCode, text || info.State.Error || "");
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new SupervisorError("invalid json body");
  }
}

/** Zod rejections are caller mistakes, not supervisor failures. */
function normalizeError(error: unknown) {
  return error instanceof z.ZodError ? new SupervisorError("invalid request body") : error;
}

function failure(c: Context, error: unknown, scope: string, fallbackStatus?: 404) {
  const { status, message } = publicError(normalizeError(error));
  if (status >= 500) console.error(`supervisor ${scope} failed`, error);
  return c.json({ error: message }, status === 500 && fallbackStatus ? fallbackStatus : status);
}

async function managedSession(
  id: string,
  botId: string | undefined,
  workspaceId: string | undefined,
  opts: { allowMissingSession?: boolean; ensureSession?: boolean } = {},
) {
  if (!botId || !workspaceId) throw new SupervisorError("missing computer identity", 403);
  const container = docker.getContainer(id);
  const info = await container.inspect().catch(() => {
    throw new SupervisorError("computer not found", 404);
  });
  if (!isWorkspaceContainer(info, workspaceId)) {
    throw new SupervisorError("computer identity mismatch", 403);
  }
  const key = sessionKey(workspaceId, botId);
  let session = sessions.get(key);
  if (session && session.containerId !== container.id) {
    // Memória de um container anterior: esquece e descobre de novo neste.
    forgetWorkspace(workspaceId, session.containerId);
    session = undefined;
  }
  if (!session) {
    const box = workspaceBoxes.get(workspaceId);
    const display = box?.displays.get(botId);
    if (display) {
      session = {
        containerId: container.id,
        workspaceId,
        botId,
        display,
        screenUrl: await publishedSessionUrl(container, display, info),
      };
      sessions.set(key, session);
    }
  }
  if (!session) {
    const status = await execIn(container, ["quibt-session", "status", botId]).catch(() => "");
    const display = Number(/display=(\d+)/.exec(status)?.[1]);
    if (Number.isInteger(display) && display > 0) {
      const box =
        workspaceBoxes.get(workspaceId) ??
        ({
          containerId: container.id,
          displays: new Map<string, number>(),
        } satisfies {
          containerId: string;
          displays: Map<string, number>;
        });
      box.displays.set(botId, display);
      workspaceBoxes.set(workspaceId, box);
      session = {
        containerId: container.id,
        workspaceId,
        botId,
        display,
        screenUrl: await publishedSessionUrl(container, display, info),
      };
      sessions.set(key, session);
    }
  }
  /**
   * O computador do workspace é provisionado uma vez, sob o id "workspace"; a sessão
   * gráfica de cada bot só nasce aqui. Sem isto o primeiro pedido de tela de um bot
   * respondia 404 "session not found" para sempre: a API guardava `screenUrl` nulo e
   * o app — web e celular — ficava com o retângulo preto, mesmo com o Xvfb no ar.
   */
  if (!session && opts.ensureSession) {
    session = await ensureBotSession(container, botId, workspaceId);
    return { container, info: await container.inspect(), session };
  }
  if (!session && !opts.allowMissingSession) throw new SupervisorError("session not found", 404);
  return { container, info, session };
}

function isWorkspaceContainer(info: Docker.ContainerInspectInfo, workspaceId: string) {
  const labels = info.Config.Labels ?? {};
  const managed = labels["quibt.managed"] === "true" || info.Config.Image === COMPUTER_IMAGE;
  return (
    managed && labels["quibt.workspaceId"] === workspaceId && labels["quibt.kind"] === "workspace"
  );
}

function assertRequestIdentity(
  botId: string | undefined,
  workspaceId: string | undefined,
  expected: { botId: string; workspaceId: string },
) {
  if (botId !== expected.botId || workspaceId !== expected.workspaceId) {
    throw new SupervisorError("computer identity mismatch", 403);
  }
}

function hostHomePath(serviceHomePath: string, info: Docker.ContainerInspectInfo | undefined) {
  const dataMount = info?.Mounts.find((mount) => mount.Destination === dataDir);
  if (!dataMount?.Source) return serviceHomePath;
  return path.join(dataMount.Source, path.relative(dataDir, serviceHomePath));
}

async function seedWorkspaceHome(botId: string, workspaceHome: string) {
  const existing = await readdir(workspaceHome).catch(() => []);
  if (existing.length) return;
  const legacy = path.join(dataDir, "homes", botId);
  if (!existsSync(legacy)) return;
  await cp(legacy, workspaceHome, { recursive: true, force: false });
}

function hasValidSupervisorToken(authorization: string | undefined) {
  return isAuthorizedSupervisorRequest(authorization, supervisorToken);
}

function loadRootEnv() {
  const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.env");
  if (!existsSync(envFile)) return;
  try {
    loadEnvFile(envFile);
  } catch {
    // The API reports malformed or missing deployment configuration in more detail.
  }
}

/**
 * Uma tela por vez, por workspace.
 *
 * A alocação de display lê e escreve um mapa em memória em volta de dois `await`
 * (probe e `quibt-session start`). Abrir a tela agora acontece em muito mais
 * lugares — navegador, celular e cada heartbeat —, então duas chamadas
 * simultâneas passavam pelo mesmo buraco: davam o mesmo display a dois bots, ou
 * subiam dois X servers para o mesmo bot, cada um apagando o socket do outro.
 * Tela preta, de novo, agora por corrida.
 */
function ensureBotSession(
  container: Docker.Container,
  botId: string,
  workspaceId: string,
  requestedDisplay?: number,
) {
  return withWorkspaceSessionLock(workspaceId, () =>
    startBotSession(container, botId, workspaceId, requestedDisplay),
  );
}

async function startBotSession(
  container: Docker.Container,
  botId: string,
  workspaceId: string,
  requestedDisplay?: number,
) {
  // Dentro da fila: se outra chamada já abriu esta sessão enquanto esperávamos, use-a —
  // desde que seja neste container; uma entrada de um container que já morreu não vale.
  const existing = sessions.get(sessionKey(workspaceId, botId));
  if (existing && existing.containerId === container.id) return existing;
  if (existing) forgetWorkspace(workspaceId, existing.containerId);
  const box =
    workspaceBoxes.get(workspaceId) ??
    ({
      containerId: container.id,
      displays: new Map<string, number>(),
    } satisfies {
      containerId: string;
      displays: Map<string, number>;
    });
  box.containerId = container.id;
  // After a supervisor restart the in-memory map is empty while the container still
  // serves displays; allocating from memory alone would start a second X server on a
  // display another bot is already using.
  const probed = splitSentinelSessions([...((await probeSessions(container)) ?? [])]);
  for (const [liveBotId, liveDisplay] of probed.sessions) {
    box.displays.set(liveBotId, liveDisplay);
  }
  // Herança das instalações anteriores: encerrar a tela do sentinela devolve o display
  // ao bot e tira um Chromium inteiro da memória do computador compartilhado.
  for (const stale of probed.sentinels) {
    const staleDisplay = box.displays.get(stale) ?? 1;
    box.displays.delete(stale);
    await execIn(
      container,
      ["quibt-session", "stop", stale, String(staleDisplay)],
      sessionUser(staleDisplay),
    ).catch(() => undefined);
  }
  const requested = allocateDisplay(box.displays, botId, requestedDisplay);
  box.displays.set(botId, requested);
  workspaceBoxes.set(workspaceId, box);
  // Validate the identifier before using it as a path component below.
  novncEnsureCommand(botId);
  const runtimeDir = sessionRuntimeDir(requested);
  await prepareSessionDirs(container, botId, requested);
  const started = await execIn(
    container,
    ["quibt-session", "start", botId, String(requested)],
    sessionUser(requested),
  );
  // The container answers with the display it is really serving; a session that survived a
  // supervisor restart keeps its own, and publishing the requested one would hand the caller
  // a screen URL for another bot's port.
  const display = parseSessionStart(started, requested);
  box.displays.set(botId, display);
  workspaceBoxes.set(workspaceId, box);
  const info = await container.inspect();
  const screenUrl = await publishedSessionUrl(container, display, info);
  await ensureNovnc(container, botId, display);
  const session = {
    containerId: container.id,
    workspaceId,
    botId,
    display,
    screenUrl,
  };
  sessions.set(sessionKey(workspaceId, botId), session);
  return session;
}

async function ensureNovnc(container: Docker.Container, botId: string, display: number) {
  try {
    // Keep screen processes and their logs owned by the workspace user. A root-owned
    // websockify cannot later be replaced by quibt-session's unprivileged watchdog.
    return parseNovncEnsure(
      await execIn(container, novncEnsureCommand(botId), sessionUser(display)),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return parseNovncEnsure(message);
  }
}

async function publishedSessionUrl(
  container: Docker.Container,
  display: number,
  initialInfo?: Docker.ContainerInspectInfo,
) {
  const novnc = String(sessionPorts(display).novnc);
  const password = await sessionVncPassword(container, display);
  for (let i = 0; i < 40; i += 1) {
    const info = i === 0 && initialInfo ? initialInfo : await container.inspect();
    if (process.env.SANDBOX_SCREEN_NETWORK === "internal") {
      const networkMode = info.HostConfig.NetworkMode;
      const address = networkMode
        ? info.NetworkSettings?.Networks?.[networkMode]?.IPAddress
        : undefined;
      if (address) return screenUrlFor(novnc, address, password);
    }
    const hostPort = info.NetworkSettings?.Ports?.[`${novnc}/tcp`]?.[0]?.HostPort;
    if (hostPort) return screenUrlFor(hostPort, undefined, password);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("computer screen port was not published");
}

async function sessionVncPassword(container: Docker.Container, display: number): Promise<string> {
  // Lido como o dono da sessão, não como root: a pasta é 700 do uid da sessão e o
  // computador roda sem CAP_DAC_OVERRIDE, então lá dentro nem o root atravessa modo
  // de arquivo. Como root isto devolvia "Permission denied" e a tela não abria.
  const value = await execIn(
    container,
    ["cat", `${sessionRuntimeDir(display)}/vnc.password`],
    sessionUser(display),
  );
  if (!/^[A-Za-z0-9_-]{8}$/.test(value)) {
    throw new SupervisorError("invalid screen credential", 500);
  }
  return value;
}

async function computerNetworkMode(
  workspaceId: string,
  info: Docker.ContainerInspectInfo | undefined,
) {
  if (process.env.SANDBOX_SCREEN_NETWORK !== "internal") return undefined;
  const name = computerNetworkName(workspaceId);
  let network = docker.getNetwork(name);
  try {
    await network.inspect();
  } catch {
    network = await docker.createNetwork({
      Name: name,
      Driver: "bridge",
      CheckDuplicate: true,
      Labels: { "quibt.managed": "true", "quibt.workspaceId": workspaceId },
    });
  }
  const supervisorId = info?.Id ?? process.env.HOSTNAME;
  if (supervisorId) {
    const inspected = await network.inspect();
    if (!Object.keys(inspected.Containers ?? {}).includes(supervisorId)) {
      await network.connect({ Container: supervisorId }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists|already connected/i.test(message)) throw error;
      });
    }
  }
  await ensureComputerNetworkMembers(workspaceId);
  return name;
}

/**
 * Puts this supervisor and every screen-proxy container (the app that serves `/novnc`) on
 * the workspace's computer network.
 *
 * Membership used to be arranged once, while provisioning. Recreating a container — an
 * upgrade, a `compose up`, anything that mints a new container id — left the new one off the
 * network: the app could no longer reach the screen, and a recreated supervisor could no
 * longer reach the computer at all. Both are container ids that outlive nothing, so the
 * moment a screen address is handed out is the moment this has to be true again. It is a
 * no-op once everyone is connected.
 */
async function ensureComputerNetworkMembers(workspaceId: string): Promise<void> {
  if (process.env.SANDBOX_SCREEN_NETWORK !== "internal") return;
  const network = docker.getNetwork(computerNetworkName(workspaceId));
  let attached: Set<string>;
  try {
    const inspected = await network.inspect();
    attached = new Set(Object.keys(inspected.Containers ?? {}));
  } catch {
    // No network yet: provisioning creates it and calls back here.
    return;
  }
  const screenProxies = await docker
    .listContainers({ filters: { label: ["quibt.screen-proxy=true"] } })
    .catch(() => [] as { Id: string }[]);
  const wanted = [
    ...screenProxies.map((proxy) => proxy.Id),
    (await inspectSupervisorContainer())?.Id ?? process.env.HOSTNAME,
  ];
  for (const id of wanted) {
    if (!id || attached.has(id)) continue;
    await network.connect({ Container: id }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|already connected/i.test(message)) throw error;
    });
  }
}

function computerNetworkName(workspaceId: string) {
  const digest = createHash("sha256").update(workspaceId).digest("hex").slice(0, 20);
  return `quibt-computer-${digest}`;
}

async function removeComputerNetwork(workspaceId: string) {
  if (process.env.SANDBOX_SCREEN_NETWORK !== "internal") return;
  const network = docker.getNetwork(computerNetworkName(workspaceId));
  const supervisorId = supervisorInfo?.Id ?? process.env.HOSTNAME;
  if (supervisorId) {
    await network.disconnect({ Container: supervisorId, Force: true }).catch(() => undefined);
  }
  const screenProxies = await docker
    .listContainers({ filters: { label: ["quibt.screen-proxy=true"] } })
    .catch(() => []);
  for (const proxy of screenProxies) {
    await network.disconnect({ Container: proxy.Id, Force: true }).catch(() => undefined);
  }
  await network.remove().catch(() => undefined);
}

async function inspectSupervisorContainer() {
  if (supervisorInfo || !process.env.HOSTNAME) return supervisorInfo;
  try {
    supervisorInfo = await docker.getContainer(process.env.HOSTNAME).inspect();
    return supervisorInfo;
  } catch {
    return undefined;
  }
}

async function execIn(container: Docker.Container, cmd: string[], user?: string) {
  const exec = await container.exec({
    Cmd: cmd,
    ...(user ? { User: user } : {}),
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: "/home/quibt",
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (d: Buffer) => chunks.push(d));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  const inspect = await exec.inspect();
  if ((inspect.ExitCode ?? 0) !== 0) {
    throw new Error(stripDockerStream(Buffer.concat(chunks)) || `exec failed: ${cmd.join(" ")}`);
  }
  return stripDockerStream(Buffer.concat(chunks));
}

/** Keeps stdout and stderr apart, with one shared output budget. */
async function collectExecOutput(stream: NodeJS.ReadableStream) {
  const demuxer = createDockerStreamDemuxer(MAX_EXEC_OUTPUT_BYTES);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (raw: Buffer | string) => {
      demuxer.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return demuxer.end();
}

async function chownWorkspaceTree(root: string, markerName = "home") {
  // The computer can mutate everything below `root`; preparation state therefore lives in
  // its trusted parent, which is never bind-mounted into the sandbox.
  const marker = homePreparationMarker(root, markerName);
  if (existsSync(marker)) return;
  await chown(root, 1000, 1000).catch(() => undefined);
  const entries = await readdir(root, { recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (typeof entry === "string")
      // lchown never follows a link swapped in by a running sandbox between readdir and here.
      await lchown(path.join(root, entry), 1000, 1000).catch(() => undefined);
  }
  await writeFile(marker, "1", { flag: "wx", mode: 0o600 }).catch(() => undefined);
}

async function prepareWorkspaceDesktopStorage(home: string, desktop: string) {
  const destination = await lstat(desktop).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (destination) {
    if (destination.isSymbolicLink() || !destination.isDirectory()) {
      throw new SupervisorError("desktop storage path is not a directory", 500);
    }
    return;
  }
  const legacy = path.join(home, ".local", "share", "quibt", "desktops");
  const source = await trustedLegacyDesktopDirectory(home);
  if (source) {
    await rename(legacy, desktop);
    return;
  }
  await mkdir(desktop, { recursive: true });
}

async function trustedLegacyDesktopDirectory(home: string) {
  let current = home;
  let result: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const segment of [".local", "share", "quibt", "desktops"]) {
    current = path.join(current, segment);
    result = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!result) return undefined;
    if (result.isSymbolicLink() || !result.isDirectory()) {
      throw new SupervisorError("legacy desktop storage path is not a directory", 500);
    }
  }
  return result;
}

/**
 * The host chown is best effort: a supervisor that does not run as root cannot change owner. Try
 * again as container root, then fall back to mode repair for Docker VM bind mounts whose uid is
 * immutable, and refuse to start a session we know would die confusingly.
 */
async function ensureHomeWritable(container: Docker.Container) {
  const probe = await execIn(container, HOME_WRITABLE_PROBE).catch(() => "blocked");
  if (homeIsWritable(probe)) return;
  try {
    await execIn(container, HOME_REPAIR_COMMAND, "0");
  } catch (ownershipError) {
    console.warn("home ownership repair failed; trying mode repair", ownershipError);
    await execIn(container, HOME_MODE_REPAIR_COMMAND, "0").catch((modeError) => {
      console.error("home mode repair failed", modeError);
    });
  }
  const repaired = await execIn(container, HOME_WRITABLE_PROBE).catch(() => "blocked");
  if (!homeIsWritable(repaired)) throw new SupervisorError(HOME_NOT_WRITABLE_MESSAGE, 500);
}

async function ensureSharedHomePermissions(container: Docker.Container) {
  await execIn(
    container,
    [
      "bash",
      "-lc",
      'marker=/run/quibt/home-group-ready; [ -f "$marker" ] && exit 0; mkdir -p /run/quibt; find /home/quibt -xdev -type d -exec chmod g+rwx,g+s {} +; find /home/quibt -xdev -type f -exec chmod g+rw {} +; touch "$marker"; chmod 600 "$marker"',
    ],
    "0",
  );
}

/**
 * A raiz dos desktops fica 1777 — qualquer sessão cria a sua ali e só o dono apaga a
 * dele, como em `/tmp`. Escrito daqui, do host, nunca de dentro do container, onde
 * `CapDrop: ALL` proíbe. Dono não se mexe: o supervisor nem sempre é root (`pnpm dev`
 * e o CI rodam como gente comum) e mudar dono exige privilégio.
 */
export async function hardenDesktopRoot(desktopRoot: string) {
  const info = await lstat(desktopRoot).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new SupervisorError("desktop storage path is a link", 500);
  if (!info) await mkdir(desktopRoot, { recursive: true });
  await chmod(desktopRoot, 0o1777);
  // Relido de propósito: um chmod que "passa" mas não fica (bind mount, fs sem suporte)
  // deixava o dir 755 root, o dono da sessão não conseguia criar o desktop dele e a
  // tela morria em "framebuffer failed" — silenciosamente, só na hora de assumir o
  // controle. Melhor o install falhar aqui, com nome, do que o celular ficar
  // "conectando" para sempre.
  const mode = (await lstat(desktopRoot)).mode & 0o7777;
  if (mode !== 0o1777) {
    throw new SupervisorError(
      `desktop root ${desktopRoot} ficou com modo ${mode.toString(8)}, esperado 1777`,
      500,
    );
  }
}

/**
 * A casa da sessão nasce dentro do container, feita pelo próprio dono dela: assim ele já
 * é o dono, sem `chown` nenhum. É a única forma que funciona nos três lugares — o
 * computador larga todas as capabilities (`CapDrop: ALL`) e o supervisor nem sempre é
 * root no host. A pasta fica 700: um bot não lê a tela, os cookies nem os logs do outro.
 */
async function prepareSessionDirs(container: Docker.Container, botId: string, display: number) {
  // O /run é tmpfs, refeito a cada boot do container: o root de lá cria a pasta-mãe e a
  // deixa sticky, como /tmp. Isso ele consegue sem capability, porque a pasta é dele.
  await execIn(
    container,
    [
      "bash",
      "-lc",
      'mkdir -p "$1" && chmod 1777 "$1"',
      "quibt-session-prepare",
      "/run/quibt/sessions",
    ],
    "0",
  );
  await execIn(
    container,
    [
      "bash",
      "-lc",
      'test ! -L "$1" && test ! -L "$2" && mkdir -p "$1" "$2" && chmod 700 "$1" "$2"',
      "quibt-session-prepare",
      sessionRuntimeDir(display),
      `/quibt-desktops/${botId}`,
    ],
    sessionUser(display),
  );
}

/** Confere, sem mexer: a raiz tem de existir e não pode ter virado link. */
async function assertPrivateDesktopRoot(container: Docker.Container) {
  await execIn(
    container,
    ["bash", "-lc", "test -d /quibt-desktops && test ! -L /quibt-desktops"],
    "0",
  );
}

/** Lists the sessions the container is really running; `undefined` when the probe failed. */
async function probeSessions(container: Docker.Container) {
  // Como o usuário do computador (1000), que é o grupo dono dos desktops. Root não
  // serve: o container larga todas as capabilities e não atravessa modo de arquivo.
  const output = await execIn(container, SESSION_PROBE_COMMAND, "1000:1000").catch(() => undefined);
  return output === undefined ? undefined : parseSessionProbe(output);
}

function sessionKey(workspaceId: string, botId: string) {
  return `${workspaceId}:${botId}`;
}

function dropSession(workspaceId: string, botId: string) {
  sessions.delete(sessionKey(workspaceId, botId));
  workspaceBoxes.get(workspaceId)?.displays.delete(botId);
}

function forgetWorkspace(workspaceId: string, containerId: string) {
  workspaceBoxes.delete(workspaceId);
  for (const [key, session] of sessions) {
    if (session.workspaceId === workspaceId || session.containerId === containerId) {
      sessions.delete(key);
    }
  }
}

function toSandboxInput(input: {
  kind: "key" | "pointer" | "clipboard";
  key?: string;
  modifiers?: string[];
  x?: number;
  y?: number;
  button?: "left" | "right";
  type?: "move" | "down" | "up" | "click";
  text?: string;
}): SandboxInput {
  if (input.kind === "key")
    return { kind: "key", key: input.key ?? "", modifiers: input.modifiers };
  if (input.kind === "clipboard") return { kind: "clipboard", text: input.text ?? "" };
  return {
    kind: "pointer",
    x: input.x ?? 0,
    y: input.y ?? 0,
    button: input.button,
    type: input.type ?? "click",
  };
}

function stripDockerStream(buffer: Buffer) {
  if (buffer.length >= 8 && (buffer[0] ?? 99) <= 2) {
    const parts: string[] = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(offset + 4);
      parts.push(buffer.subarray(offset + 8, offset + 8 + size).toString("utf8"));
      offset += 8 + size;
    }
    return parts.join("");
  }
  return buffer.toString("utf8");
}
