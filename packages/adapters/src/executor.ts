import type {
  AgentHomeStore,
  AgentRuntime,
  ComputerInput,
  ComputerRef,
  ConnectorProvider,
  ControlLeaseRef,
  MemoryStore,
  NotificationMessage,
  NotificationProvider,
  SandboxProvider,
  WakeupDriver,
} from "@quibt/adapter-kit";
import type { Actor, MessageBlock } from "@quibt/contracts";
import {
  applyMemoryTool,
  approvalKey,
  assertTransition,
  autoDecision,
  canAlwaysAllow,
  chiefOfStaffSystemPrompt,
  containsSecret,
  cronFromNaturalLanguage,
  cronFromPreset,
  formatMemoryPrompt,
  formatSkillPrompt,
  MISSING_MODEL_MESSAGE,
  nextCronDate,
  parseRunCheckpoint,
  redactSecrets,
  resolveUserMemoryPath,
  sandboxCommandTimeoutMs,
  scopeApprovalDecision,
  toolSummary,
} from "@quibt/core";
import {
  appendEvent,
  appendThreadMessage,
  BillingPolicyError,
  CapabilityInstallError,
  createGroupRoutineWakes,
  createPeerWake,
  installCapability,
  isImage,
  MAX_ARTIFACT_BYTES,
  Prisma,
  type PrismaClient,
  pruneProgressEvents,
  publishLiveProgress,
  putArtifact,
} from "@quibt/db";
import { ApprovalPause, approvalCheckpoint, promptForRun } from "./approval-wait.js";
import { browserOpenCommand } from "./browser-url.js";
import { builtinAgentTools, collaborationAgentTools } from "./builtin-tools.js";
import { deleteSpawnedBot, spawnBot } from "./child-bots.js";
import { collectLogIds } from "./composio-connector.js";
import { bootComputer } from "./computer-boot.js";
import { capHistory, HISTORY_MESSAGE_CAP } from "./history.js";
import { PROVIDER_RETRY_PROGRESS_MESSAGE, TRY_AGAIN_HINT } from "./llm-retry.js";
import { callMcpTool, discoverMcpTools, matchMcpSource, parseMcpToolName } from "./mcp-http.js";
import {
  PEER_WAIT_TIMEOUT_MS,
  PeerPause,
  type PendingPeerAsk,
  parsePeerCheckpoint,
  peerAnswerNote,
  peerCheckpoint,
  peerWaitJobKey,
  resolvePeerAnswer,
  wakeRunsWaitingForPeer,
} from "./peer-wait.js";
import { parseModelSecret, resolveModelApiKey, secretValuesToRedact } from "./pi-oauth.js";
import {
  acquireRunLease,
  botBusyWith,
  deferRunForBusyBot,
  requeueRunAfterProviderError,
  wakeNextRunForBot,
  watchRunLease,
} from "./run-lease.js";
import { createProgressThrottle } from "./run-progress.js";
import {
  boundedRecordingSeconds,
  FFMPEG_MISSING,
  missingFfmpegMessage,
  recordingPath,
  recordScreenCommand,
} from "./screen-recording.js";
import { screenshotCommand, screenshotPath } from "./screenshot.js";
import { inferScript } from "./scripted-runtime.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { webFetch, webFetchRequestForTranscript } from "./web-fetch.js";

export interface ExecutorDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  home: AgentHomeStore;
  connector?: ConnectorProvider;
  secrets: string[];
  secretStore?: EncryptedSecretStore;
  deploymentModelKey?: string;
  dataDir?: string;
  notifications?: NotificationProvider;
  wakeup?: WakeupDriver;
  billing?: {
    assertWithinPlan(
      workspaceId: string,
      check: "tokens" | "computer" | "bots" | "subscription",
      tx?: Prisma.TransactionClient,
    ): Promise<void>;
  };
}

export function createRunExecutor(deps: ExecutorDeps) {
  return {
    async wakeRoutine(routineId: string, workerId: string) {
      const routine = await deps.prisma.routine.findUnique({
        where: { id: routineId },
      });
      if (!routine?.active) return;
      const firedAt = new Date();
      const nextRunAt = nextCronDate(routine.cron, firedAt, routine.timezone);
      const markFired = async (tx: Prisma.TransactionClient) => {
        await tx.routine.update({
          where: { id: routine.id },
          data: { lastRunAt: firedAt, nextRunAt },
        });
      };
      const enqueueNextWake = async () => {
        await deps.wakeup?.enqueue({
          name: "routine.wakeup",
          payload: { routineId: routine.id },
          runAt: nextRunAt,
          jobKey: `routine:${routine.id}`,
        });
      };
      const reschedule = async () => {
        await markFired(deps.prisma);
        await enqueueNextWake();
      };
      try {
        await deps.billing?.assertWithinPlan(routine.workspaceId, "tokens");
      } catch (error) {
        if (!(error instanceof BillingPolicyError)) throw error;
        await reschedule();
        return;
      }
      if (routine.groupId) {
        // Same rule as the single-bot path below: the member runs and the new schedule
        // commit together, so a failure halfway cannot leave runs that a Graphile retry
        // would duplicate.
        const runs = await createGroupRoutineWakes(deps.prisma, {
          groupId: routine.groupId,
          workspaceId: routine.workspaceId,
          userId: routine.userId,
          prompt: routine.prompt,
          mark: markFired,
          schedule: enqueueNextWake,
        });
        for (const run of runs) await this.continueRun(run.id, workerId);
        return;
      }
      if (!routine.botId) {
        await deps.prisma.routine.update({
          where: { id: routine.id },
          data: { active: false, nextRunAt: null },
        });
        return;
      }
      const bot = await deps.prisma.bot.findUnique({
        where: { id: routine.botId },
        include: { thread: true },
      });
      if (!bot?.thread) {
        await deps.prisma.routine.update({
          where: { id: routine.id },
          data: { active: false, nextRunAt: null },
        });
        return;
      }
      // Task, run and the new schedule commit together: a crash between the two writes let
      // the Graphile retry fire the same tick again and create a second run.
      const run = await deps.prisma.$transaction(async (tx) => {
        const task = await tx.task.create({
          data: {
            workspaceId: routine.workspaceId,
            botId: bot.id,
            threadId: bot.thread!.id,
            userId: routine.userId,
            prompt: routine.prompt,
            status: "queued",
          },
        });
        const created = await tx.run.create({
          data: {
            workspaceId: routine.workspaceId,
            botId: bot.id,
            threadId: bot.thread!.id,
            taskId: task.id,
            userId: routine.userId,
            status: "queued",
            trigger: "routine",
          },
        });
        await markFired(tx);
        return created;
      });
      await enqueueNextWake();
      await this.continueRun(run.id, workerId);
    },

    async continueRun(runId: string, workerId: string) {
      const run = await deps.prisma.run.findUnique({ where: { id: runId } });
      if (!run) return;
      if (["completed", "failed", "cancelled"].includes(run.status)) return;
      const resumeFromTakeover = run.status === "waiting_takeover";

      // One agent per bot. `threads.send` only cancels `queued` siblings, so a second message
      // sent while the bot works would otherwise stream into the same thread and drive the
      // same computer at the same time. Paused runs (waiting_input / waiting_takeover, peer
      // wait) and dead leases do not count as busy, and this run never blocks itself.
      const busyWith = await botBusyWith(deps.prisma, {
        botId: run.botId,
        runId,
      });
      if (busyWith && (await deferRunForBusyBot(deps, { runId }))) return;

      // The lease is what stops two `run.continue` jobs from executing the same agent twice:
      // a run another worker is already executing is only claimable once its lease dies.
      const lease = await acquireRunLease(deps.prisma, {
        runId,
        workerId,
        fence: run.leaseFence,
      });
      if (!lease) return;
      const fence = lease.fence;

      // Aborting this stops the model loop and any in-flight tools: on cancel, and when a
      // tool needs approval (the agent runtime turns thrown errors into tool results, so a
      // pause has to be signalled out of band).
      const runAbort = new AbortController();
      const stopRuntime = async () => {
        runAbort.abort();
        await deps.runtime.abort(runId).catch(() => undefined);
      };
      // One timer renews the lease and notices a cancel or a takeover by another worker,
      // instead of one `run.findUnique` per streamed token. It starts with the lease and not
      // with the stream: connector discovery, MCP and the first boot of the computer can take
      // minutes, and a boot longer than RUN_LEASE_MS let the reaper requeue a run that was
      // still booting — a second worker then drove the same bot.
      const watcher = watchRunLease(deps.prisma, {
        runId,
        workerId,
        fence,
        onLost: () => {
          void stopRuntime();
        },
      });

      // Every exit from here on — the parked returns, a boot that throws, the stream — gives
      // the timer back. A watcher left running would renew the lease of a dead turn forever.
      try {
        assertTransition("leased", "running");

        // Resuming a parked `ask_bot`: look at the teammate before opening an attempt, so
        // a run that still has to wait gives the worker slot straight back.
        const pendingPeer = parsePeerCheckpoint(run.checkpoint);
        let peerNote: string | undefined;
        if (pendingPeer) {
          const answer = await resolvePeerAnswer(deps.prisma, pendingPeer);
          if (answer.state === "pending") {
            await deps.prisma.run.updateMany({
              where: { id: runId, leaseFence: fence },
              data: {
                status: "waiting_input",
                leaseOwner: null,
                leaseExpiresAt: null,
              },
            });
            return;
          }
          peerNote = peerAnswerNote(pendingPeer, answer);
          await deps.prisma.run.update({
            where: { id: runId },
            data: { checkpoint: null },
          });
        }

        await deps.prisma.run.update({
          where: { id: runId },
          data: { status: "running", startedAt: run.startedAt ?? new Date() },
        });
        await deps.prisma.attempt.create({
          data: { runId, fence, status: "running" },
        });
        const credential = await deps.prisma.userModelCredential.findFirst({
          where: {
            userId: run.userId,
            workspaceId: run.workspaceId,
            isDefault: true,
          },
        });
        try {
          // A credential the person brought pays for its own tokens; the plan
          // quota only gates runs on the deployment key. The Quibt subscription
          // itself must still be active either way.
          await deps.billing?.assertWithinPlan(
            run.workspaceId,
            credential ? "subscription" : "tokens",
          );
        } catch (error) {
          if (!(error instanceof BillingPolicyError)) throw error;
          await failRun(deps, run, error, fence);
          return;
        }

        const bot = await deps.prisma.bot.findUniqueOrThrow({
          where: { id: run.botId },
        });
        const thread = await deps.prisma.thread.findUniqueOrThrow({
          where: { id: run.threadId },
        });
        const conversation = bot.activeConversationId
          ? await deps.prisma.conversation.findUnique({
              where: { id: bot.activeConversationId },
            })
          : await deps.prisma.conversation.findFirst({
              where: { botId: bot.id },
              orderBy: { createdAt: "asc" },
            });
        const recent = await deps.prisma.message.findMany({
          where: {
            threadId: thread.id,
            ...(conversation
              ? {
                  OR: [{ conversationId: conversation.id }, { conversationId: null }],
                }
              : {}),
          },
          orderBy: { seq: "desc" },
          take: HISTORY_MESSAGE_CAP + 1,
        });
        const messages = recent.reverse();
        const task = await deps.prisma.task.findUniqueOrThrow({
          where: { id: run.taskId },
        });
        const actor: Actor = {
          userId: run.userId,
          workspaceId: run.workspaceId,
          workspaceRole: "member",
          email: "",
          isDeploymentOwner: false,
        };
        const [connectedPlugins, installs] = await Promise.all([
          deps.prisma.connection.findMany({
            where: {
              userId: run.userId,
              workspaceId: run.workspaceId,
              status: "connected",
            },
            select: { provider: true, displayName: true },
          }),
          deps.prisma.capabilityInstall.findMany({
            where: { userId: run.userId, workspaceId: run.workspaceId },
            select: { kind: true, name: true, source: true, config: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 100,
          }),
        ]);
        const connectedProviders = connectedProviderSlugs(connectedPlugins, installs);
        let pausedForApproval = false;
        let pausedForPeer = false;
        // O run voltou para a fila por erro passageiro do provedor: o job de +5 s o reacorda.
        let requeued = false;
        // True for the direct webhook delivery (trigger === "webhook", which always also sets
        // webhookId) and for any peer/spawn descendant it causes, however many hops away: those
        // keep their own ordinary trigger ("peer"/"spawn"), but inherit the same webhookId, so
        // nobody was watching for their approval card either.
        const unattended = run.trigger === "webhook" || Boolean(run.webhookId);
        const context = {
          operationId: runId,
          traceId: runId,
          workspaceId: run.workspaceId,
          userId: run.userId,
          botId: bot.id,
          runId,
          signal: runAbort.signal,
          connectedProviders,
        };

        await appendEvent(deps.prisma, {
          workspaceId: run.workspaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "run.started",
          runId,
          payload: { trigger: run.trigger },
        });

        const settings = await deps.prisma.deploymentSettings.findUnique({
          where: { id: "default" },
        });
        const mcpSources = installs.filter((row) => row.kind === "mcp").map((row) => row.source);
        const mcpTools = await discoverMcpTools(mcpSources);
        const discovered = deps.connector ? await deps.connector.discoverTools(context) : [];
        const runtimeSupportsTools = deps.runtime.describe().capabilities.tools;
        const localTools =
          runtimeSupportsTools && deps.wakeup
            ? run.trigger === "peer"
              ? collaborationAgentTools.filter((tool) => tool.name !== "ask_bot")
              : collaborationAgentTools
            : [];
        const allTools = [
          ...builtinAgentTools,
          ...localTools,
          ...discovered.filter(
            (tool) => ![...builtinAgentTools, ...localTools].some((b) => b.name === tool.name),
          ),
          ...mcpTools.filter(
            (tool) => ![...builtinAgentTools, ...localTools].some((b) => b.name === tool.name),
          ),
        ];
        // Native Pi effects cannot be meaningfully resumed from a webhook approval card: there
        // is no person behind the run, and the first model turn has already ended. Make those
        // capabilities unavailable instead of letting the runtime perform them before approval.
        let tools = unattended
          ? allTools.filter(
              (tool) => tool.name !== "run_subagent" && tool.name !== "request_takeover",
            )
          : allTools;
        const participantIds = [
          ...new Set(messages.flatMap((m) => [m.fromBotId, m.authorBotId]).filter(Boolean)),
        ] as string[];
        const participants = participantIds.length
          ? await deps.prisma.bot.findMany({
              where: { id: { in: participantIds }, workspaceId: run.workspaceId },
              select: { id: true, name: true },
            })
          : [];
        const participantNames = new Map(
          participants.map((participant) => [participant.id, participant.name]),
        );
        const history = capHistory([
          ...messages.map((m) => {
            const text = blocksToText(m.blocks as MessageBlock[]);
            if (m.fromBotId) {
              return {
                role: "system" as const,
                content: text.startsWith("[peer]")
                  ? text
                  : `[peer] Recado de ${participantNames.get(m.fromBotId) ?? m.fromBotId}: ${text}`,
              };
            }
            if (m.authorBotId && m.authorBotId !== bot.id) {
              return {
                role: "user" as const,
                content: `Teammate ${participantNames.get(m.authorBotId) ?? m.authorBotId}: ${text}`,
              };
            }
            // Uma reação é o retorno mais barato que a pessoa dá. Sem isso no
            // histórico, o bot nunca sabe o que agradou nem o que não.
            const reacted = reactionNote(m.reactions);
            return {
              role: (m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant") as
                | "user"
                | "assistant"
                | "system",
              content: reacted ? `${text}\n${reacted}` : text,
            };
          }),
          ...(peerNote ? [{ role: "system" as const, content: peerNote }] : []),
        ]);
        let apiKey: string | undefined;
        let oauthCredential: string | undefined;
        let runSecrets = deps.secrets;
        let computer: ComputerRef;
        const scripted = deps.runtime.describe().capabilities.scripted;
        try {
          const resolved = await resolveModelKey(deps, run.userId, run.workspaceId, credential);
          apiKey = resolved.apiKey;
          oauthCredential = resolved.oauthCredential;
          runSecrets = [...deps.secrets, ...resolved.redact];
          computer = await ensureComputer(deps, bot.id, context);
          if (!sandboxSupportsAgentInput(deps.sandbox, computer)) {
            tools = tools.filter((tool) => tool.name !== "computer");
          }
          if (!apiKey && !oauthCredential && !scripted) {
            throw new Error(MISSING_MODEL_MESSAGE);
          }
        } catch (error) {
          await failRun(deps, run, error, fence, bot.name);
          return;
        }

        let assembled = "";
        const script = scripted
          ? inferScript(task.prompt, resumeFromTakeover ? "takeover" : undefined)
          : undefined;

        const applyTool = async (
          name: string,
          args: Record<string, unknown>,
          executionId: string,
        ) => {
          // Retries look up the effect by executionId: it only counts as done once the tool
          // actually returned, so a crash mid-tool re-runs it instead of faking success.
          const recordedArgs = name === "web_fetch" ? webFetchRequestForTranscript(args) : args;
          const applied = await recordEffect(deps, run, name, executionId, recordedArgs);
          if (applied.duplicate) return applied.effect.result ?? { duplicate: true };
          try {
            const result = await performTool(name, args, executionId, applied);
            await completeEffect(deps, applied.effect.id, result);
            return result;
          } catch (error) {
            // A pause is not a failure: the effect stays "intended" so the resumed turn can
            // still reconcile it instead of seeing a tool that supposedly blew up.
            if (error instanceof ApprovalPause) throw error;
            await deps.prisma.externalEffect
              .update({
                where: { id: applied.effect.id },
                data: {
                  status: "failed",
                  result: {
                    error: error instanceof Error ? error.message : String(error),
                  },
                },
              })
              .catch(() => undefined);
            throw error;
          }
        };

        const performTool = async (
          // `screenshot` tira a foto e segue como `send_file`, então os dois mudam aqui dentro.
          name: string,
          args: Record<string, unknown>,
          executionId: string,
          _applied: Awaited<ReturnType<typeof recordEffect>>,
        ): Promise<unknown> => {
          if (name === "computer") {
            if (!sandboxSupportsAgentInput(deps.sandbox, computer)) {
              return {
                error: `The ${computer.kind} sandbox does not support agent computer input.`,
                capability: "agentInput",
                available: false,
              };
            }
            return deps.prisma.$transaction(
              async (tx) => {
                const control = await lockComputerForAgent(tx, {
                  runId,
                  workerId,
                  runFence: fence,
                  botId: bot.id,
                });
                if (!control.ok) return control;
                return executeComputerToolAction({
                  sandbox: deps.sandbox,
                  computer,
                  args,
                  lease: {
                    leaseId: `agent:${runId}:${control.controlFence}`,
                    holder: "bot",
                    fence: control.controlFence,
                  },
                  context,
                  capture: () => captureComputerImage(deps.sandbox, computer, context),
                });
              },
              { timeout: COMPUTER_TOOL_TRANSACTION_TIMEOUT_MS },
            );
          }
          if (name === "write_file") {
            const filePath = String(args.path ?? "notes/result.txt");
            const content = String(args.content ?? "");
            await deps.home.writeFile(bot.id, filePath, content, context);
            return { ok: true, path: filePath };
          }
          if (name === "open_url") {
            const command = browserOpenCommand(args.url);
            if (!command) {
              return { error: "Use a valid HTTP or HTTPS page address without credentials." };
            }
            return runSandboxCommand(deps.sandbox, computer, command, "/home/quibt", context);
          }
          if (name === "web_fetch") {
            return webFetch(String(args.url ?? ""), { signal: context.signal });
          }
          if (name === "shell") {
            const command = String(args.command ?? args.cmd ?? "");
            const cwd = sandboxCwd(args.cwd);
            return runSandboxCommand(
              deps.sandbox,
              computer,
              ["bash", "-lc", command],
              cwd,
              context,
            );
          }
          if (name === "screenshot") {
            const target = screenshotPath(Date.now());
            const shot = await runSandboxCommand(
              deps.sandbox,
              computer,
              screenshotCommand(target),
              "/home/quibt",
              context,
            );
            if (shot.code !== 0) {
              return {
                error: `Não deu para tirar o print: ${shot.stderr.trim() || shot.code}`,
              };
            }
            args = { path: target, caption: args.caption };
            name = "send_file";
          }
          if (name === "record_screen") {
            const seconds = boundedRecordingSeconds(args.seconds);
            const target = recordingPath(Date.now());
            const taped = await runSandboxCommand(
              deps.sandbox,
              computer,
              recordScreenCommand(target, seconds),
              "/home/quibt",
              context,
            );
            if (taped.code !== 0) {
              if (taped.stderr.includes(FFMPEG_MISSING)) return { error: missingFfmpegMessage() };
              return {
                error: `Não deu para gravar: ${taped.stderr.trim() || taped.code}`,
              };
            }
            args = { path: target, caption: args.caption };
            name = "send_file";
          }
          if (name === "send_file") {
            const filePath = String(args.path ?? "").trim();
            if (!filePath) return { error: "path is required" };
            const caption = args.caption ? String(args.caption).slice(0, 500) : undefined;
            // O caminho vai como argumento posicional: um nome com espaço ou aspas é só um
            // nome, nunca um pedaço de comando.
            const read = await runSandboxCommand(
              deps.sandbox,
              computer,
              [
                "bash",
                "-lc",
                `set -e; s=$(stat -c %s -- "$1"); if [ "$s" -gt ${MAX_ARTIFACT_BYTES} ]; then echo "too-big:$s" >&2; exit 2; fi; echo "$s"; base64 -w0 -- "$1"`,
                "quibt-send-file",
                filePath,
              ],
              "/home/quibt",
              context,
              // base64 cresce um terço, e ainda cabe a linha do tamanho.
              Math.ceil(MAX_ARTIFACT_BYTES * 1.4),
            );
            if (read.code !== 0) {
              const tooBig = /too-big:(\d+)/.exec(read.stderr);
              if (tooBig) {
                return {
                  error: `O arquivo tem ${tooBig[1]} bytes e o limite é ${MAX_ARTIFACT_BYTES}.`,
                };
              }
              return {
                error: `Não deu para ler ${filePath}: ${read.stderr.trim() || read.code}`,
              };
            }
            const newline = read.stdout.indexOf("\n");
            const encoded = newline < 0 ? "" : read.stdout.slice(newline + 1).trim();
            if (!encoded) return { error: `${filePath} está vazio.` };
            const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
            const stored = await putArtifact(deps.prisma, {
              workspaceId: run.workspaceId,
              botId: bot.id,
              userId: run.userId,
              runId,
              name: filePath,
              mimeType: mimeTypeForName(filePath),
              bytes,
            });
            await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
              {
                kind: "file",
                artifactId: stored.id,
                name: stored.name,
                mimeType: stored.mimeType,
                size: stored.size,
                image: isImage(stored.mimeType),
                caption,
              },
            ]);
            return {
              ok: true,
              artifactId: stored.id,
              name: stored.name,
              size: stored.size,
            };
          }
          if (name === "memory" || name === "remember") {
            return commitHermesMemory(deps, {
              botId: bot.id,
              runId,
              threadId: thread.id,
              context,
              args,
              alias: name === "remember",
            });
          }
          if (name === "save_skill") {
            const skillName = String(args.name ?? "").trim();
            const instructions = String(args.instructions ?? "").trim();
            if (!skillName || !instructions) return { error: "name and instructions are required" };
            try {
              const row = await installCapability(deps.prisma, {
                workspaceId: run.workspaceId,
                userId: run.userId,
                kind: "skill",
                name: skillName,
                source: "user",
                config: { instructions },
                version: "0.0.0",
              });
              return { ok: true, id: row.id, name: row.name };
            } catch (error) {
              if (error instanceof CapabilityInstallError) return { error: error.message };
              throw error;
            }
          }
          if (name === "create_routine") {
            const routineName = String(args.name ?? "").trim();
            const prompt = String(args.prompt ?? "").trim();
            const schedule = String(args.schedule ?? "").trim();
            if (!routineName || !prompt || !schedule) {
              return { error: "name, prompt and schedule are required" };
            }
            const parsed = cronFromNaturalLanguage(schedule);
            const cron = parsed
              ? cronFromPreset(parsed)
              : /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(schedule)
                ? schedule
                : null;
            if (!cron) return { error: "could not read that schedule" };
            const timezone = String(args.timezone ?? "").trim() || "America/Sao_Paulo";
            const active = args.active !== false;
            const row = await deps.prisma.routine.create({
              data: {
                workspaceId: run.workspaceId,
                userId: run.userId,
                botId: thread.botGroupId ? null : bot.id,
                groupId: thread.botGroupId,
                name: routineName,
                prompt,
                cron,
                timezone,
                active,
                notify: true,
                nextRunAt: active ? nextCronDate(cron, new Date(), timezone) : null,
              },
            });
            if (row.active && row.nextRunAt) {
              await deps.wakeup?.enqueue({
                name: "routine.wakeup",
                payload: { routineId: row.id },
                runAt: row.nextRunAt,
                jobKey: `routine:${row.id}`,
              });
            }
            return {
              ok: true,
              id: row.id,
              name: row.name,
              cron: row.cron,
              nextRunAt: row.nextRunAt?.toISOString() ?? null,
            };
          }
          if (name === "request_takeover") return { ok: true };
          if (name === "list_teammates" || name === "list_bots") {
            const teammates = await deps.prisma.bot.findMany({
              where: {
                workspaceId: run.workspaceId,
                userId: run.userId,
                id: { not: bot.id },
              },
              select: { id: true, name: true, title: true, description: true },
              orderBy: { name: "asc" },
            });
            const busy = await deps.prisma.run.findMany({
              where: {
                botId: { in: teammates.map((row) => row.id) },
                status: {
                  in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
                },
              },
              select: { botId: true },
            });
            const busyIds = new Set(busy.map((row) => row.botId));
            return teammates.map((row) => ({
              ...row,
              busy: busyIds.has(row.id),
            }));
          }
          if (name === "message_teammate") {
            const teammate = await resolveTeammate(deps.prisma, run, bot.id, args);
            if (!teammate) return { error: "teammate not found" };
            const peer = await createPeerWake(deps.prisma, actor, {
              fromBotId: bot.id,
              toBotId: teammate.id,
              text: String(args.message ?? ""),
              // The peer's own trigger stays "peer"; only the causal webhookId propagates, so
              // it re-pauses on protected tools too, however many hops away it lands.
              webhookId: run.webhookId,
            });
            await deps.wakeup?.enqueue({
              name: "run.continue",
              payload: { runId: peer.run.id },
            });
            return { ok: true, teammate, runId: peer.run.id };
          }
          if (name === "ask_bot") {
            const teammate = await resolveTeammate(deps.prisma, run, bot.id, {
              ...args,
              botId: typeof args.bot_id === "string" ? args.bot_id : args.botId,
            });
            if (!teammate) return { error: "bot not found" };
            const peer = await createPeerWake(deps.prisma, actor, {
              fromBotId: bot.id,
              toBotId: teammate.id,
              text: String(args.message ?? ""),
              webhookId: run.webhookId,
            });
            await deps.wakeup?.enqueue({
              name: "run.continue",
              payload: { runId: peer.run.id },
            });
            // Waiting inline used to hold one of the four worker slots for up to four minutes.
            // The wait becomes a checkpoint: this turn ends here and resumes with the answer
            // when the teammate finishes (or when the timeout wake below fires).
            const deadlineAt = new Date(Date.now() + PEER_WAIT_TIMEOUT_MS);
            const pendingPeerAsk: PendingPeerAsk = {
              peerRunId: peer.run.id,
              botId: teammate.id,
              botName: teammate.name,
              question: String(args.message ?? ""),
              executionId,
              deadlineAt: deadlineAt.toISOString(),
            };
            await deps.prisma.run.update({
              where: { id: runId },
              data: {
                status: "waiting_input",
                checkpoint: peerCheckpoint(pendingPeerAsk),
              },
            });
            await deps.wakeup?.enqueue({
              name: "run.continue",
              payload: { runId },
              runAt: deadlineAt,
              jobKey: peerWaitJobKey(runId),
            });
            pausedForPeer = true;
            await stopRuntime();
            throw new PeerPause();
          }
          if (name === "run_subagent") {
            return {
              ok: true,
              result: String(args.task ?? "done."),
            };
          }
          if (name === "spawn_bot") {
            const spawned = await spawnBot(deps, {
              spawnedBy: {
                id: bot.id,
                name: bot.name,
                workspaceId: bot.workspaceId,
                userId: run.userId,
              },
              runId,
              name: String(args.name ?? ""),
              title: args.title ? String(args.title) : undefined,
              instructions: args.instructions ? String(args.instructions) : undefined,
              prompt: args.prompt ? String(args.prompt) : undefined,
              // Same rule as ask_bot/message_teammate: the child's first run keeps the ordinary
              // "spawn" trigger, but inherits the causal webhookId.
              webhookId: run.webhookId,
            });
            if ("error" in spawned) return spawned;
            if (spawned.duplicate) {
              return {
                ok: true,
                botId: spawned.botId,
                name: spawned.name,
                title: spawned.title,
                duplicate: true,
              };
            }
            await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
              {
                kind: "child_bot",
                botId: spawned.botId,
                name: spawned.name,
                title: spawned.title,
                status: "created",
              },
            ]);
            await appendEvent(deps.prisma, {
              workspaceId: run.workspaceId,
              threadId: thread.id,
              botId: bot.id,
              runId: run.id,
              type: "bot.spawned",
              payload: { childBotId: spawned.botId, name: spawned.name },
            });
            return spawned;
          }
          if (name === "delete_bot") {
            const removed = await deleteSpawnedBot(
              deps,
              {
                spawnedByBotId: bot.id,
                userId: run.userId,
                workspaceId: run.workspaceId,
                confirmName: String(args.confirm_name ?? args.confirmName ?? ""),
                botId: args.bot_id
                  ? String(args.bot_id)
                  : args.botId
                    ? String(args.botId)
                    : undefined,
              },
              context,
            );
            if ("error" in removed) return removed;
            await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
              {
                kind: "child_bot",
                botId: removed.botId,
                name: removed.name,
                status: "deleted",
              },
            ]);
            await appendEvent(deps.prisma, {
              workspaceId: run.workspaceId,
              threadId: thread.id,
              botId: bot.id,
              runId: run.id,
              type: "bot.deleted",
              payload: { childBotId: removed.botId, name: removed.name },
            });
            return removed;
          }
          const mcpCall = parseMcpToolName(name);
          if (mcpCall) {
            const source = matchMcpSource(mcpSources, mcpCall.sourceSlug);
            if (!source) return { error: `MCP source not found for ${name}` };
            return callMcpTool(source, mcpCall.tool, args);
          }
          if (deps.connector) {
            let result: unknown = { error: `unknown tool ${name}` };
            for await (const event of deps.connector.execute(
              { tool: name, args, executionId },
              context,
            )) {
              if (event.type === "result") {
                result = event.data;
                const logIds = collectLogIds(event.data);
                for (const logId of logIds) {
                  await appendEvent(deps.prisma, {
                    workspaceId: run.workspaceId,
                    threadId: thread.id,
                    botId: bot.id,
                    runId: run.id,
                    type: "effect.recorded",
                    payload: { tool: name, logId },
                  });
                }
              }
              if (event.type === "error") result = { error: event.message };
            }
            return result;
          }
          return { error: `unknown tool ${name}` };
        };

        const gatedTool = async (
          name: string,
          args: Record<string, unknown>,
          executionId: string,
        ) => {
          const serializedArgs = JSON.stringify(args);
          if (containsSecret(serializedArgs, runSecrets)) {
            throw new Error("refusing to execute a tool request containing a secret");
          }
          const latest = await deps.prisma.bot.findUniqueOrThrow({
            where: { id: bot.id },
            select: { autoApprove: true, alwaysAllow: true },
          });
          const summary = redactSecrets(toolSummary(name, args), runSecrets);
          // A webhook run (and any peer/spawn hop it causes, via `unattended` above) has nobody
          // watching for the approval card, so it never inherits the bot's standing "always
          // allow"/auto-approve consent.
          const allowed = autoDecision(
            { autoApprove: latest.autoApprove, alwaysAllow: latest.alwaysAllow },
            name,
            summary,
            { unattended },
          );
          if (!allowed) {
            const allowKey = approvalKey(name, summary);
            const pending = {
              requestId: executionId,
              tool: name,
              args,
              executionId,
              allowKey,
              summary,
            };
            await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
              {
                kind: "ask",
                text: "Preciso da sua aprovação",
                detail: summary,
                tool: name,
                allowKey,
                requestId: executionId,
                actions: [
                  { id: "allow", label: "Permitir" },
                  { id: "deny", label: "Recusar" },
                  // "Sempre permitir" grants standing consent for every future run of this bot,
                  // including unattended ones — never offer it on a card nobody may be watching
                  // in real time, nor on a destructive/sensitive card it would not unlock anyway.
                  // Explicit "allow" for this one call still applies once below.
                  ...(canAlwaysAllow(name, summary, { unattended })
                    ? [{ id: "always" as const, label: "Sempre permitir" }]
                    : []),
                ],
              },
            ]);
            await deps.prisma.run.update({
              where: { id: runId },
              data: {
                status: "waiting_input",
                checkpoint: approvalCheckpoint(pending),
              },
            });
            await notifyRun(deps, run, {
              kind: "help",
              title: `${bot.name} precisa de aprovação`,
              body: summary.slice(0, 180),
              botId: bot.id,
              threadId: thread.id,
            });
            pausedForApproval = true;
            await stopRuntime();
            throw new ApprovalPause();
          }
          if (runAbort.signal.aborted) throw new ApprovalPause();
          return applyTool(name, args, executionId);
        };

        const pluginLine =
          connectedProviders.length > 0
            ? `Available plugin providers: ${connectedProviders.join(", ")}. Use their discovered tools when the user asks about those apps.`
            : "No plugins are connected yet.";
        const installedSkills = instructionOnlyInstalls(installs);
        const skillLine = formatSkillPrompt(
          installedSkills
            .filter((row) => row.kind === "skill")
            .map((row) => ({
              name: row.name,
              source: row.source,
              config:
                row.config && typeof row.config === "object" && !Array.isArray(row.config)
                  ? (row.config as Record<string, unknown>)
                  : {},
            })),
        );
        const mcpLine = mcpSources.length
          ? `MCP servers are live tools (names start with mcp__). Sources: ${mcpSources.join(", ")}.`
          : installedSkills.some((row) => row.kind === "mcp")
            ? `Installed MCP entries (instruction-only): ${installedSkills
                .filter((row) => row.kind === "mcp")
                .map((row) => row.name)
                .join(", ")}.`
            : "";
        const memoryLine = formatMemoryPrompt(
          (
            await Promise.all([
              deps.memory.read({ scope: "bot", botId: bot.id, path: "MEMORY.md" }, context),
              deps.memory.read({ scope: "user" }, context),
            ])
          ).flatMap((snapshot, index) =>
            snapshot.documents.map((doc) => ({
              scope: index === 0 ? "bot" : "user",
              path: doc.path,
              content: doc.content,
            })),
          ),
        );

        const group = thread.botGroupId
          ? await deps.prisma.botGroup.findUnique({
              where: { id: thread.botGroupId },
              include: {
                members: {
                  include: { bot: { select: { id: true, name: true } } },
                },
              },
            })
          : null;
        const groupLines = group
          ? [
              `You are ${bot.name}, replying inside the shared group chat "${group.name}" with ${group.members
                .filter((member) => member.botId !== bot.id)
                .map((member) => member.bot.name)
                .join(
                  ", ",
                )}. Everyone in the group sees your reply; keep it short and do not repeat what teammates already said.`,
              group.instructions ? `Group instructions:\n${group.instructions}` : "",
            ]
          : [];

        const resumeApproval = parseRunCheckpoint(run.checkpoint);
        // Quem retoma depois de uma aprovação não pode receber o pedido original de
        // novo como último turno: o modelo lê a instrução, chama a mesma ferramenta
        // e o card de aprovação volta — o mesmo comando pedindo permissão sem fim.
        let resumedAfterApproval = false;
        if (resumeApproval.pendingApproval) {
          if (!resumeApproval.decision) {
            await deps.prisma.run.update({
              where: { id: runId },
              data: { status: "waiting_input" },
            });
            return;
          }
          const pending = resumeApproval.pendingApproval;
          // A stale checkpoint or any other caller could still land a raw "always" here even
          // though the unattended card never offered that action — coerce it to a one-shot
          // allow rather than trust it.
          const decision = scopeApprovalDecision(resumeApproval.decision, {
            unattended,
            standingAllowed: canAlwaysAllow(pending.tool, pending.summary, {
              unattended,
            }),
          });
          if (decision === "always") {
            await deps.prisma.bot.update({
              where: { id: bot.id },
              data: { alwaysAllow: { push: pending.allowKey } },
            });
          }
          if (decision === "deny") {
            history.push({
              role: "system",
              content: `The user denied ${pending.tool}: ${pending.summary}`,
            });
            await deps.prisma.externalEffect
              .updateMany({
                where: { idempotencyKey: pending.executionId },
                data: { status: "failed", result: { error: "denied by user" } },
              })
              .catch(() => undefined);
          } else {
            const result = await applyTool(pending.tool, pending.args, pending.executionId);
            history.push({
              role: "system",
              content: `The user allowed ${pending.tool}. Result: ${JSON.stringify(result)}`,
            });
          }
          await markAskAnswered(deps, thread.id, pending.requestId, decision);
          await deps.prisma.run.update({
            where: { id: runId },
            data: { checkpoint: null },
          });
          resumedAfterApproval = true;
        }

        const progress = createProgressThrottle();

        try {
          for await (const event of untilAborted(
            deps.runtime.run(
              {
                botId: bot.id,
                threadId: thread.id,
                runId,
                prompt: promptForRun(task.prompt, resumedAfterApproval),
                instructions: [
                  bot.instructions || `${bot.name}: ${bot.title}\n${bot.description}`,
                  ...groupLines,
                  tools.some((tool) => tool.name === "computer")
                    ? "Use computer to inspect and operate the graphical desktop. Call it with exactly one action, inspect the fresh screenshot it returns, and only then choose the next action. computer screenshots are observations for you; use screenshot when the person asked to receive the image in chat."
                    : "",
                  'You have a persistent computer with a real graphical desktop and a browser. Use open_url to open HTTP or HTTPS pages inside that browser without asking for approval; never use shell/xdg-open for normal page navigation. Use write_file to save files into your home (they appear in Files). Use shell to run commands in that computer. Use the memory tool proactively for durable facts (MEMORY.md = your notes, USER.md = who the user is; add/replace/remove compact § entries). Use save_skill when the user wants to reuse a method (they can type /Name later). Use create_routine when they want work on a schedule. When you hit something only the person can do — a login or password, a two-factor or captcha, a payment, a file chooser, or any choice you should not make for them — call request_takeover with a plain reason ("preciso que você faça o login no banco") and stop there; do not guess a password, invent data, or click past it. Prefer asking to acting when you are unsure and the action is hard to undo. Use destination.write only for connected destination records.',
                  // Sem esta linha o modelo não sabia que enxerga a própria tela: com o bot
                  // instruído, o texto de fallback do runtime que ensinava `screenshot` era
                  // descartado, e ele respondia "não consigo capturar prints" a um pedido
                  // que a ferramenta resolve em um passo.
                  "To show something, send it — do not describe it and do not ask what to do: `screenshot` puts a picture of your current screen into the chat right away; `record_screen` puts a short video of it there; `send_file` sends any file from your computer (a PDF, a spreadsheet, a recording). If the person asks for a print, a screenshot, a picture of the screen, or to see a page: open it with `open_url` if it is not open yet, wait for that result, and only then call `screenshot` — one tool call at a time, never both in the same turn, or the picture shows the screen before the page loaded. You can open any website; there is no such thing as an external site you cannot capture.",
                  localTools.length
                    ? "You can collaborate with other bots. Use list_bots or list_teammates to discover them. Use ask_bot when you need a reply before continuing. Use message_teammate for a fire-and-forget recado. When the person puts you in charge of something — tells you to coordinate, to lead, to be the chief of a task — take it: split the work, hand pieces to the teammates that fit with ask_bot or message_teammate, and bring the results back together here. Being in charge is something the person tells you in the conversation, not a setting."
                    : "",
                  bot.chiefOfStaff
                    ? chiefOfStaffSystemPrompt(
                        bot.id,
                        (
                          await deps.prisma.bot.findMany({
                            where: {
                              workspaceId: run.workspaceId,
                              userId: run.userId,
                            },
                            select: {
                              id: true,
                              name: true,
                              title: true,
                              description: true,
                            },
                          })
                        ).map((row) => ({
                          id: row.id,
                          name: row.name,
                          title: row.title,
                          description: row.description,
                        })),
                        localTools.some((tool) => tool.name === "ask_bot"),
                      )
                    : "",
                  "A bot and a subagent are different. Never use both for the same request.",
                  "spawn_bot creates a lasting regular bot (own chat, computer, memory) that appears in the user's bot list. If the user asked to create a bot, call spawn_bot once and stop. Do not run_subagent to demo it.",
                  "run_subagent is a short helper inside this turn only. It is not a bot, has no thread, and does not show in the list. Use it for parallel work you will summarize here.",
                  "delete_bot permanently destroys a bot this bot created, and only that bot. Only delete when the user asked or that bot is finished and unused. confirm_name must exactly match its name.",
                  pluginLine,
                  skillLine,
                  mcpLine,
                  memoryLine,
                  "Never print API keys, access tokens, or secret values. Prefer tools over claiming you already did the work.",
                  // Bots já criados carregam o roteiro de "primeira conversa" nas instruções; sem
                  // esta regra ele engolia um pedido direto atrás de perguntas de apresentação.
                  "A direct request always comes first: if the person asks for something concrete (a print, a file, a search, an action), do it now with your tools and skip any getting-to-know-you questions. Ask at most one short question, and only when you truly cannot act without the answer.",
                ].join("\n\n"),
                history,
                tools,
                model: {
                  provider: credential?.provider ?? settings?.defaultModelProvider ?? "scripted",
                  id: credential?.defaultModel ?? settings?.defaultModelId ?? "scripted",
                  apiKey,
                  oauthCredential,
                },
                resumeFromCheckpoint: resumeFromTakeover ? "takeover" : undefined,
                script,
                executeTool: scripted ? undefined : gatedTool,
              },
              context,
            ),
            runAbort.signal,
          )) {
            if (pausedForApproval || pausedForPeer) return;
            if (watcher.lost()) {
              await stopRuntime();
              return;
            }

            if (event.type === "text") {
              assembled += event.text;
              if (!scripted && progress.shouldPublish(assembled, Date.now())) {
                await publishLiveProgress(deps.prisma, {
                  workspaceId: run.workspaceId,
                  threadId: thread.id,
                  botId: bot.id,
                  runId,
                  payload: {
                    text: redactSecrets(assembled, runSecrets),
                    streaming: true,
                  },
                });
              }
            } else if (event.type === "progress") {
              await publishLiveProgress(deps.prisma, {
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                runId,
                payload: { text: redactSecrets(event.text, runSecrets) },
              });
            } else if (event.type === "ask") {
              await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
                {
                  kind: "ask",
                  text: redactSecrets(event.text, runSecrets),
                  detail: event.detail ? redactSecrets(event.detail, runSecrets) : undefined,
                },
              ]);
              await deps.prisma.run.update({
                where: { id: runId },
                data: { status: "waiting_input" },
              });
              await notifyRun(deps, run, {
                kind: "help",
                title: `${bot.name} needs an answer`,
                body: redactSecrets(event.text, runSecrets),
                botId: bot.id,
                threadId: thread.id,
              });
              return;
            } else if (event.type === "takeover") {
              if (assembled.trim()) {
                await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
                  { kind: "text", text: redactSecrets(assembled, runSecrets) },
                ]);
              }
              await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
                {
                  kind: "computer",
                  state: "Ready",
                  text: redactSecrets(event.reason, runSecrets),
                },
              ]);
              await appendEvent(deps.prisma, {
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "computer.takeover.requested",
                runId,
                payload: { reason: redactSecrets(event.reason, runSecrets) },
              });
              await deps.prisma.desktopSession.updateMany({
                where: { botId: bot.id },
                data: { state: "running", controlHolder: "none" },
              });
              await deps.prisma.run.update({
                where: { id: runId },
                data: { status: "waiting_takeover" },
              });
              await notifyRun(deps, run, {
                kind: "takeover",
                title: `${bot.name} needs you on the screen`,
                body: redactSecrets(event.reason, runSecrets),
                botId: bot.id,
                threadId: thread.id,
              });
              return;
            } else if (event.type === "tool") {
              if (scripted) await applyTool(event.name, event.args, event.executionId);
            } else if (event.type === "subagent") {
              await appendEvent(deps.prisma, {
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "thread.subagent",
                runId,
                payload: {
                  agentId: event.agentId,
                  name: redactSecrets(event.name, runSecrets),
                  task: redactSecrets(event.task, runSecrets),
                  status: event.status,
                  progress: event.progress ? redactSecrets(event.progress, runSecrets) : undefined,
                  result: event.result ? redactSecrets(event.result, runSecrets) : undefined,
                },
              });
              if (event.status === "completed" || event.status === "failed") {
                await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
                  {
                    kind: "subagent",
                    agentId: event.agentId,
                    name: redactSecrets(event.name, runSecrets),
                    task: redactSecrets(event.task, runSecrets),
                    status: event.status,
                    progress: event.progress
                      ? redactSecrets(event.progress, runSecrets)
                      : undefined,
                    result: event.result ? redactSecrets(event.result, runSecrets) : undefined,
                  },
                ]);
              }
            } else if (event.type === "usage") {
              await deps.prisma.usageRecord.create({
                data: {
                  workspaceId: run.workspaceId,
                  botId: bot.id,
                  userId: run.userId,
                  runId,
                  provider: event.provider,
                  model: event.model,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  paidBy: credential ? "user" : "plan",
                },
              });
            } else if (event.type === "error") {
              // Erro passageiro do provedor (429, 502, socket mudo): o run volta para a fila
              // uma vez em vez de virar uma resposta de erro no chat. Nunca depois de uma
              // aprovação: o resultado dela vive só na memória deste turno e o recomeço
              // pediria o mesmo card de novo.
              if (
                event.retryable &&
                !scripted &&
                !resumedAfterApproval &&
                (await requeueRunAfterProviderError(deps, {
                  runId,
                  fence,
                  reason: redactSecrets(event.message, runSecrets),
                }))
              ) {
                requeued = true;
                await publishLiveProgress(deps.prisma, {
                  workspaceId: run.workspaceId,
                  threadId: thread.id,
                  botId: bot.id,
                  runId,
                  payload: { text: PROVIDER_RETRY_PROGRESS_MESSAGE },
                });
                await stopRuntime();
                return;
              }
              // Sem nova tentativa automática, a pessoa lê o erro — e, se ele era passageiro,
              // o convite a tentar de novo.
              assembled += event.retryable ? `${event.message} ${TRY_AGAIN_HINT}` : event.message;
            } else if (event.type === "done") {
              assembled = assembled || event.text || assembled;
            }
          }

          for (const turn of script ?? []) {
            for (const file of turn.files ?? []) {
              await deps.home.writeFile(bot.id, file.path, file.content, context);
            }
            for (const mem of turn.memory ?? []) {
              await deps.memory.commit(
                {
                  scope: mem.scope,
                  botId: mem.scope === "bot" ? bot.id : undefined,
                  path: mem.path,
                  content: mem.content,
                  sourceRunId: runId,
                  sourceThreadId: thread.id,
                },
                context,
              );
              await appendEvent(deps.prisma, {
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "memory.revised",
                runId,
                payload: { path: mem.path, scope: mem.scope },
              });
            }
          }

          if (pausedForApproval || pausedForPeer) return;
          if (watcher.lost()) return;
          const text = redactSecrets(assembled || "done.", runSecrets);
          if (containsSecret(text, runSecrets)) {
            throw new Error("refusing to persist a secret in the thread");
          }
          // Fenced: if another worker took the run over while we streamed, its result wins and
          // this turn writes nothing.
          const finished = await deps.prisma.run.updateMany({
            where: { id: runId, leaseFence: fence },
            data: {
              status: "completed",
              completedAt: new Date(),
              leaseOwner: null,
              leaseExpiresAt: null,
            },
          });
          if (finished.count !== 1) return;
          await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
            { kind: "text", text },
          ]);
          await deps.prisma.task.update({
            where: { id: run.taskId },
            data: { status: "completed" },
          });
          await appendEvent(deps.prisma, {
            workspaceId: run.workspaceId,
            threadId: thread.id,
            botId: bot.id,
            type: "run.completed",
            runId,
            payload: {},
          });
          await pruneProgressEvents(deps.prisma, runId).catch(() => undefined);
          await deps.prisma.bot.update({
            where: { id: bot.id },
            data: { updatedAt: new Date(), unread: true },
          });
          if (bot.notifyOnFinish) {
            await notifyRun(deps, run, {
              kind: "completion",
              title: `${bot.name} finished`,
              body: text.slice(0, 180),
              botId: bot.id,
              threadId: thread.id,
            });
          }
        } catch (error) {
          if (error instanceof ApprovalPause) return;
          await failRun(deps, run, error, fence, bot.name, bot.notifyOnFinish, runSecrets);
        } finally {
          watcher.stop();
          // Teammates parked on this run resume as soon as it stops, whatever the outcome.
          await wakeRunsWaitingForPeer(deps, runId).catch(() => undefined);
          // The bot is free again: give its oldest queued run its turn without waiting for the
          // retry timer. Depois de um requeue o bot não está livre: acordar outro run agora
          // deixaria ele furar a fila na frente deste, e a pessoa leu "em instantes".
          if (!requeued) {
            await wakeNextRunForBot(deps, {
              botId: run.botId,
              exceptRunId: runId,
            }).catch(() => undefined);
          }
        }
      } finally {
        watcher.stop();
      }
    },
  };
}

/** Provider slugs that may be sent to connector discovery/execution. */
export function connectedProviderSlugs(
  connections: Array<{ provider: string }>,
  installs: Array<{ kind: string; source: string }>,
): string[] {
  return [
    ...new Set([
      ...connections.map((row) => row.provider),
      ...installs
        .filter((row) => row.kind === "connection" || row.kind === "plugin")
        .map((row) => row.source),
    ]),
  ].filter(Boolean);
}

/** Installs without a runtime stay as model instructions only. */
export function instructionOnlyInstalls<T extends { kind: string }>(installs: T[]): T[] {
  return installs.filter((row) => row.kind === "skill");
}

async function resolveTeammate(
  prisma: PrismaClient,
  run: { workspaceId: string; userId: string },
  selfBotId: string,
  args: Record<string, unknown>,
) {
  const requestedId = typeof args.botId === "string" ? args.botId : undefined;
  const requestedName = typeof args.name === "string" ? args.name : undefined;
  return prisma.bot.findFirst({
    where: {
      workspaceId: run.workspaceId,
      userId: run.userId,
      id: { not: selfBotId },
      ...(requestedId ? { id: requestedId } : {}),
      ...(requestedId || !requestedName
        ? {}
        : { name: { equals: requestedName, mode: "insensitive" } }),
    },
    select: { id: true, name: true },
  });
}

async function notifyRun(
  deps: ExecutorDeps,
  run: { workspaceId: string; userId: string; botId: string; threadId: string },
  message: NotificationMessage,
) {
  if (!deps.notifications) return;
  await deps.notifications
    .send(message, {
      operationId: "notify",
      traceId: run.botId,
      workspaceId: run.workspaceId,
      userId: run.userId,
      botId: run.botId,
      signal: new AbortController().signal,
    })
    .catch(() => undefined);
}

/**
 * Stops consuming a runtime stream as soon as the run is aborted, even if the runtime is
 * slow to notice; the source iterator is closed so it can tear itself down.
 */
async function* untilAborted<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    const done = () => resolve({ done: true, value: undefined as never });
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void iterator.return?.().catch(() => undefined);
  }
}

async function failRun(
  deps: ExecutorDeps,
  run: {
    id: string;
    taskId: string;
    workspaceId: string;
    userId: string;
    botId: string;
    threadId: string;
  },
  error: unknown,
  fence: number,
  botName = "Bot",
  notify = false,
  secrets: string[] = deps.secrets,
): Promise<void> {
  const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
  // Same fence as successful completion: a stolen or already-finished run must not be
  // overwritten by a worker that no longer owns the row.
  const finished = await deps.prisma.run.updateMany({
    where: { id: run.id, leaseFence: fence },
    data: {
      status: "failed",
      error: message,
      completedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  if (finished.count !== 1) return;
  await deps.prisma.task.update({
    where: { id: run.taskId },
    data: { status: "failed" },
  });
  await appendEvent(deps.prisma, {
    workspaceId: run.workspaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "run.failed",
    runId: run.id,
    payload: { error: message },
  });
  await pruneProgressEvents(deps.prisma, run.id).catch(() => undefined);
  await wakeRunsWaitingForPeer(deps, run.id).catch(() => undefined);
  await wakeNextRunForBot(deps, {
    botId: run.botId,
    exceptRunId: run.id,
  }).catch(() => undefined);
  if (notify) {
    await notifyRun(deps, run, {
      kind: "failure",
      title: `${botName} failed`,
      body: message.slice(0, 180),
      botId: run.botId,
      threadId: run.threadId,
    });
  }
}

async function markAskAnswered(
  deps: ExecutorDeps,
  threadId: string,
  requestId: string,
  answered: string,
) {
  const rows = await deps.prisma.message.findMany({
    where: { threadId, role: "bot" },
    orderBy: { seq: "desc" },
    take: 200,
  });
  for (const row of rows) {
    const blocks = row.blocks as MessageBlock[];
    const index = blocks.findIndex(
      (block) => block.kind === "ask" && block.requestId === requestId && !block.answered,
    );
    if (index < 0) continue;
    const next = blocks.map((block, i) =>
      i === index && block.kind === "ask" ? { ...block, answered } : block,
    );
    await deps.prisma.message.update({
      where: { id: row.id },
      data: { blocks: next as never },
    });
    return;
  }
}

async function publishMessage(
  deps: ExecutorDeps,
  _actor: Actor,
  threadId: string,
  botId: string,
  runId: string,
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
) {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    select: { activeConversationId: true },
  });
  const conversation = bot?.activeConversationId
    ? await deps.prisma.conversation.findUnique({
        where: { id: bot.activeConversationId },
      })
    : null;
  const message = await appendThreadMessage(deps.prisma, {
    threadId,
    role,
    blocks,
    runId,
    authorBotId: role === "bot" ? botId : undefined,
    conversationId: conversation?.id,
    parentId: conversation?.activeLeafId,
  });
  await appendEvent(deps.prisma, {
    workspaceId: (await deps.prisma.thread.findUniqueOrThrow({ where: { id: threadId } }))
      .workspaceId,
    threadId,
    botId,
    type: "thread.message.created",
    runId,
    payload: {
      messageId: message.id,
      role,
      blocks,
      ...(role === "bot" ? { authorBotId: botId } : {}),
    },
  });
  return message;
}

/**
 * Idempotency for tool side effects. `status` is the whole point of the row: only an effect
 * that actually returned counts as already applied. One left at `intended` (the worker died
 * mid-tool) or at `failed` never touched the outside world, so replaying the turn has to run
 * it again instead of handing the model the previous result — otherwise the bot reports work
 * that never happened.
 */
export async function recordEffect(
  deps: ExecutorDeps,
  run: { id: string; workspaceId: string },
  kind: string,
  executionId: string,
  request: Record<string, unknown>,
) {
  const existing = await deps.prisma.externalEffect.findUnique({
    where: { idempotencyKey: executionId },
  });
  if (existing?.status === "completed") {
    const row = await deps.prisma.run.findUniqueOrThrow({
      where: { id: run.id },
      select: { threadId: true, botId: true },
    });
    await appendEvent(deps.prisma, {
      workspaceId: run.workspaceId,
      threadId: row.threadId,
      botId: row.botId,
      type: "effect.reconciled",
      runId: run.id,
      payload: { executionId, kind },
    });
    return { duplicate: true, effect: existing };
  }
  if (existing) {
    // The key is unique, so the unfinished attempt is reclaimed rather than duplicated.
    const retried = await deps.prisma.externalEffect.update({
      where: { id: existing.id },
      data: {
        runId: run.id,
        status: "intended",
        request: request as never,
        result: Prisma.DbNull,
      },
    });
    return { duplicate: false, effect: retried };
  }
  const effect = await deps.prisma.externalEffect.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      kind,
      idempotencyKey: executionId,
      status: "intended",
      request: request as never,
    },
  });
  return { duplicate: false, effect };
}

async function completeEffect(deps: ExecutorDeps, effectId: string, result: unknown) {
  await deps.prisma.externalEffect.update({
    where: { id: effectId },
    data: { status: "completed", result: (result ?? { ok: true }) as never },
  });
}

/**
 * Hands the keyboard back to the bot, but only when no member holds a live takeover lease.
 *
 * `ensureComputer` used to write `controlHolder: "bot"` unconditionally, so a routine firing or
 * any tool that boots the computer silently took the keyboard from someone who was typing on the
 * screen — and their next input was refused with "bot_in_control", which was a lie about what
 * happened. The condition lives in the `where` (never in a read-then-decide) so a takeover
 * landing at the same moment simply makes this update match nothing.
 */
export async function reclaimComputerControlForBot(
  prisma: PrismaClient,
  botId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const claimed = await prisma.desktopSession.updateMany({
    where: {
      botId,
      // Mirrors `controlLeaseLive` from @quibt/core: only a "user" holder with a deadline
      // still in the future is live; a legacy row without a deadline is dead.
      OR: [
        { controlHolder: { not: "user" } },
        { controlLeaseExpiresAt: null },
        { controlLeaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      controlHolder: "bot",
      controlLeaseId: null,
      controlLeaseUserId: null,
      controlLeaseExpiresAt: null,
    },
  });
  return claimed.count === 1;
}

export async function workerBootComputer(
  deps: ExecutorDeps,
  botId: string,
  context: {
    operationId: string;
    traceId: string;
    workspaceId: string;
    userId: string;
    botId?: string;
    runId?: string;
    signal: AbortSignal;
  },
): Promise<ComputerRef> {
  return bootComputer(deps, botId, context, {
    assignControlToBot: false,
    afterPersist: async (prisma, botId) => {
      await reclaimComputerControlForBot(prisma, botId);
    },
  });
}

async function ensureComputer(
  deps: ExecutorDeps,
  botId: string,
  context: {
    operationId: string;
    traceId: string;
    workspaceId: string;
    userId: string;
    botId?: string;
    runId?: string;
    signal: AbortSignal;
  },
): Promise<ComputerRef> {
  return workerBootComputer(deps, botId, context);
}

async function commitHermesMemory(
  deps: ExecutorDeps,
  input: {
    botId: string;
    runId: string;
    threadId: string;
    context: {
      operationId: string;
      traceId: string;
      workspaceId: string;
      userId: string;
      botId?: string;
      runId?: string;
      signal: AbortSignal;
    };
    args: Record<string, unknown>;
    alias: boolean;
  },
) {
  const requestedTarget = input.alias
    ? String(input.args.target ?? input.args.path ?? "memory")
        .toLowerCase()
        .includes("user")
      ? "user"
      : "memory"
    : String(input.args.target ?? "memory");
  const userDocs =
    requestedTarget === "user"
      ? await deps.memory.read({ scope: "user" }, input.context)
      : { documents: [] };
  const path =
    requestedTarget === "user"
      ? resolveUserMemoryPath(userDocs.documents.map((doc) => doc.path))
      : "MEMORY.md";
  const scope = requestedTarget === "user" ? "user" : "bot";
  const snapshot = await deps.memory.read(
    {
      scope,
      botId: scope === "bot" ? input.botId : undefined,
      path,
    },
    input.context,
  );
  const raw = snapshot.documents[0]?.content ?? "";
  const mutation = applyMemoryTool(
    raw,
    input.alias
      ? {
          action: "add",
          target: requestedTarget,
          content: String(input.args.content ?? ""),
        }
      : {
          action: input.args.action != null ? String(input.args.action) : undefined,
          target: requestedTarget,
          content: input.args.content != null ? String(input.args.content) : undefined,
          new_text: input.args.new_text != null ? String(input.args.new_text) : undefined,
          old_text: input.args.old_text != null ? String(input.args.old_text) : undefined,
          operations: Array.isArray(input.args.operations)
            ? (input.args.operations as Array<Record<string, unknown>>).map((op) => ({
                action: op.action != null ? String(op.action) : undefined,
                content: op.content != null ? String(op.content) : undefined,
                new_text: op.new_text != null ? String(op.new_text) : undefined,
                old_text: op.old_text != null ? String(op.old_text) : undefined,
              }))
            : undefined,
        },
  );
  if (!mutation.result.success || mutation.nextContent === undefined) {
    return mutation.result;
  }
  await deps.memory.commit(
    {
      scope,
      botId: scope === "bot" ? input.botId : undefined,
      path,
      content: mutation.nextContent,
      sourceRunId: input.runId,
      sourceThreadId: input.threadId,
    },
    input.context,
  );
  return mutation.result;
}

/** O tipo sai da extensão: `file` nem sempre está na imagem, e a extensão é o que o modelo escreve. */
function mimeTypeForName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    zip: "application/zip",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
  };
  return known[ext] ?? "application/octet-stream";
}

/**
 * O diretório que o modelo pede para um comando, do jeito que o exec do Docker aceita.
 *
 * O modelo manda `~/`, `~/Downloads`, `./pasta`, `/home/user`, ou nada: o exec exige
 * caminho absoluto e morre com "Cwd must be an absolute path" / "chdir to cwd failed"
 * — e o bot lia isso como o computador não funcionando. A casa do bot é /home/quibt;
 * o que não for dela vira relativo a ela, e uma casa de outro sistema vira a dela.
 */
export function sandboxCwd(raw: unknown, home = "/home/quibt"): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value === "~" || value === "~/" || value === "." || value === "./") return home;
  if (value.startsWith("~/")) return `${home}/${value.slice(2)}`.replace(/\/+$/, "") || home;
  if (value.startsWith("./")) return `${home}/${value.slice(2)}`.replace(/\/+$/, "") || home;
  if (
    /^\/(home|Users)\/[^/]+(\/|$)/.test(value) &&
    !value.startsWith(`${home}/`) &&
    value !== home
  ) {
    const rest = value.replace(/^\/(home|Users)\/[^/]+\/?/, "");
    return rest ? `${home}/${rest}`.replace(/\/+$/, "") : home;
  }
  if (!value.startsWith("/")) return `${home}/${value}`.replace(/\/+$/, "");
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

const COMPUTER_WAIT_MAX_MS = 10_000;
const COMPUTER_TOOL_TRANSACTION_TIMEOUT_MS = 20_000;
const COMPUTER_OBSERVATION_MAX_BYTES = 8 * 1024 * 1024;
const COMPUTER_MODIFIERS = new Set(["ctrl", "alt", "shift", "super"]);

type SandboxAgentInputCapabilities = {
  agentInput?: boolean;
};

type SandboxWithComputerDescriptor = SandboxProvider & {
  describeFor?(computer: ComputerRef): ReturnType<SandboxProvider["describe"]>;
};

export function sandboxSupportsAgentInput(
  sandbox: SandboxProvider,
  computer?: ComputerRef,
): boolean {
  const routed = sandbox as SandboxWithComputerDescriptor;
  const descriptor =
    computer && routed.describeFor ? routed.describeFor(computer) : sandbox.describe();
  return (descriptor.capabilities as SandboxAgentInputCapabilities).agentInput === true;
}

type ComputerToolTransaction = Pick<Prisma.TransactionClient, "run" | "desktopSession">;

export async function lockComputerForAgent(
  tx: ComputerToolTransaction,
  input: { runId: string; workerId: string; runFence: number; botId: string; now?: Date },
): Promise<
  | { ok: true; controlFence: number }
  | {
      ok: false;
      error: string;
      code: "run_lease_lost" | "computer_not_running" | "takeover_active";
    }
> {
  // Updating rows to their current owners acquires database locks. A stale worker or expired
  // lease cannot inject input, and takeover cannot cross the action -> observation boundary.
  const runLock = await tx.run.updateMany({
    where: {
      id: input.runId,
      status: "running",
      leaseOwner: input.workerId,
      leaseFence: input.runFence,
      leaseExpiresAt: { gt: input.now ?? new Date() },
    },
    data: { leaseOwner: input.workerId },
  });
  if (runLock.count !== 1) {
    return {
      ok: false,
      error: "Computer action refused because the run lease is no longer active.",
      code: "run_lease_lost",
    };
  }
  const session = await tx.desktopSession.findUnique({
    where: { botId: input.botId },
    select: {
      state: true,
      controlFence: true,
    },
  });
  if (session?.state !== "running") {
    return {
      ok: false,
      error: "Computer action refused because the desktop is not running.",
      code: "computer_not_running",
    };
  }
  const controlLock = await tx.desktopSession.updateMany({
    where: {
      botId: input.botId,
      state: "running",
      controlHolder: "bot",
      controlFence: session.controlFence,
    },
    data: { controlHolder: "bot" },
  });
  if (controlLock.count !== 1) {
    return {
      ok: false,
      error: "Computer action refused because a person has control of the desktop.",
      code: "takeover_active",
    };
  }
  return { ok: true, controlFence: session.controlFence };
}

export type ComputerToolAction =
  | { action: "screenshot" }
  | { action: "click"; input: ComputerInput }
  | { action: "type"; input: ComputerInput }
  | { action: "key"; input: ComputerInput }
  | { action: "scroll"; input: ComputerInput }
  | { action: "wait"; milliseconds: number };

function finiteCoordinate(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

export function parseComputerToolAction(
  args: Record<string, unknown>,
): ComputerToolAction | { error: string } {
  const action = String(args.action ?? "")
    .trim()
    .toLowerCase();
  if (action === "screenshot") return { action };
  if (action === "click") {
    const x = finiteCoordinate(args.x);
    const y = finiteCoordinate(args.y);
    if (x === null || y === null) return { error: "click requires non-negative x and y." };
    const button = args.button == null ? "left" : String(args.button).toLowerCase();
    if (button !== "left" && button !== "right") {
      return { error: "click button must be left or right." };
    }
    return {
      action,
      input: { kind: "pointer", type: "click", x, y, button },
    };
  }
  if (action === "type") {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text) return { error: "type requires non-empty text." };
    if (text.length > 32_768) return { error: "type text is limited to 32768 characters." };
    return { action, input: { kind: "clipboard", text } };
  }
  if (action === "key") {
    const key = typeof args.key === "string" ? args.key.trim() : "";
    if (!key) return { error: "key requires a key name." };
    if (key.length > 64) return { error: "key name is limited to 64 characters." };
    const modifiers = Array.isArray(args.modifiers)
      ? args.modifiers.map((value) => String(value).toLowerCase())
      : [];
    if (modifiers.length > 8 || modifiers.some((modifier) => !COMPUTER_MODIFIERS.has(modifier))) {
      return { error: "key modifiers must be ctrl, alt, shift, or super." };
    }
    return { action, input: { kind: "key", key, modifiers } };
  }
  if (action === "scroll") {
    const direction = String(args.direction ?? "down").toLowerCase();
    if (direction !== "up" && direction !== "down") {
      return { error: "scroll direction must be up or down." };
    }
    return {
      action,
      input: { kind: "key", key: direction === "up" ? "Page_Up" : "Page_Down" },
    };
  }
  if (action === "wait") {
    const requested = args.milliseconds == null ? 1_000 : Number(args.milliseconds);
    if (!Number.isFinite(requested) || requested < 0) {
      return { error: "wait milliseconds must be a non-negative number." };
    }
    return {
      action,
      milliseconds: Math.min(COMPUTER_WAIT_MAX_MS, Math.round(requested)),
    };
  }
  return {
    error: "action must be screenshot, click, type, key, scroll, or wait.",
  };
}

function waitForComputer(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("computer action aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("computer action aborted"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export async function executeComputerToolAction(input: {
  sandbox: SandboxProvider;
  computer: ComputerRef;
  args: Record<string, unknown>;
  lease: ControlLeaseRef;
  context: {
    operationId: string;
    traceId: string;
    workspaceId: string;
    userId: string;
    botId?: string;
    runId?: string;
    signal: AbortSignal;
  };
  capture?: () => Promise<{ mimeType: "image/png"; data: string } | { error: string }>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  const parsed = parseComputerToolAction(input.args);
  if ("error" in parsed) return parsed;
  if (parsed.action === "wait") {
    await (input.wait ?? waitForComputer)(parsed.milliseconds, input.context.signal);
  } else if ("input" in parsed) {
    await input.sandbox.sendInput(input.computer, parsed.input, input.lease, input.context);
  }
  const snapshot = await input.sandbox.snapshot(input.computer, input.context);
  const observation = input.capture ? await input.capture() : undefined;
  if (observation && "error" in observation) {
    return {
      ok: false as const,
      action: parsed.action,
      snapshot,
      observation,
      error: observation.error,
    };
  }
  return {
    ok: true as const,
    action: parsed.action,
    snapshot,
    ...(observation ? { observation } : {}),
  };
}

async function captureComputerImage(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: {
    operationId: string;
    traceId: string;
    workspaceId: string;
    userId: string;
    botId?: string;
    runId?: string;
    signal: AbortSignal;
  },
): Promise<{ mimeType: "image/png"; data: string } | { error: string }> {
  const target = screenshotPath(Date.now());
  const shot = await runSandboxCommand(
    sandbox,
    computer,
    screenshotCommand(target),
    "/home/quibt",
    context,
  );
  if (shot.code !== 0) {
    return { error: `Visual observation failed: ${shot.stderr.trim() || shot.code}` };
  }
  const encoded = await runSandboxCommand(
    sandbox,
    computer,
    [
      "bash",
      "-lc",
      'base64 -w0 -- "$1"; status=$?; rm -f -- "$1"; exit $status',
      "quibt-computer",
      target,
    ],
    "/home/quibt",
    context,
    COMPUTER_OBSERVATION_MAX_BYTES,
  );
  const data = encoded.stdout.trim();
  if (encoded.code !== 0 || !data || encoded.stderr.includes("[output truncated]")) {
    return { error: "Visual observation could not be encoded within the size limit." };
  }
  return { mimeType: "image/png", data };
}

export async function runSandboxCommand(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  argv: string[],
  cwd: string,
  context: {
    operationId: string;
    traceId: string;
    workspaceId: string;
    userId: string;
    botId?: string;
    runId?: string;
    signal: AbortSignal;
  },
  /** Um arquivo que volta em base64 passa muito do teto de um comando comum. */
  maxOutputBytes = 1024 * 1024,
) {
  let stdout = "";
  let stderr = "";
  let code = 0;
  let truncated = false;
  for await (const event of sandbox.execute(
    computer,
    { argv, cwd, timeoutMs: sandboxCommandTimeoutMs() },
    context,
  )) {
    if (event.type === "stdout" || event.type === "stderr") {
      const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
      const remaining = Math.max(0, maxOutputBytes - used);
      const data = Buffer.from(event.data).subarray(0, remaining).toString("utf8");
      if (event.type === "stdout") stdout += data;
      else stderr += data;
      if (Buffer.byteLength(event.data) > remaining) truncated = true;
    }
    if (event.type === "exit") code = event.code;
  }
  if (truncated) stderr += "\n[output truncated]";
  return { stdout, stderr, code };
}

async function resolveModelKey(
  deps: ExecutorDeps,
  userId: string,
  workspaceId: string,
  credential: { secretId: string; provider: string } | null,
): Promise<{ apiKey?: string; oauthCredential?: string; redact: string[] }> {
  if (credential && deps.secretStore) {
    const row = await deps.prisma.secret.findUnique({
      where: { id: credential.secretId },
    });
    if (row) {
      const plaintext = deps.secretStore.load(row.ciphertext);
      const parsed = parseModelSecret(plaintext);
      const apiKey = await resolveModelApiKey(plaintext, credential.provider, {
        persist: async (next) => {
          const stored = await deps.secretStore!.put(next, {
            operationId: "cred",
            traceId: "cred-refresh",
            workspaceId,
            userId,
            signal: new AbortController().signal,
          });
          await deps.prisma.secret.update({
            where: { id: row.id },
            data: { ciphertext: stored.ciphertext },
          });
        },
      });
      return {
        apiKey,
        // Provedores de assinatura recusam chave de API: o runtime precisa da
        // credencial inteira para registrá-la como credencial armazenada.
        oauthCredential: parsed.kind === "oauth" ? plaintext : undefined,
        redact: [...secretValuesToRedact(parsed), apiKey],
      };
    }
  }
  return { apiKey: deps.deploymentModelKey, redact: [] };
}

/** Como o modelo lê as reações que este recado recebeu. */
function reactionNote(reactions: unknown): string {
  if (!reactions || typeof reactions !== "object") return "";
  const marks = Object.entries(reactions as Record<string, unknown>)
    .filter(([, who]) => Array.isArray(who) && who.length > 0)
    .map(([emoji, who]) => `${emoji}×${(who as unknown[]).length}`);
  return marks.length ? `[o usuário reagiu: ${marks.join(" ")}]` : "";
}

/**
 * Como um recado antigo entra no histórico do modelo.
 *
 * Um card de aprovação ou um arquivo enviado não podem voltar como o texto cru que a tela
 * mostra ("Preciso da sua aprovação", o JSON do bloco): o modelo lia aquilo como fala
 * dele mesmo e repetia — quatro "Preciso da sua aprovação" seguidos e um JSON de arquivo
 * no lugar de chamar a ferramenta. Aqui cada bloco vira uma nota entre colchetes do que
 * de fato aconteceu, e o texto comum segue como texto.
 */
export function blocksToText(blocks: MessageBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "text":
        case "meta":
        case "progress":
        case "computer":
          return block.text;
        case "ask": {
          const what = [block.tool, block.detail].filter(Boolean).join(": ");
          const outcome =
            block.answered === "deny" || block.answered === "denied"
              ? "recusado pelo usuário"
              : block.answered === "always"
                ? "permitido pelo usuário (sempre)"
                : block.answered
                  ? "permitido pelo usuário"
                  : "sem resposta";
          return what
            ? `[pediu aprovação para ${what} — ${outcome}]`
            : `[${block.text} — ${outcome}]`;
        }
        case "file": {
          const label = block.image ? "enviou a imagem" : "enviou o arquivo";
          return `[${label} ${block.name}${block.caption ? ` — ${block.caption}` : ""}]`;
        }
        case "card":
          return block.lines.map((line) => `${line.k}: ${line.v}`).join("\n");
        case "choice":
          return [
            block.question,
            ...block.options.map((option) => `${option.letter}) ${option.label}`),
          ].join("\n");
        case "connect":
          return `[${block.name}: ${block.status === "connected" ? "conectado" : "pendente"}]`;
        case "subagent":
          return `[subagente ${block.name ?? ""} ${block.status ?? ""}${block.result ? `: ${block.result}` : ""}]`;
        case "child_bot":
          return block.status === "deleted"
            ? `[apagou o bot ${block.name ?? ""}]`
            : `[criou o bot ${block.name ?? ""}]`;
        default:
          return JSON.stringify(block);
      }
    })
    .filter(Boolean)
    .join("\n");
}
