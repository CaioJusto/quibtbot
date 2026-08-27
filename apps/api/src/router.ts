import path from "node:path";
import { implement, ORPCError } from "@orpc/server";
import type {
  AgentHomeStore,
  MemoryStore,
  NotificationProvider,
  SandboxProvider,
  WakeupDriver,
} from "@quibt/adapter-kit";
import {
  addFolderGrant,
  apiBootComputer,
  type ComposioConnector,
  ComposioKeyMissingError,
  composioAbortSignal,
  computerRefFromSession,
  DesktopSandboxProvider,
  defaultModelForProvider,
  destroyBot,
  type EncryptedSecretStore,
  ensureDesktopScreenUrl,
  failRunsWithoutWorker,
  isComposioUnknownOutcome,
  isComputerAlreadyStoppedError,
  isComputerUnreachableError,
  lessonCaptureCommand,
  lessonStartCommand,
  listPiCatalog,
  loadFolderGrants,
  onControlLeaseGranted,
  type PiOAuthLogins,
  parseLessonCapture,
  probeComputer,
  probeModelCredential,
  publicComputerBootMessage,
  removePushToken,
  revokeControlScreenOrSchedule,
  runSandboxCommand,
  sanitizeComposioError,
  savePushToken,
  scheduleComputerSleep,
  screenshotCommand,
  screenUsesTransientVncCredential,
  scriptedCatalogEntry,
  serializeModelSecret,
  touchRunningComputer,
  validateMcpEndpoint,
  workspaceProviderRef,
} from "@quibt/adapters";
import { type Auth, mailerEnabled } from "@quibt/auth";
import {
  type Actor,
  appContract,
  type ComputerStatus,
  type GroupThreadSnapshot,
  type Me,
  type MessageBlock,
  type ThreadSnapshot,
} from "@quibt/contracts";
import {
  activePath,
  bootableKind,
  type ControlDenial,
  canAlwaysAllow,
  canTakeControl,
  catalogDefinition,
  checkControlLease,
  controlLeaseLive,
  type EditionGate,
  editionGate,
  filterCatalog,
  grantControlLease,
  leafFrom,
  lessonIsEmpty,
  listPickableMachines,
  nextCronDate,
  parseApprovalDecision,
  parseRunCheckpoint,
  projectMessages,
  type ResolvedMachine,
  releaseControlLease,
  resolveDeploymentMachine,
  runLooksStranded,
  scheduleControlReap,
  scopeApprovalDecision,
  titleFromMessage,
  touchControlLease,
  UNTITLED_TASK,
} from "@quibt/core";
import {
  activeConversationForBot,
  appendEvent,
  appendThreadMessage,
  CapabilityInstallError,
  cancelThreadRuns,
  capabilityDigest,
  clearThread,
  closeComputerUsage,
  createGroupRoutineWakes,
  createGroupWakes,
  createPeerWake,
  createRepos,
  ensureDefaultConversation,
  eventsAfter,
  followThreadEvents,
  IsolationError,
  installCapability,
  isImage,
  isRunNonceConflict,
  mapConversation,
  type Pool,
  type PrismaClient,
  requireMembership,
  type WebhookReceiveResult,
  type WebhookService,
} from "@quibt/db";
import { type BillingService, selfHostedSnapshot } from "./billing.js";
import { deploymentNeedsFirstOwner } from "./bootstrap.js";
import { decideDeviceRequest, pendingDeviceRequests } from "./device-code-store.js";
import { rethrowIsolation } from "./isolation.js";
import { connectionCallbackUrl, type TrustedOriginEnv, withConnectionId } from "./origins.js";
import { addScreenProxyCapability, signStoredScreenUrl, withViewOnly } from "./screen-proxy.js";
import {
  buildWebhookCredential,
  normalizeWebhookBaseUrl,
  resolveWebhookPublicBase,
} from "./webhooks.js";
import { createWorkerPresenceReader, type WorkerPresenceReader } from "./worker-presence.js";

export interface RouterDeps {
  prisma: PrismaClient;
  auth: Auth;
  wakeup: WakeupDriver;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  home: AgentHomeStore;
  secrets: EncryptedSecretStore;
  oauthLogins: PiOAuthLogins;
  composio?: ComposioConnector;
  billing?: BillingService;
  webhookService: WebhookService;
  dataDir: string;
  pool?: Pool;
  /** Lets the sandbox routing drop its cached machine the moment the owner saves a new one. */
  onDeploymentSettingsChanged?: () => void;
  /** O fetch da sondagem da chave do modelo em `models.connect`; os testes injetam um falso. */
  probeFetch?: typeof fetch;
  /** Quem diz se há worker vivo; sem ele, lê o batimento direto do banco. */
  workerPresence?: WorkerPresenceReader;
  /** O push do celular, para o run que o reconciliador reprova quando ninguém está olhando. */
  notifications?: NotificationProvider;
  env: TrustedOriginEnv & {
    defaultProvider: string;
    defaultModel: string;
    openRouterKey?: string;
    screenProxySecret: string;
    /** Identidade operacional vinda de QUIBT_STACK_VERSION no Compose. */
    release?: string;
    edition?: "oss" | "cloud";
    billingEnabled?: boolean;
    sandboxProvider?: string;
    availableMachines?: string[];
    sandboxSupervisorUrl?: string;
    sandboxSupervisorToken?: string;
    e2bApiKey?: string;
    boxApiKey?: string;
    /** COMPOSIO_API_KEY do deploy; quando existe, a chave colada no app não é usada. */
    composioApiKey?: string;
    /** Sem mailer o `health` avisa, e a senha se redefine no próprio computador. */
    authEmailDisabled?: boolean;
    resendApiKey?: string;
    /** AGENT_RUNTIME: "pi" no produto; "scripted" só no emulador dos testes. */
    agentRuntime?: string;
    /**
     * SIGNUPS_ENABLED cru. Quando está definido, o .env é a única fonte do interruptor de
     * cadastro: a tela não pode gravar um valor que a próxima subida vai desfazer.
     */
    signupsEnabled?: string;
  };
}

/** Quem diz se há worker: o leitor injetado pela API, ou o batimento lido direto do banco. */
function workerPresenceFor(deps: RouterDeps): WorkerPresenceReader {
  return (
    deps.workerPresence ?? createWorkerPresenceReader({ prisma: deps.prisma, inProcess: false })
  );
}

/** The one gate: every edition question in this router answers through it. */
export function editionGateFor(env: RouterDeps["env"]): EditionGate {
  return editionGate({
    edition: env.edition,
    billingEnabled: env.billingEnabled,
  });
}

/** The one machine answer: saved choice when the edition allows it, process env otherwise. */
export function deploymentMachine(
  env: RouterDeps["env"],
  saved: string | null | undefined,
  extras?: { hasCredential?: boolean; endpoint?: string | null },
): ResolvedMachine {
  const available = [...(env.availableMachines ?? ["docker"])];
  const parsed = saved?.trim().toLowerCase();
  if (
    parsed &&
    !available.includes(parsed) &&
    (extras?.hasCredential || (parsed === "remote-supervisor" && extras?.endpoint))
  ) {
    available.push(parsed);
  }
  return resolveDeploymentMachine({
    saved,
    envProvider: env.sandboxProvider ?? "docker",
    canChooseMachine: editionGateFor(env).canChooseMachine,
    available,
  });
}

/** Why the server refused to type on the computer, in the words the screen shows. */
export function controlDenialMessage(reason: ControlDenial): string {
  if (reason === "expired") return "Seu controle expirou. Peça o controle de novo para continuar.";
  if (reason === "other_holder") return "Outra pessoa está no controle deste computador agora.";
  if (reason === "wrong_lease") return "Este controle não vale mais. Peça o controle de novo.";
  return "O bot está no controle deste computador.";
}

/** Tira do texto o que parece segredo antes de ele virar linha de log. */
function redactLogText(value: string): string {
  return value
    .replace(/data:[a-z/+-]+;base64,[A-Za-z0-9+/=]+/gi, "[conteúdo]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /(senha|password|secret|token|api[_-]?key|authorization|cookie)"?\s*[=:]\s*"?[^\s"',}]+/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b(sk-[A-Za-z0-9-]+|ak_[A-Za-z0-9]+|ck_[A-Za-z0-9]+|ey[A-Za-z0-9_-]{20,})/g,
      "[redacted]",
    )
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A linha que o servidor grava quando um handler do /rpc quebra, ou `null` quando o erro
 * é a resposta esperada para o cliente (404, 401, 403…). Antes não ficava rastro nenhum:
 * a tela via um erro e o servidor não dizia nem qual procedimento tinha quebrado.
 *
 * Vai só o procedimento, o tipo do erro e a mensagem já limpa. Nunca cabeçalho, cookie,
 * corpo da chamada nem segredo — o log do servidor não é lugar de guardar isso.
 */
export function rpcErrorLine(path: readonly string[], error: unknown): string | null {
  if (error instanceof ORPCError && error.status < 500) return null;
  const procedure = path.length ? path.join(".") : "(desconhecido)";
  const kind =
    error instanceof ORPCError
      ? `${error.name}(${error.code}/${error.status})`
      : error instanceof Error
        ? error.name || error.constructor.name
        : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactLogText(raw).slice(0, 300);
  return `[rpc] ${procedure} falhou: ${kind}${message ? `: ${message}` : ""}`;
}

/** Grava o erro do handler no log do servidor. Fica fora do handler para poder ser testada. */
export function logRpcError(
  path: readonly string[],
  error: unknown,
  write: (line: string) => void = console.error,
): void {
  const line = rpcErrorLine(path, error);
  if (line) write(line);
}

/** A prévia parada da tela, por bot: tirar um print custa ~1 s; quem olha em fila divide o mesmo. */
const PREVIEW_TTL_MS = 3_000;
/**
 * Quantos retratos ficam guardados. Cada um chega a 6 MB em base64 e o mapa nunca
 * esquecia ninguém: um servidor com muitos bots ia somando retratos de telas que ninguém
 * olha mais até faltar memória. O teto guarda os últimos vistos; o resto é recapturado.
 */
export const PREVIEW_CACHE_MAX = 8;
const previewCache = new Map<string, { image: string; at: number }>();

/** O retrato ainda válido deste bot, jogando fora o que passou do prazo. */
function readPreview(botId: string, now: number): { image: string; at: number } | null {
  const entry = previewCache.get(botId);
  if (!entry) return null;
  if (now - entry.at >= PREVIEW_TTL_MS) {
    previewCache.delete(botId);
    return null;
  }
  return entry;
}

/** Guarda o retrato novo, apaga os vencidos e despeja o mais velho quando passa do teto. */
function rememberPreview(botId: string, entry: { image: string; at: number }): void {
  for (const [id, cached] of previewCache) {
    if (entry.at - cached.at >= PREVIEW_TTL_MS) previewCache.delete(id);
  }
  // Reinserir põe o bot no fim da fila: o Map anda na ordem em que foi escrito.
  previewCache.delete(botId);
  previewCache.set(botId, entry);
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.delete(oldest);
  }
}

/** Quantos retratos estão guardados agora. Existe para o teste poder olhar o teto. */
export function previewCacheSize(): number {
  return previewCache.size;
}
/** Lê o PNG em base64 e apaga o arquivo, guardando o código do base64. */
const PREVIEW_ENCODE_SCRIPT = 'base64 -w0 "$1"; status=$?; rm -f -- "$1"; exit $status';

/** O retrato de cada bot vai num arquivo só dele: os bots de um Docker dividem o /tmp. */
export function previewImagePath(botId: string): string {
  const safe = botId.replace(/[^A-Za-z0-9_-]/g, "");
  return `/tmp/quibt-preview-${safe || "bot"}.png`;
}

export function createRouter(deps: RouterDeps) {
  const os = implement(appContract).$context<{
    actor: Actor | null;
    signal?: AbortSignal;
    /** Origem por onde o cliente chegou; a tela do bot é servida por ela. */
    screenOrigin?: string;
  }>();
  const repos = createRepos(deps.prisma);
  const workerPresence = workerPresenceFor(deps);

  const isolated = os.use(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      rethrowIsolation(error);
    }
  });

  const authed = isolated.use(async ({ context, next }) => {
    if (!context.actor) throw new ORPCError("UNAUTHORIZED");
    return next({ context: { actor: context.actor } });
  });

  return os.router({
    health: os.health.handler(async () => {
      const gate = editionGateFor(deps.env);
      // Unauthenticated: a database hiccup must not take health down, so the env answers then.
      const saved = await deps.prisma.deploymentSettings
        .findUnique({
          where: { id: "default" },
          select: {
            sandboxProvider: true,
            sandboxEndpoint: true,
            sandboxCredentialCipher: true,
          },
        })
        .catch(() => null);
      const machine = deploymentMachine(deps.env, saved?.sandboxProvider, {
        hasCredential: Boolean(saved?.sandboxCredentialCipher),
        endpoint: saved?.sandboxEndpoint,
      });
      const needsFirstOwner = await deploymentNeedsFirstOwner(deps.prisma).catch(() => false);
      const worker = await workerPresence.read();
      return {
        ok: true as const,
        version: deps.env.release ?? "dev",
        edition: gate.edition,
        billingEnabled: gate.billingEnabled,
        sandbox: machine.machine ?? deps.env.sandboxProvider ?? "docker",
        canChooseMachine: gate.canChooseMachine,
        availableMachines: listPickableMachines(),
        mailerEnabled: mailerEnabled({
          emailDisabled: Boolean(deps.env.authEmailDisabled),
          resendApiKey: deps.env.resendApiKey,
        }),
        needsFirstOwner,
        worker,
      };
    }),
    me: authed.me.handler(async ({ context }): Promise<Me> => {
      const actor = context.actor;
      const user = await deps.prisma.user.findUniqueOrThrow({
        where: { id: actor.userId },
      });
      const cred = await deps.prisma.userModelCredential.findFirst({
        where: {
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          isDefault: true,
        },
      });
      const settings = await deps.prisma.deploymentSettings.findUnique({
        where: { id: "default" },
      });
      const gate = editionGateFor(deps.env);
      const hasDeployment = Boolean(
        settings?.deploymentModelCredentialCipher || deps.env.openRouterKey,
      );
      return {
        userId: actor.userId,
        email: user.email,
        name: user.name,
        image: user.image ?? null,
        workspaceId: actor.workspaceId,
        isDeploymentOwner: actor.isDeploymentOwner,
        emailVerified: user.emailVerified,
        needsModel: !cred && !hasDeployment,
        defaultProvider:
          cred?.provider ?? settings?.defaultModelProvider ?? deps.env.defaultProvider,
        defaultModel: cred?.defaultModel ?? settings?.defaultModelId ?? deps.env.defaultModel,
        edition: gate.edition,
        canChooseMachine: gate.canChooseMachine,
        // Same resolver the sandbox routing uses, so this screen cannot claim one machine
        // while the bots boot on another.
        sandboxProvider: deploymentMachine(deps.env, settings?.sandboxProvider, {
          hasCredential: Boolean(settings?.sandboxCredentialCipher),
          endpoint: settings?.sandboxEndpoint,
        }).machine,
        worker: await workerPresence.read(),
      };
    }),
    deployment: {
      get: authed.deployment.get.handler(async ({ context }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return deploymentDto(deps.prisma, deps.env);
      }),
      update: authed.deployment.update.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        await saveDeploymentMachine(deps, context.actor.userId, input);
        return deploymentDto(deps.prisma, deps.env);
      }),
    },
    computers: {
      catalog: authed.computers.catalog.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner && !editionGateFor(deps.env).canChooseMachine) {
          throw new ORPCError("FORBIDDEN");
        }
        return computerCatalog(deps, input?.query ?? "");
      }),
      probe: authed.computers.probe.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        const saved = await savedMachineProbeInput(deps, input);
        return probeComputer({
          kind: saved.kind,
          endpoint: saved.endpoint,
          apiKey: saved.apiKey,
          supervisorUrl: deps.env.sandboxSupervisorUrl,
          supervisorToken: deps.env.sandboxSupervisorToken,
        });
      }),
      activate: authed.computers.activate.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        await saveDeploymentMachine(deps, context.actor.userId, {
          sandboxProvider: input.kind,
          sandboxEndpoint: input.endpoint,
          sandboxApiKey: input.apiKey,
        });
        return deploymentDto(deps.prisma, deps.env);
      }),
    },
    models: {
      // O "Scripted" é o emulador dos testes: só aparece quando o deploy roda com ele, nunca
      // na lista de quem instalou o produto.
      list: authed.models.list.handler(async () =>
        deps.env.agentRuntime === "scripted"
          ? [...listPiCatalog(), scriptedCatalogEntry]
          : listPiCatalog(),
      ),
      credentials: authed.models.credentials.handler(async ({ context }) => {
        const rows = await deps.prisma.userModelCredential.findMany({
          where: {
            userId: context.actor.userId,
            workspaceId: context.actor.workspaceId,
          },
        });
        return rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          label: row.label,
          hasKey: true,
          isDefault: row.isDefault,
        }));
      }),
      connect: authed.models.connect.handler(async ({ context, input }) => {
        // A chave é conferida no provedor antes de ser gravada: colada errada, ela
        // passava pelo onboarding e só falhava na primeira mensagem, com "401" cru.
        // O emulador dos testes não fala com provedor nenhum, então não há o que sondar.
        // O que vai ao cofre é o texto limpo — e, num modelo local, a URL na forma que a
        // sonda aprovou: gravar o que a pessoa colou com um espaço na frente fazia o run
        // cair no 127.0.0.1 padrão em vez do endereço dela.
        let plaintext = input.apiKey.trim();
        let verified = false;
        if (deps.env.agentRuntime !== "scripted") {
          const probe = await probeModelCredential(
            { provider: input.provider, apiKey: input.apiKey },
            { fetchImpl: deps.probeFetch },
          );
          if (!probe.ok) {
            throw new ORPCError("BAD_REQUEST", {
              message: probe.message,
              data: { code: "MODEL_CREDENTIAL_REJECTED", provider: input.provider },
            });
          }
          verified = probe.probed;
          if (probe.base) plaintext = probe.base;
        }
        return persistModelCredential(deps, context.actor, {
          provider: input.provider,
          plaintext,
          label: input.label,
          modelId: input.modelId,
          verified,
        });
      }),
      beginOAuth: authed.models.beginOAuth.handler(async ({ context, input }) => {
        return deps.oauthLogins.begin({
          userId: context.actor.userId,
          workspaceId: context.actor.workspaceId,
          provider: input.provider,
          modelId: input.modelId,
          label: input.label,
        });
      }),
      completeOAuth: authed.models.completeOAuth.handler(async ({ context, input }) => {
        const result = await deps.oauthLogins.complete(input.loginId, {
          userId: context.actor.userId,
          workspaceId: context.actor.workspaceId,
        });
        if (result.status !== "connected") return result;
        const credential = await persistModelCredential(deps, context.actor, {
          verified: true,
          provider: result.provider,
          plaintext: serializeModelSecret({
            kind: "oauth",
            credential: result.credential,
          }),
          label: result.label ?? result.provider,
          modelId: result.modelId,
        });
        deps.oauthLogins.consume(input.loginId);
        return { status: "connected" as const, credential };
      }),
      usePlan: authed.models.usePlan.handler(async ({ context }) => {
        await deps.prisma.userModelCredential.updateMany({
          where: {
            userId: context.actor.userId,
            workspaceId: context.actor.workspaceId,
          },
          data: { isDefault: false },
        });
        return { ok: true as const };
      }),
      setDefault: authed.models.setDefault.handler(async ({ context, input }) => {
        await deps.prisma.$transaction(async (tx) => {
          const credential = await tx.userModelCredential.findFirst({
            where: {
              userId: context.actor.userId,
              workspaceId: context.actor.workspaceId,
              provider: input.provider,
            },
            orderBy: { updatedAt: "desc" },
          });
          if (!credential) throw new IsolationError("Model credential not found");
          await tx.userModelCredential.updateMany({
            where: {
              userId: context.actor.userId,
              workspaceId: context.actor.workspaceId,
            },
            data: { isDefault: false },
          });
          await tx.userModelCredential.update({
            where: { id: credential.id },
            data: { defaultModel: input.modelId, isDefault: true },
          });
        });
        return { ok: true as const };
      }),
    },
    bots: {
      list: authed.bots.list.handler(async ({ context }) => repos.listBots(context.actor)),
      get: authed.bots.get.handler(async ({ context, input }) =>
        repos.getBotCard(context.actor, input.botId),
      ),
      create: authed.bots.create.handler(async ({ context, input }) => {
        return repos.createBot(
          context.actor,
          input,
          deps.billing
            ? (tx) => deps.billing!.assertWithinPlan(context.actor, "bots", tx)
            : undefined,
        );
      }),
      update: authed.bots.update.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        if (input.chiefOfStaff) {
          await deps.prisma.bot.updateMany({
            where: {
              workspaceId: context.actor.workspaceId,
              userId: context.actor.userId,
            },
            data: { chiefOfStaff: false },
          });
        }
        await deps.prisma.bot.update({
          where: { id: input.botId },
          data: {
            name: input.name,
            title: input.title,
            description: input.description,
            instructions: input.instructions,
            notifyOnFinish: input.notifyOnFinish,
            color: input.color,
            shape: input.shape,
            pinned: input.pinned,
            unread: input.unread,
            autoApprove: input.autoApprove,
            alwaysAllow: input.alwaysAllow,
            chiefOfStaff: input.chiefOfStaff,
            hidden: input.hidden,
          },
        });
        const bots = await repos.listBots(context.actor);
        const bot = bots.find((b) => b.id === input.botId);
        if (!bot) throw new IsolationError();
        return bot;
      }),
      duplicate: authed.bots.duplicate.handler(async ({ context, input }) => {
        const copy = await repos.duplicateBot(
          context.actor,
          input.botId,
          deps.billing
            ? (tx) => deps.billing!.assertWithinPlan(context.actor, "bots", tx)
            : undefined,
        );
        const copied = await deps.prisma.routine.findMany({
          where: { botId: copy.id, active: true, nextRunAt: { not: null } },
        });
        await Promise.all(
          copied.map((routine) =>
            deps.wakeup.enqueue({
              name: "routine.wakeup",
              payload: { routineId: routine.id },
              runAt: routine.nextRunAt!,
              jobKey: `routine:${routine.id}`,
            }),
          ),
        );
        return copy;
      }),
      remove: authed.bots.remove.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        await destroyBot(
          {
            prisma: deps.prisma,
            sandbox: deps.sandbox,
            home: deps.home,
            dataDir: deps.dataDir,
          },
          bot.id,
          {
            operationId: "destroy",
            traceId: "destroy",
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
        );
        return { ok: true as const };
      }),
    },
    conversations: {
      list: authed.conversations.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        await ensureDefaultConversation(deps.prisma, input.botId);
        const rows = await deps.prisma.conversation.findMany({
          where: { botId: input.botId },
          orderBy: { createdAt: "desc" },
        });
        return rows.map(mapConversation);
      }),
      create: authed.conversations.create.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const created = await deps.prisma.conversation.create({
          data: {
            botId: input.botId,
            title: input.title?.trim() || UNTITLED_TASK,
          },
        });
        await deps.prisma.bot.update({
          where: { id: input.botId },
          data: { activeConversationId: created.id },
        });
        return mapConversation(created);
      }),
      switch: authed.conversations.switch.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const row = await deps.prisma.conversation.findFirst({
          where: { id: input.conversationId, botId: input.botId },
        });
        if (!row) throw new IsolationError();
        await deps.prisma.bot.update({
          where: { id: input.botId },
          data: { activeConversationId: row.id },
        });
        return mapConversation(row);
      }),
      rename: authed.conversations.rename.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const existing = await deps.prisma.conversation.findFirst({
          where: { id: input.conversationId, botId: input.botId },
        });
        if (!existing) throw new IsolationError();
        const row = await deps.prisma.conversation.update({
          where: { id: input.conversationId },
          data: { title: input.title.trim() },
        });
        return mapConversation(row);
      }),
      remove: authed.conversations.remove.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        await deps.prisma.$transaction(async (tx) => {
          const existing = await tx.conversation.findFirst({
            where: { id: input.conversationId, botId: input.botId },
          });
          if (!existing) throw new IsolationError();
          const count = await tx.conversation.count({
            where: { botId: input.botId },
          });
          if (count < 2) throw new IsolationError("Keep at least one task");
          const deleted = await tx.conversation.deleteMany({
            where: { id: existing.id, botId: input.botId },
          });
          if (deleted.count !== 1) throw new IsolationError();
        });
        if (bot.activeConversationId === input.conversationId) {
          const next = await deps.prisma.conversation.findFirst({
            where: { botId: input.botId },
            orderBy: { updatedAt: "desc" },
          });
          await deps.prisma.bot.update({
            where: { id: input.botId },
            data: { activeConversationId: next?.id ?? null },
          });
        }
        return { ok: true as const };
      }),
    },
    peers: {
      list: authed.peers.list.handler(async ({ context, input }) =>
        repos.listTeammates(context.actor, input.botId),
      ),
      send: authed.peers.send.handler(async ({ context, input }) => {
        await deps.billing?.assertWithinPlan(context.actor, "tokens");
        const created = await createPeerWake(deps.prisma, context.actor, input);
        await deps.wakeup.enqueue({
          name: "run.continue",
          payload: { runId: created.run.id },
        });
        return {
          ok: true as const,
          taskId: created.task.id,
          runId: created.run.id,
          seq: created.message.seq,
        };
      }),
    },
    botGroups: {
      list: authed.botGroups.list.handler(async ({ context }) =>
        repos.listBotGroups(context.actor),
      ),
      get: authed.botGroups.get.handler(async ({ context, input }) =>
        repos.getBotGroup(context.actor, input.groupId),
      ),
      create: authed.botGroups.create.handler(async ({ context, input }) =>
        repos.createBotGroup(context.actor, input),
      ),
      update: authed.botGroups.update.handler(async ({ context, input }) =>
        repos.updateBotGroup(context.actor, input.groupId, {
          name: input.name,
          instructions: input.instructions,
        }),
      ),
      remove: authed.botGroups.remove.handler(async ({ context, input }) => {
        const group = await repos.getBotGroup(context.actor, input.groupId);
        await deps.prisma.run.updateMany({
          where: {
            threadId: group.threadId,
            status: {
              in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
            },
          },
          data: { status: "cancelled", completedAt: new Date() },
        });
        await repos.removeBotGroup(context.actor, input.groupId);
        return { ok: true as const };
      }),
      addMember: authed.botGroups.addMember.handler(async ({ context, input }) =>
        repos.addBotGroupMember(context.actor, input.groupId, input.botId),
      ),
      removeMember: authed.botGroups.removeMember.handler(async ({ context, input }) =>
        repos.removeBotGroupMember(context.actor, input.groupId, input.botId),
      ),
      thread: authed.botGroups.thread.handler(async ({ context, input }) =>
        groupSnapshot(deps, context.actor, input.groupId, {
          afterSeq: input.afterSeq,
          beforeSeq: input.beforeSeq,
          limit: input.limit,
        }),
      ),
      subscribe: authed.botGroups.subscribe.handler(async function* ({ context, input }) {
        const group = await repos.getBotGroup(context.actor, input.groupId);
        for await (const event of followThreadEvents(
          deps.prisma,
          group.threadId,
          input.cursor,
          deps.pool,
          context.signal,
        )) {
          yield toProductEvent(event);
        }
      }),
      send: authed.botGroups.send.handler(async ({ context, input }) => {
        await deps.billing?.assertWithinPlan(context.actor, "tokens");
        const created = await createGroupWakes(deps.prisma, context.actor, input);
        if (!created.duplicate) {
          await Promise.all(
            created.runs.map((run) =>
              deps.wakeup.enqueue({
                name: "run.continue",
                payload: { runId: run.id },
              }),
            ),
          );
        }
        return {
          seq: Math.max(0, created.seq),
          runIds: created.runs.map((run) => run.id),
        };
      }),
    },
    threads: {
      get: authed.threads.get.handler(async ({ context, input }) =>
        snapshot(
          deps,
          context.actor,
          input.botId,
          { afterSeq: input.afterSeq, beforeSeq: input.beforeSeq, limit: input.limit },
          context.screenOrigin,
        ),
      ),
      search: authed.threads.search.handler(async ({ context, input }) => {
        const targets = await repos.listThreadSearchTargets(context.actor);
        if (targets.length === 0) return [];

        const targetByThread = new Map(targets.map((target) => [target.threadId, target]));
        const messages = await deps.prisma.message.findMany({
          where: { threadId: { in: targets.map((target) => target.threadId) } },
          orderBy: { createdAt: "desc" },
          take: 500,
        });
        const terms = normalizeThreadSearch(input.query).split(" ").filter(Boolean);

        return messages
          .flatMap((message) => {
            const target = targetByThread.get(message.threadId);
            if (!target) return [];
            const text = threadSearchText(message.blocks);
            const normalized = normalizeThreadSearch(text);
            if (!text || !terms.every((term) => normalized.includes(term))) return [];
            return [
              {
                messageId: message.id,
                threadId: message.threadId,
                seq: message.seq,
                botId: target.botId,
                groupId: target.groupId,
                ownerName: target.ownerName,
                text,
                createdAt: message.createdAt.toISOString(),
              },
            ];
          })
          .slice(0, input.limit ?? 8);
      }),
      subscribe: authed.threads.subscribe.handler(async function* ({ context, input }) {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        for await (const event of followThreadEvents(
          deps.prisma,
          bot.thread.id,
          input.cursor,
          deps.pool,
          context.signal,
        )) {
          yield toProductEvent(event);
        }
      }),
      send: authed.threads.send.handler(async ({ context, input }) => {
        await deps.billing?.assertWithinPlan(context.actor, "tokens");
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        // Responder um recado só vale se ele for desta conversa; e o bot precisa
        // ver o trecho citado, senão "isso aqui" não quer dizer nada para ele.
        const repliedTo = input.replyToId
          ? await deps.prisma.message.findFirst({
              where: { id: input.replyToId, threadId: bot.thread.id },
              select: { id: true, blocks: true },
            })
          : null;
        if (input.replyToId && !repliedTo) throw new IsolationError();
        // Anexos: só os que já são deste bot e deste workspace viram bloco no recado.
        const attached = input.attachments?.length
          ? await deps.prisma.artifact.findMany({
              where: {
                id: { in: input.attachments },
                botId: bot.id,
                workspaceId: context.actor.workspaceId,
              },
              select: { id: true, name: true, mimeType: true, size: true },
            })
          : [];
        const attachmentNote = attached.length
          ? `\n[arquivos anexados: ${attached.map((file) => file.name).join(", ")}]`
          : "";
        const prompt = `${
          repliedTo ? `[respondendo a: ${quotedText(repliedTo.blocks)}]\n${input.text}` : input.text
        }${attachmentNote}`;
        // The run carries the nonce, so it goes in first: a retry inside the
        // race window loses the unique and returns the original run instead of
        // duplicating the user message.
        const claimed = await claimUserRun(deps.prisma, {
          workspaceId: context.actor.workspaceId,
          botId: bot.id,
          threadId: bot.thread.id,
          userId: context.actor.userId,
          prompt,
          trigger: "user",
          clientNonce: input.clientNonce,
        });
        if (claimed.duplicate) {
          const existing = await findUserMessageForRun(deps.prisma, {
            threadId: bot.thread.id,
            runId: claimed.runId,
          });
          if (existing) {
            return {
              taskId: claimed.taskId,
              runId: claimed.runId,
              seq: existing.seq,
            };
          }
          // The first request created the run then died before the message write.
          // Fall through and persist the user text so the retry is not an empty turn.
        }
        const conversation = await activeConversationForBot(deps.prisma, bot.id);
        if (conversation.title === UNTITLED_TASK) {
          await deps.prisma.conversation.update({
            where: { id: conversation.id },
            data: { title: titleFromMessage(input.text) },
          });
        }
        await deps.prisma.bot.update({
          where: { id: bot.id },
          data: { unread: false },
        });
        const userBlocks: MessageBlock[] = [
          { kind: "text" as const, text: input.text },
          ...attached.map((file) => ({
            kind: "file" as const,
            artifactId: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            image: isImage(file.mimeType),
          })),
        ];
        const message = await appendThreadMessage(deps.prisma, {
          threadId: bot.thread.id,
          conversationId: conversation.id,
          parentId: conversation.activeLeafId,
          role: "user",
          runId: claimed.runId,
          blocks: userBlocks,
          replyToId: repliedTo?.id,
        });
        const seq = message.seq;
        await appendEvent(deps.prisma, {
          workspaceId: context.actor.workspaceId,
          threadId: bot.thread.id,
          botId: bot.id,
          type: "thread.message.created",
          payload: {
            messageId: message.id,
            ...(input.clientNonce ? { clientNonce: input.clientNonce } : {}),
            role: "user",
            blocks: userBlocks,
            ...(repliedTo ? { replyToId: repliedTo.id } : {}),
          },
        });
        await deps.prisma.run.updateMany({
          where: {
            botId: bot.id,
            threadId: bot.thread.id,
            status: "queued",
            id: { not: claimed.runId },
          },
          data: { status: "cancelled", completedAt: new Date() },
        });
        await deps.wakeup.enqueue({
          name: "run.continue",
          payload: { runId: claimed.runId },
        });
        const mentioned = await mentionedBots(
          deps.prisma,
          context.actor,
          bot.id,
          input.text,
          input.mentionBotIds,
        );
        const peerWakes = await Promise.all(
          mentioned.map((peer) =>
            createPeerWake(deps.prisma, context.actor, {
              fromBotId: bot.id,
              toBotId: peer.id,
              text: input.text,
            }),
          ),
        );
        await Promise.all(
          peerWakes.map((peer) =>
            deps.wakeup.enqueue({
              name: "run.continue",
              payload: { runId: peer.run.id },
            }),
          ),
        );
        return { taskId: claimed.taskId, runId: claimed.runId, seq };
      }),
      react: authed.threads.react.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        const message = await deps.prisma.message.findFirst({
          where: { id: input.messageId, threadId: bot.thread.id },
          select: { id: true, reactions: true },
        });
        if (!message) throw new IsolationError();
        const reactions = {
          ...((message.reactions as Record<string, string[]>) ?? {}),
        };
        const who = reactions[input.emoji] ?? [];
        const next = who.includes(context.actor.userId)
          ? who.filter((id) => id !== context.actor.userId)
          : [...who, context.actor.userId];
        if (next.length) reactions[input.emoji] = next;
        else delete reactions[input.emoji];
        await deps.prisma.message.update({
          where: { id: message.id },
          data: { reactions },
        });
        await appendEvent(deps.prisma, {
          workspaceId: context.actor.workspaceId,
          threadId: bot.thread.id,
          botId: bot.id,
          type: "thread.message.created",
          payload: { role: "system", blocks: [] },
        });
        return { ok: true as const };
      }),
      stop: authed.threads.stop.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        await cancelThreadRuns(deps.prisma, {
          workspaceId: context.actor.workspaceId,
          threadId: bot.thread.id,
          botId: bot.id,
        });
        return { ok: true as const };
      }),
      clear: authed.threads.clear.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        await clearThread(deps.prisma, {
          workspaceId: context.actor.workspaceId,
          threadId: bot.thread.id,
          botId: bot.id,
        });
        return { ok: true as const };
      }),
      followUp: authed.threads.followUp.handler(async ({ context, input }) => {
        await deps.billing?.assertWithinPlan(context.actor, "tokens");
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        const message = await appendThreadMessage(deps.prisma, {
          threadId: bot.thread.id,
          role: "user",
          blocks: [{ kind: "text", text: input.text }],
        });
        await appendEvent(deps.prisma, {
          workspaceId: context.actor.workspaceId,
          threadId: bot.thread.id,
          botId: bot.id,
          type: "thread.message.created",
          payload: {
            messageId: message.id,
            role: "user",
            blocks: [{ kind: "text", text: input.text }],
          },
        });
        const active = await deps.prisma.run.findFirst({
          where: {
            botId: bot.id,
            threadId: bot.thread.id,
            status: { in: ["running", "queued", "leased"] },
          },
        });
        if (active) return { ok: true as const };
        const task = await deps.prisma.task.create({
          data: {
            workspaceId: context.actor.workspaceId,
            botId: bot.id,
            threadId: bot.thread.id,
            userId: context.actor.userId,
            prompt: input.text,
            status: "queued",
          },
        });
        const run = await deps.prisma.run.create({
          data: {
            workspaceId: context.actor.workspaceId,
            botId: bot.id,
            threadId: bot.thread.id,
            taskId: task.id,
            userId: context.actor.userId,
            status: "queued",
            trigger: "follow_up",
          },
        });
        await deps.wakeup.enqueue({
          name: "run.continue",
          payload: { runId: run.id },
        });
        return { ok: true as const };
      }),
      answer: authed.threads.answer.handler(async ({ context, input }) => {
        await deps.billing?.assertWithinPlan(context.actor, "tokens");
        await repos.getBot(context.actor, input.botId);
        const run = await deps.prisma.run.findFirst({
          where: {
            id: input.runId,
            botId: input.botId,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (!run) throw new IsolationError();
        if (run.status !== "waiting_input") {
          throw new IsolationError("Este pedido não está mais esperando resposta.");
        }
        const approval = parseApprovalDecision(input.answer);
        const checkpoint = parseRunCheckpoint(run.checkpoint);
        if (approval && checkpoint.pendingApproval) {
          const unattended = run.trigger === "webhook" || Boolean(run.webhookId);
          const decision = scopeApprovalDecision(approval, {
            unattended,
            standingAllowed: canAlwaysAllow(
              checkpoint.pendingApproval.tool,
              checkpoint.pendingApproval.summary,
              { unattended },
            ),
          });
          if (decision === "always" && checkpoint.pendingApproval.allowKey) {
            await deps.prisma.bot.update({
              where: { id: input.botId },
              data: {
                alwaysAllow: { push: checkpoint.pendingApproval.allowKey },
              },
            });
          }
          await deps.prisma.run.update({
            where: { id: run.id },
            data: {
              status: "queued",
              checkpoint: JSON.stringify({
                pendingApproval: checkpoint.pendingApproval,
                decision,
              }),
            },
          });
          await deps.wakeup.enqueue({
            name: "run.continue",
            payload: { runId: run.id },
          });
          return { ok: true as const };
        }
        await deps.prisma.run.update({
          where: { id: run.id },
          data: { status: "queued" },
        });
        await deps.prisma.task.update({
          where: { id: run.taskId },
          data: { prompt: input.answer },
        });
        await deps.wakeup.enqueue({
          name: "run.continue",
          payload: { runId: run.id },
        });
        return { ok: true as const };
      }),
      edit: authed.threads.edit.handler(async ({ context, input }) => {
        await deps.billing?.assertWithinPlan(context.actor, "tokens");
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        const busy = await deps.prisma.run.findFirst({
          where: {
            botId: bot.id,
            status: {
              in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
            },
          },
        });
        if (busy) throw new IsolationError("Bot is busy");
        const source = await deps.prisma.message.findFirst({
          where: { id: input.messageId, threadId: bot.thread.id, role: "user" },
        });
        if (!source) throw new IsolationError();
        const conversation = await activeConversationForBot(deps.prisma, bot.id);
        const message = await appendThreadMessage(deps.prisma, {
          threadId: bot.thread.id,
          conversationId: source.conversationId ?? conversation.id,
          parentId: source.parentId,
          role: "user",
          blocks: [{ kind: "text", text: input.text }],
        });
        await appendEvent(deps.prisma, {
          workspaceId: context.actor.workspaceId,
          threadId: bot.thread.id,
          botId: bot.id,
          type: "thread.message.created",
          payload: {
            messageId: message.id,
            role: "user",
            blocks: [{ kind: "text", text: input.text }],
          },
        });
        const task = await deps.prisma.task.create({
          data: {
            workspaceId: context.actor.workspaceId,
            botId: bot.id,
            threadId: bot.thread.id,
            userId: context.actor.userId,
            prompt: input.text,
            status: "queued",
          },
        });
        const run = await deps.prisma.run.create({
          data: {
            workspaceId: context.actor.workspaceId,
            botId: bot.id,
            threadId: bot.thread.id,
            taskId: task.id,
            userId: context.actor.userId,
            status: "queued",
            trigger: "user",
          },
        });
        await deps.wakeup.enqueue({
          name: "run.continue",
          payload: { runId: run.id },
        });
        return { taskId: task.id, runId: run.id, seq: message.seq };
      }),
      switchBranch: authed.threads.switchBranch.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        const busy = await deps.prisma.run.findFirst({
          where: {
            botId: bot.id,
            status: {
              in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
            },
          },
        });
        if (busy) throw new IsolationError("Bot is busy");
        const conversation = await activeConversationForBot(deps.prisma, bot.id);
        const rows = await deps.prisma.message.findMany({
          where: { conversationId: conversation.id },
        });
        const leaf = leafFrom(
          rows.map((row) => ({
            id: row.id,
            parentId: row.parentId,
            createdAt: row.createdAt.toISOString(),
          })),
          input.messageId,
        );
        await deps.prisma.conversation.update({
          where: { id: conversation.id },
          data: { activeLeafId: leaf },
        });
        return { ok: true as const, activeLeafId: leaf };
      }),
    },
    computer: {
      status: authed.computer.status.handler(async ({ context, input }) =>
        computerStatus(deps, context.actor, input.botId, {
          screenOrigin: context.screenOrigin,
        }),
      ),
      boot: authed.computer.boot.handler(async ({ context, input }) => {
        await deps.billing?.assertWithinPlan(context.actor, "computer");
        const bot = await repos.getBot(context.actor, input.botId);
        const desktop = bot.desktopSession;
        const computer = desktop?.computer;
        if (!desktop || !computer) throw new IsolationError("Bot is missing its desktop session");
        const ctx = {
          operationId: "boot",
          traceId: "boot",
          workspaceId: context.actor.workspaceId,
          userId: context.actor.userId,
          botId: bot.id,
          signal: new AbortController().signal,
        };
        const runningRef = desktop.state === "running" ? workspaceProviderRef(desktop) : undefined;
        if (runningRef) {
          // A linha "running" não é prova: o container pode ter sumido por baixo dela
          // (imagem nova, `docker rm`, Docker reiniciado). Devolver a tela direto do
          // banco entregava um endereço que já não existe, e o usuário via preto. Se o
          // provedor não souber responder, seguimos confiando na linha, como antes.
          const stillThere = deps.sandbox.exists
            ? await deps.sandbox
                .exists(computerRefFromSession(desktop), ctx)
                .catch((error: unknown) => {
                  // O supervisor não atendeu (Docker fechado: nas topologias do produto
                  // ele roda dentro do Docker). Confiar na linha aqui devolvia "ligado"
                  // com a tela morta; o que a pessoa precisa ler é para abrir o Docker.
                  if (isComputerUnreachableError(error)) {
                    throw new ORPCError("INTERNAL_SERVER_ERROR", {
                      message: publicComputerBootMessage(error),
                    });
                  }
                  return true;
                })
            : true;
          if (stillThere) {
            scheduleComputerSleep(deps.wakeup, bot.id);
            return computerStatus(deps, context.actor, input.botId, {
              screenOrigin: context.screenOrigin,
            });
          }
        }
        try {
          await apiBootComputer(
            {
              prisma: deps.prisma,
              sandbox: deps.sandbox,
              home: deps.home,
              dataDir: deps.dataDir,
              wakeup: deps.wakeup,
            },
            bot.id,
            ctx,
          );
        } catch (err) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: publicComputerBootMessage(err),
          });
        }
        return computerStatus(deps, context.actor, input.botId, {
          screenOrigin: context.screenOrigin,
        });
      }),
      stop: authed.computer.stop.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const desktop = bot.desktopSession;
        const computer = desktop?.computer;
        const providerRef = desktop ? workspaceProviderRef(desktop) : undefined;
        if (desktop && computer && providerRef) {
          try {
            await deps.sandbox.stop(
              {
                id: providerRef,
                botId: bot.id,
                kind: computer.kind as never,
                providerRef,
                display: desktop.display,
                screenUrl: desktop.screenUrl ?? undefined,
              },
              {
                operationId: "stop",
                traceId: "stop",
                workspaceId: context.actor.workspaceId,
                userId: context.actor.userId,
                signal: new AbortController().signal,
              },
            );
          } catch (error) {
            // O provedor já não tem o que parar (container parado depois de um reboot,
            // bot que nunca abriu a tela): para quem apertou "Desligar", já está
            // desligado. Antes a rota lançava aqui e o banco seguia dizendo "ligado".
            if (!isComputerAlreadyStoppedError(error)) throw error;
          }
        }
        await deps.prisma.desktopSession.update({
          where: { botId: bot.id },
          data: {
            state: "stopped",
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseUserId: null,
            controlLeaseExpiresAt: null,
          },
        });
        await closeComputerUsage(deps.prisma, bot.id);
        return computerStatus(deps, context.actor, input.botId, {
          screenOrigin: context.screenOrigin,
        });
      }),
      takeover: authed.computer.takeover.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const desktop = bot.desktopSession;
        if (!desktop) throw new IsolationError("Bot is missing its desktop session");
        const now = new Date();
        const claim = canTakeControl(desktop, context.actor.userId, now);
        if (!claim.ok) {
          throw new ORPCError("CONFLICT", {
            message: "Outra pessoa está no controle deste computador agora.",
          });
        }
        const granted = await grantControlLease(deps.prisma, {
          botId: bot.id,
          userId: context.actor.userId,
          fence: desktop.controlFence,
          now,
        });
        // Someone else moved the fence between the read and the write.
        if (!granted) {
          throw new ORPCError("CONFLICT", {
            message: "Outra pessoa está no controle deste computador agora.",
          });
        }
        await onControlLeaseGranted(deps.prisma, { botId: bot.id });
        const leaseId = granted.leaseId;
        // The lease is only real if something ends it: this hands the computer back to the bot
        // when the person who took over walks away.
        scheduleControlReap(deps.wakeup, bot.id, granted.expiresAt);
        if (bot.thread) {
          await appendEvent(deps.prisma, {
            workspaceId: context.actor.workspaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "computer.takeover.granted",
            payload: { leaseId },
          });
        }
        const waiting = await deps.prisma.run.findFirst({
          where: { botId: bot.id, status: "waiting_takeover" },
          orderBy: { createdAt: "desc" },
        });
        if (waiting)
          await deps.wakeup.enqueue({
            name: "run.continue",
            payload: { runId: waiting.id },
          });
        const computer = desktop.computer;
        const providerRef = workspaceProviderRef(desktop);
        if (computer && providerRef) {
          // Wake a wedged noVNC before the client mounts the signed URL, otherwise
          // takeover shows "Você tem o controle" on a black 502.
          await touchRunningComputer(
            { sandbox: deps.sandbox, wakeup: deps.wakeup },
            {
              botId: bot.id,
              providerRef,
              kind: computer.kind,
              display: desktop.display,
              screenUrl: desktop.screenUrl ?? undefined,
              workspaceId: context.actor.workspaceId,
              userId: context.actor.userId,
            },
          ).catch(() => undefined);
          // Taking the keyboard is worth nothing if the app has no address for the screen.
          // A session can be `running` with none recorded, and only the provider knows it.
          await ensureDesktopScreenUrl(
            { prisma: deps.prisma, sandbox: deps.sandbox },
            desktop,
            {
              operationId: "computer.takeover",
              traceId: "computer.takeover",
              workspaceId: context.actor.workspaceId,
              userId: context.actor.userId,
              signal: new AbortController().signal,
            },
            // Assumir o controle é a hora de conferir o endereço: o guardado pode
            // apontar para a porta de uma sessão que já morreu.
            { refresh: true },
          ).catch(() => undefined);
        } else {
          scheduleComputerSleep(deps.wakeup, bot.id);
        }
        return { leaseId, expiresAt: granted.expiresAt.toISOString() };
      }),
      release: authed.computer.release.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const desktop = bot.desktopSession;
        if (!desktop) throw new IsolationError("Bot is missing its desktop session");
        const check = checkControlLease(desktop, { userId: context.actor.userId }, new Date());
        // Releasing a lease you do not hold would hand someone else's session to the bot.
        if (!check.ok && check.reason === "other_holder") {
          throw new ORPCError("CONFLICT", {
            message: "Outra pessoa está no controle deste computador agora.",
          });
        }
        await releaseControlAndRevoke(deps, {
          botId: bot.id,
          fence: desktop.controlFence,
        });
        scheduleComputerSleep(deps.wakeup, bot.id);
        return { ok: true as const };
      }),
      input: authed.computer.input.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const desktop = bot.desktopSession;
        const computer = desktop?.computer;
        if (!desktop) throw new ORPCError("FORBIDDEN");
        const check = checkControlLease(
          desktop,
          { userId: context.actor.userId, leaseId: input.leaseId },
          new Date(),
        );
        if (!check.ok) {
          // An expired lease is not just refused: the bot gets its computer back.
          if (check.reason === "expired") {
            await releaseControlAndRevoke(deps, {
              botId: bot.id,
              fence: desktop.controlFence,
            });
          }
          throw new ORPCError("FORBIDDEN", {
            message: controlDenialMessage(check.reason),
          });
        }
        // Cada tecla é prova de que a pessoa ainda está lá: o prazo anda com o uso, em vez de
        // vencer no meio de um formulário. Renovar falhando não pode segurar a tecla.
        const touched = await touchControlLease({ db: deps.prisma, wakeup: deps.wakeup }, desktop, {
          botId: bot.id,
          userId: context.actor.userId,
          use: "input",
        }).catch(() => undefined);
        // O prazo novo volta junto para a tela poder escrever "controle até HH:mm" certo.
        const leaseExpiry = { controlLeaseExpiresAt: touched?.expiresAt.toISOString() ?? null };
        const providerRef = desktop ? workspaceProviderRef(desktop) : undefined;
        if (!computer || !providerRef) return { ok: true as const, ...leaseExpiry };
        const mapped =
          input.kind === "key"
            ? {
                kind: "key" as const,
                key: String(input.payload.key ?? ""),
                // ctrl+c do modo trackpad chega como key "c" + modifiers ["ctrl"].
                modifiers: Array.isArray(input.payload.modifiers)
                  ? input.payload.modifiers.map(String)
                  : undefined,
              }
            : input.kind === "clipboard"
              ? {
                  kind: "clipboard" as const,
                  text: String(input.payload.text ?? ""),
                }
              : {
                  kind: "pointer" as const,
                  x: Number(input.payload.x ?? 0),
                  y: Number(input.payload.y ?? 0),
                  button: (input.payload.button as "left" | "right" | undefined) ?? "left",
                  type:
                    (input.payload.type as
                      | "move"
                      | "moveRelative"
                      | "down"
                      | "up"
                      | "click"
                      | "tap"
                      | undefined) ?? "click",
                };
        await deps.sandbox.sendInput(
          {
            id: providerRef,
            botId: bot.id,
            kind: computer.kind as never,
            providerRef,
            display: desktop.display,
            screenUrl: desktop.screenUrl ?? undefined,
          },
          mapped,
          { leaseId: check.leaseId, holder: "user", fence: check.fence },
          {
            operationId: "input",
            traceId: "input",
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
        );
        scheduleComputerSleep(deps.wakeup, bot.id);
        return { ok: true as const, ...leaseExpiry };
      }),
      /**
       * Ensinar uma tarefa. As duas pontas exigem o controle na mão de quem pede: o
       * computador é do bot, e ler o que passou por ele — páginas, comandos, arquivos —
       * é leitura de sessão, não algo que qualquer aba aberta possa fazer de fora.
       */
      teachStart: authed.computer.teachStart.handler(async ({ context, input }) => {
        const { computerRef, runContext } = await requireOwnControl(
          deps,
          repos,
          context.actor,
          input.botId,
        );
        await runSandboxCommand(
          deps.sandbox,
          computerRef,
          lessonStartCommand(),
          "/home/quibt",
          runContext,
        );
        return { ok: true as const };
      }),
      teachCapture: authed.computer.teachCapture.handler(async ({ context, input }) => {
        const { computerRef, runContext } = await requireOwnControl(
          deps,
          repos,
          context.actor,
          input.botId,
        );
        const result = await runSandboxCommand(
          deps.sandbox,
          computerRef,
          lessonCaptureCommand(),
          "/home/quibt",
          runContext,
        );
        const capture = parseLessonCapture(result.stdout);
        return {
          urls: capture.urls,
          commands: capture.commands,
          files: capture.files,
          empty: lessonIsEmpty(capture),
        };
      }),
      files: authed.computer.files.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return deps.home.list(input.botId, input.path, {
          operationId: "files",
          traceId: "files",
          workspaceId: context.actor.workspaceId,
          userId: context.actor.userId,
          signal: new AbortController().signal,
        });
      }),
      readFile: authed.computer.readFile.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const content = await deps.home.readFile(input.botId, input.path, {
          operationId: "read",
          traceId: "read",
          workspaceId: context.actor.workspaceId,
          userId: context.actor.userId,
          signal: new AbortController().signal,
        });
        return { path: input.path, content };
      }),
      preview: authed.computer.preview.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const desktop = bot.desktopSession;
        if (!desktop?.computer || desktop.state !== "running") {
          return { image: null, capturedAt: null };
        }
        const computer = computerRefFromSession(desktop);
        const cached = readPreview(bot.id, Date.now());
        if (cached) {
          return {
            image: cached.image,
            capturedAt: new Date(cached.at).toISOString(),
          };
        }
        // Um arquivo por bot: no Docker os bots dividem o mesmo /tmp, e dois pollers (o
        // painel web num bot, o celular noutro) escrevendo o mesmo nome entregavam a
        // tela de um como retrato do outro, ou um PNG pela metade.
        const target = previewImagePath(bot.id);
        const run = {
          operationId: "preview",
          traceId: "preview",
          workspaceId: context.actor.workspaceId,
          userId: context.actor.userId,
          botId: bot.id,
          signal: AbortSignal.timeout(12_000),
        };
        const shot = await runSandboxCommand(
          deps.sandbox,
          computer,
          screenshotCommand(target),
          "/home/quibt",
          run,
        );
        if (shot.code !== 0) return { image: null, capturedAt: null };
        // O PNG some depois de lido, dê certo ou não: o próximo retrato nunca lê um resto.
        const encoded = await runSandboxCommand(
          deps.sandbox,
          computer,
          ["bash", "-lc", PREVIEW_ENCODE_SCRIPT, "quibt-preview", target],
          "/home/quibt",
          run,
          6 * 1024 * 1024,
        );
        if (encoded.code !== 0 || !encoded.stdout.trim()) return { image: null, capturedAt: null };
        const image = `data:image/png;base64,${encoded.stdout.trim()}`;
        const at = Date.now();
        rememberPreview(bot.id, { image, at });
        return { image, capturedAt: new Date(at).toISOString() };
      }),
      screenUrl: authed.computer.screenUrl.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const desktop = bot.desktopSession;
        const computer = desktop?.computer;
        const providerRef = desktop ? workspaceProviderRef(desktop) : undefined;
        if (
          !computer ||
          !providerRef ||
          !desktop ||
          (desktop.state !== "running" && desktop.state !== "booting")
        ) {
          return { url: null };
        }
        const driving = checkControlLease(desktop, { userId: context.actor.userId }, new Date()).ok;
        // noVNC's `view_only` flag is enforced by browser JavaScript, not by the VNC server.
        // Therefore the signed WebSocket capability itself is interactive and must only be
        // issued to the live lease holder.
        if (!driving) return { url: null };
        const needsLiveCredential = screenUsesTransientVncCredential(computer.kind);
        if (!needsLiveCredential) {
          const stored = signStoredScreenUrl(
            desktop.screenUrl,
            deps.env.screenProxySecret,
            context.screenOrigin ?? deps.env.webOrigin,
            false,
          );
          if (stored) {
            scheduleComputerSleep(deps.wakeup, bot.id);
            return { url: stored };
          }
        }
        // Docker credentials are intentionally never stored. Ask the supervisor for the live
        // fragment; managed providers still use this only when no URL was recorded.
        const discovered = await ensureDesktopScreenUrl(
          { prisma: deps.prisma, sandbox: deps.sandbox },
          desktop,
          {
            operationId: "screen",
            traceId: "screen",
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
          needsLiveCredential ? { refresh: true } : undefined,
        );
        if (!discovered) return { url: null };
        scheduleComputerSleep(deps.wakeup, bot.id);
        return {
          url: addScreenProxyCapability(
            withViewOnly(discovered, false),
            deps.env.screenProxySecret,
            context.screenOrigin ?? deps.env.webOrigin,
          ),
        };
      }),
      heartbeat: authed.computer.heartbeat.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const desktop = bot.desktopSession;
        const computer = desktop?.computer;
        const providerRef = desktop ? workspaceProviderRef(desktop) : undefined;
        // O app manda o heartbeat enquanto a pessoa está com o controle. Ele acorda o
        // container sempre; o prazo do lease só anda com prova de gente — tecla ou clique
        // desde a última renovação, ou o `atScreen` de quem está dirigindo a tela embutida.
        // Uma aba deixada aberta batendo sozinha não segura o teclado do bot.
        const touched = desktop
          ? await touchControlLease({ db: deps.prisma, wakeup: deps.wakeup }, desktop, {
              botId: bot.id,
              userId: context.actor.userId,
              use: "heartbeat",
              atScreen: input.atScreen === true,
            }).catch(() => undefined)
          : undefined;
        if (desktop?.state === "running" && computer && providerRef) {
          await touchRunningComputer(
            { sandbox: deps.sandbox, wakeup: deps.wakeup },
            {
              botId: bot.id,
              providerRef,
              kind: computer.kind,
              display: desktop.display,
              screenUrl: desktop.screenUrl ?? undefined,
              workspaceId: context.actor.workspaceId,
              userId: context.actor.userId,
            },
          ).catch(() => undefined);
        }
        return {
          ok: true as const,
          controlLeaseExpiresAt: touched?.expiresAt.toISOString() ?? null,
        };
      }),
      grantFolder: authed.computer.grantFolder.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        if (!path.isAbsolute(input.folder)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Folder path must be absolute",
          });
        }
        const folder = path.resolve(input.folder);
        if (folder === path.parse(folder).root) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Filesystem root cannot be granted",
          });
        }
        const grants = await addFolderGrant(deps.dataDir, context.actor.userId, folder);
        applyDesktopGrant(deps.sandbox, context.actor.userId, folder);
        return { grants };
      }),
      listGrants: authed.computer.listGrants.handler(async ({ context }) => {
        return {
          grants: await loadFolderGrants(deps.dataDir, context.actor.userId),
        };
      }),
    },
    deviceRequests: {
      list: authed.deviceRequests.list.handler(({ context }) =>
        pendingDeviceRequests(deps.prisma, context.actor.userId),
      ),
      decide: authed.deviceRequests.decide.handler(async ({ context, input }) => ({
        ok: await decideDeviceRequest(
          deps.prisma,
          context.actor.userId,
          input.requestId,
          input.approved,
        ),
      })),
    },
    memory: {
      list: authed.memory.list.handler(async ({ context, input }) => {
        const docs = await deps.prisma.memoryDocument.findMany({
          where: {
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            ...(input.botId ? { botId: input.botId } : {}),
            ...(input.scope ? { scope: input.scope } : {}),
          },
        });
        return docs.map((doc) => ({
          id: doc.id,
          scope: doc.scope as "bot" | "user",
          botId: doc.botId,
          path: doc.path,
          content: doc.content,
          revision: doc.revision,
          updatedAt: doc.updatedAt.toISOString(),
        }));
      }),
      update: authed.memory.update.handler(async ({ context, input }) => {
        const doc = await deps.prisma.memoryDocument.findFirst({
          where: {
            id: input.documentId,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (!doc) throw new IsolationError();
        const updated = await deps.memory.commit(
          {
            scope: doc.scope as "bot" | "user",
            botId: doc.botId ?? undefined,
            path: doc.path,
            content: input.content,
          },
          {
            operationId: "mem",
            traceId: "mem",
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
        );
        return {
          id: updated.id,
          scope: doc.scope as "bot" | "user",
          botId: doc.botId,
          path: updated.path,
          content: updated.content,
          revision: updated.revision,
          updatedAt: new Date().toISOString(),
        };
      }),
      exportMarkdown: authed.memory.exportMarkdown.handler(async ({ context, input }) => {
        const docs = await deps.prisma.memoryDocument.findMany({
          where: {
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            ...(input.botId ? { botId: input.botId } : {}),
          },
        });
        return docs.map((d) => `# ${d.path}\n\n${d.content}`).join("\n\n");
      }),
    },
    routines: {
      list: authed.routines.list.handler(async ({ context, input }) => {
        if (input.botId) await repos.getBot(context.actor, input.botId);
        else if (input.groupId) await repos.getBotGroup(context.actor, input.groupId);
        else throw new IsolationError();
        const rows = await deps.prisma.routine.findMany({
          where: {
            workspaceId: context.actor.workspaceId,
            ...(input.botId ? { botId: input.botId } : { groupId: input.groupId }),
          },
        });
        return rows.map(mapRoutine);
      }),
      runs: authed.routines.runs.handler(async ({ context, input }) => {
        const routine = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (!routine) throw new IsolationError();
        const rows = await deps.prisma.run.findMany({
          where: {
            routineId: routine.id,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
          orderBy: { createdAt: "desc" },
          take: input.limit ?? 5,
        });
        return rows.map((row) => ({
          ...mapRun(row),
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      create: authed.routines.create.handler(async ({ context, input }) => {
        const owner = input.botId
          ? {
              threadId: (await repos.getBot(context.actor, input.botId)).thread?.id,
              botId: input.botId,
            }
          : {
              threadId: (await repos.getBotGroup(context.actor, input.groupId!)).threadId,
            };
        const row = await deps.prisma.routine.create({
          data: {
            workspaceId: context.actor.workspaceId,
            botId: input.botId,
            groupId: input.groupId,
            userId: context.actor.userId,
            name: input.name,
            prompt: input.prompt,
            cron: input.cron,
            timezone: input.timezone,
            notify: input.notify,
            active: input.active,
            nextRunAt: input.active ? nextCronDate(input.cron, new Date(), input.timezone) : null,
          },
        });
        if (owner.threadId) {
          await appendEvent(deps.prisma, {
            workspaceId: context.actor.workspaceId,
            threadId: owner.threadId,
            botId: owner.botId,
            type: "routine.created",
            payload: { name: row.name },
          });
        }
        if (row.active && row.nextRunAt) {
          await deps.wakeup.enqueue({
            name: "routine.wakeup",
            payload: { routineId: row.id },
            runAt: row.nextRunAt,
            jobKey: `routine:${row.id}`,
          });
        }
        return mapRoutine(row);
      }),
      update: authed.routines.update.handler(async ({ context, input }) => {
        const existing = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const cron = input.cron ?? existing.cron;
        const timezone = input.timezone ?? existing.timezone;
        const active = input.active ?? existing.active;
        const scheduleChanged =
          cron !== existing.cron || timezone !== existing.timezone || active !== existing.active;
        const row = await deps.prisma.routine.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            prompt: input.prompt,
            cron: input.cron,
            timezone: input.timezone,
            active: input.active,
            notify: input.notify,
            ...(scheduleChanged
              ? {
                  nextRunAt: active ? nextCronDate(cron, new Date(), timezone) : null,
                }
              : {}),
          },
        });
        if (scheduleChanged && row.active && row.nextRunAt) {
          await deps.wakeup.enqueue({
            name: "routine.wakeup",
            payload: { routineId: row.id },
            runAt: row.nextRunAt,
            jobKey: `routine:${row.id}`,
          });
        }
        return mapRoutine(row);
      }),
      remove: authed.routines.remove.handler(async ({ context, input }) => {
        const existing = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const deleted = await deps.prisma.routine.deleteMany({
          where: {
            id: existing.id,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (deleted.count !== 1) throw new IsolationError();
        return { ok: true as const };
      }),
      testRun: authed.routines.testRun.handler(async ({ context, input }) => {
        await deps.billing?.assertWithinPlan(context.actor, "tokens");
        const routine = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (!routine) throw new IsolationError();
        if (routine.groupId) {
          const runs = await createGroupRoutineWakes(deps.prisma, {
            groupId: routine.groupId,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            prompt: routine.prompt,
            routineId: routine.id,
          });
          await Promise.all(
            runs.map((run) =>
              deps.wakeup.enqueue({
                name: "run.continue",
                payload: { runId: run.id },
              }),
            ),
          );
          return { runId: runs[0]?.id ?? routine.id };
        }
        if (!routine.botId) throw new IsolationError();
        const bot = await repos.getBot(context.actor, routine.botId);
        if (!bot.thread) throw new IsolationError();
        const task = await deps.prisma.task.create({
          data: {
            workspaceId: context.actor.workspaceId,
            botId: bot.id,
            threadId: bot.thread.id,
            userId: context.actor.userId,
            prompt: routine.prompt,
            status: "queued",
          },
        });
        const run = await deps.prisma.run.create({
          data: {
            workspaceId: context.actor.workspaceId,
            botId: bot.id,
            threadId: bot.thread.id,
            taskId: task.id,
            userId: context.actor.userId,
            status: "queued",
            trigger: "routine",
            routineId: routine.id,
          },
        });
        await deps.wakeup.enqueue({
          name: "run.continue",
          payload: { runId: run.id },
        });
        return { runId: run.id };
      }),
    },
    webhooks: {
      list: authed.webhooks.list.handler(async ({ context, input }) =>
        deps.webhookService.list(context.actor, input),
      ),
      create: authed.webhooks.create.handler(async ({ context, input }) => {
        const created = await deps.webhookService.create(context.actor, input);
        return {
          webhook: created.webhook,
          credential: await webhookCredentialFor(deps, created.webhook.endpointId, created.secret),
        };
      }),
      update: authed.webhooks.update.handler(async ({ context, input }) =>
        deps.webhookService.update(context.actor, input),
      ),
      remove: authed.webhooks.remove.handler(async ({ context, input }) => {
        await deps.webhookService.remove(context.actor, input);
        return { ok: true as const };
      }),
      rotateSecret: authed.webhooks.rotateSecret.handler(async ({ context, input }) => {
        const rotated = await deps.webhookService.rotateSecret(context.actor, input);
        return {
          webhook: rotated.webhook,
          credential: await webhookCredentialFor(deps, rotated.webhook.endpointId, rotated.secret),
        };
      }),
      testRun: authed.webhooks.testRun.handler(async ({ context, input }) => {
        const result = await deps.webhookService.testRun(context.actor, input.webhookId);
        if ((result.outcome === "accepted" || result.outcome === "duplicate") && result.runId) {
          return { runId: result.runId };
        }
        throw webhookTestRunError(result);
      }),
      attempts: authed.webhooks.attempts.handler(async ({ context, input }) =>
        deps.webhookService.attempts(context.actor, input),
      ),
    },
    capabilities: {
      list: authed.capabilities.list.handler(async ({ context }) => {
        const rows = await deps.prisma.capabilityInstall.findMany({
          where: {
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 100,
        });
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      install: authed.capabilities.install.handler(async ({ context, input }) => {
        if (input.kind === "mcp") await validateMcpEndpoint(input.source);
        const row = await installCapability(deps.prisma, {
          workspaceId: context.actor.workspaceId,
          userId: context.actor.userId,
          kind: input.kind,
          name: input.name,
          source: input.source,
          config: input.config,
          version: "0.0.0",
        }).catch((error: unknown) => {
          if (error instanceof CapabilityInstallError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        });
        return {
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      remove: authed.capabilities.remove.handler(async ({ context, input }) => {
        await deps.prisma.capabilityInstall.deleteMany({
          where: {
            id: input.id,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        return { ok: true as const };
      }),
    },
    account: {
      delete: authed.account.delete.handler(async ({ context }) => {
        await deleteAccountData(deps, context.actor);
        return { ok: true as const };
      }),
    },
    connections: {
      catalog: authed.connections.catalog.handler(async ({ context, input }) => {
        if (!deps.composio || !(await deps.composio.available().catch(() => false))) return [];
        try {
          return await deps.composio.catalog(context.actor.userId, input.query);
        } catch {
          return [];
        }
      }),
      list: authed.connections.list.handler(async ({ context }) => {
        const [rows, installs] = await Promise.all([
          deps.prisma.connection.findMany({
            where: {
              workspaceId: context.actor.workspaceId,
              userId: context.actor.userId,
            },
          }),
          deps.prisma.capabilityInstall.findMany({
            where: {
              workspaceId: context.actor.workspaceId,
              userId: context.actor.userId,
            },
            select: { kind: true, name: true, source: true },
            take: 100,
          }),
        ]);
        return rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: capabilitiesForProvider(installs, row.provider),
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      begin: authed.connections.begin.handler(async ({ context, input }) => {
        const row = await deps.prisma.connection.create({
          data: {
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            provider: input.provider,
            displayName: input.displayName,
            status: "pending",
          },
        });
        if (!deps.composio) {
          return { connectionId: row.id, authorizationUrl: null };
        }
        if (!(await deps.composio.available().catch(() => false))) {
          await deps.prisma.connection.delete({ where: { id: row.id } }).catch(() => undefined);
          throw new ORPCError("BAD_REQUEST", {
            message: new ComposioKeyMissingError().message,
          });
        }
        const callbackUrl = withConnectionId(
          connectionCallbackUrl(
            input.redirectUrl,
            `${deps.env.webOrigin}/plugins/callback`,
            deps.env,
          ),
          row.id,
        );
        try {
          const auth = await deps.composio.begin(
            { provider: input.provider, redirectUrl: callbackUrl },
            {
              operationId: "connections.begin",
              traceId: "connections.begin",
              workspaceId: context.actor.workspaceId,
              userId: context.actor.userId,
              // Um Composio lento não pode segurar a requisição para sempre.
              signal: composioAbortSignal(),
            },
          );
          await deps.prisma.connection.update({
            where: { id: row.id },
            data: {
              status: auth.authorizationUrl ? "pending" : "connected",
              providerRef: auth.state || null,
              metadata: { state: auth.state },
            },
          });
          return {
            connectionId: row.id,
            authorizationUrl: auth.authorizationUrl,
          };
        } catch (error) {
          // Prazo estourado numa MUTAÇÃO: o Composio pode ter criado o pedido de conexão.
          // Marcar "error" convidaria a abrir outro; "pending" deixa o callback (e o
          // `connections.complete`, que só consulta estado) terminar a reconciliação.
          const unknown = isComposioUnknownOutcome(error);
          await deps.prisma.connection.update({
            where: { id: row.id },
            data: { status: unknown ? "pending" : "error" },
          });
          throw new ORPCError("BAD_REQUEST", {
            message: sanitizeComposioError(error),
          });
        }
      }),
      complete: authed.connections.complete.handler(async ({ context, input }) => {
        const existing = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        await completeStoredConnection(deps, context.actor, existing, input.code);
        const row = await deps.prisma.connection.findFirstOrThrow({
          where: { id: existing.id },
        });
        const installs = await deps.prisma.capabilityInstall.findMany({
          where: {
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
          select: { kind: true, name: true, source: true },
          take: 100,
        });
        return {
          id: row.id,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: capabilitiesForProvider(installs, row.provider),
          createdAt: row.createdAt.toISOString(),
        };
      }),
      revoke: authed.connections.revoke.handler(async ({ context, input }) => {
        const row = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (row && deps.composio) {
          await deps.composio.revoke(row.provider, {
            operationId: "connections.revoke",
            traceId: "connections.revoke",
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            signal: composioAbortSignal(),
          });
        }
        await deps.prisma.connection.updateMany({
          where: {
            id: input.connectionId,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
          data: { status: "revoked" },
        });
        return { ok: true as const };
      }),
    },
    artifacts: {
      list: authed.artifacts.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const rows = await deps.prisma.artifact.findMany({
          where: { botId: input.botId, workspaceId: context.actor.workspaceId },
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          runId: row.runId,
          name: row.name,
          mimeType: row.mimeType,
          size: row.size,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
    },
    billing: {
      get: authed.billing.get.handler(async ({ context }) =>
        deps.billing
          ? deps.billing.snapshot(context.actor)
          : selfHostedSnapshot(deps.prisma, context.actor),
      ),
      checkout: authed.billing.checkout.handler(async ({ context, input }) => {
        if (!deps.billing) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A cobrança não está ligada neste servidor.",
          });
        }
        requireBillingOwner(context.actor);
        return deps.billing.checkout(context.actor, input.planId, {
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
        });
      }),
      portal: authed.billing.portal.handler(async ({ context }) => {
        if (!deps.billing) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A cobrança não está ligada neste servidor.",
          });
        }
        requireBillingOwner(context.actor);
        return deps.billing.portal(context.actor);
      }),
    },
    usage: {
      list: authed.usage.list.handler(async ({ context }) => {
        const rows = await deps.prisma.usageRecord.findMany({
          where: {
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          runId: row.runId,
          provider: row.provider,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      summary: authed.usage.summary.handler(async ({ context }) => {
        const since = usageSummaryStart();
        const rows = await deps.prisma.usageRecord.findMany({
          where: {
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            createdAt: { gte: since },
          },
        });
        return {
          inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
          outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
          runs: rows.length,
        };
      }),
    },
    export: {
      bot: authed.export.bot.handler(async ({ context, input }) => {
        const bots = await repos.listBots(context.actor);
        const bot = bots.find((b) => b.id === input.botId);
        if (!bot) throw new IsolationError();
        const snap = await snapshot(
          deps,
          context.actor,
          input.botId,
          { afterSeq: -1, unbounded: true },
          context.screenOrigin,
        );
        const memory = await deps.prisma.memoryDocument.findMany({
          where: { botId: input.botId, workspaceId: context.actor.workspaceId },
        });
        const routines = await deps.prisma.routine.findMany({
          where: { botId: input.botId, workspaceId: context.actor.workspaceId },
        });
        const files: Array<{ path: string; content: string }> = [];
        for await (const file of deps.home.exportHome(input.botId, {
          operationId: "export",
          traceId: "export",
          workspaceId: context.actor.workspaceId,
          userId: context.actor.userId,
          signal: new AbortController().signal,
        })) {
          files.push({
            path: file.path,
            content: new TextDecoder().decode(file.content),
          });
        }
        return {
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          bot: {
            name: bot.name,
            title: bot.title,
            description: bot.description,
            instructions: bot.instructions,
          },
          memory: memory.map((m) => ({ path: m.path, content: m.content })),
          routines: routines.map((r) => ({
            name: r.name,
            prompt: r.prompt,
            cron: r.cron,
            timezone: r.timezone,
          })),
          files,
          history: snap.messages,
        };
      }),
    },
    notifications: {
      registerPush: authed.notifications.registerPush.handler(async ({ context, input }) => {
        await savePushToken(deps.prisma, context.actor.userId, input.token);
        return { ok: true as const };
      }),
      unregisterPush: authed.notifications.unregisterPush.handler(async ({ context, input }) => {
        await removePushToken(deps.prisma, context.actor.userId, input.token);
        return { ok: true as const };
      }),
    },
  });
}

function toProductEvent(event: {
  id: string;
  workspaceId: string;
  threadId: string;
  botId?: string | null;
  seq: number;
  type: string;
  runId?: string | null;
  createdAt: Date;
  payload: unknown;
}) {
  return {
    id: event.id,
    workspaceId: event.workspaceId,
    threadId: event.threadId,
    botId: event.botId ?? undefined,
    seq: event.seq,
    type: event.type as never,
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload as Record<string, unknown>,
  };
}

function applyDesktopGrant(sandbox: SandboxProvider, userId: string, folder: string) {
  if (sandbox instanceof DesktopSandboxProvider) sandbox.addGrant(userId, folder);
}

/**
 * Cria a task e o run de uma mensagem do usuário numa única transação, com o
 * `clientNonce` gravado junto. Quando um retry do cliente cai na janela de
 * corrida, a unique `(workspaceId, clientNonce)` estoura (P2002), a transação
 * inteira volta atrás e o run já existente é devolvido — idempotente, sem
 * duplicar a mensagem nem responder 500.
 */
/** The user text that belongs to this run, if the first `threads.send` finished writing it. */
export async function findUserMessageForRun(
  prisma: PrismaClient,
  input: { threadId: string; runId: string },
) {
  return prisma.message.findFirst({
    where: { threadId: input.threadId, runId: input.runId, role: "user" },
    select: { seq: true },
  });
}

export async function claimUserRun(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    botId: string;
    threadId: string;
    userId: string;
    prompt: string;
    trigger: string;
    clientNonce?: string;
  },
): Promise<{ taskId: string; runId: string; duplicate: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          workspaceId: input.workspaceId,
          botId: input.botId,
          threadId: input.threadId,
          userId: input.userId,
          prompt: input.prompt,
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          workspaceId: input.workspaceId,
          botId: input.botId,
          threadId: input.threadId,
          taskId: task.id,
          userId: input.userId,
          status: "queued",
          trigger: input.trigger,
          clientNonce: input.clientNonce,
        },
      });
      return { taskId: task.id, runId: run.id, duplicate: false };
    });
  } catch (error) {
    if (!input.clientNonce || !isRunNonceConflict(error)) throw error;
    const existing = await prisma.run.findFirst({
      where: { workspaceId: input.workspaceId, clientNonce: input.clientNonce },
    });
    if (!existing) throw error;
    return { taskId: existing.taskId, runId: existing.id, duplicate: true };
  }
}

export { isRunNonceConflict };

export function requireBillingOwner(actor: Actor): void {
  if (actor.workspaceRole !== "owner") {
    throw new ORPCError("FORBIDDEN", {
      message: "Só o dono do workspace gerencia a cobrança",
    });
  }
}

/**
 * What a connection actually carries. There is no cheap per-provider tool list,
 * so this reports the capability installs already persisted against the same
 * provider instead of an invented catalog.
 */
export function capabilitiesForProvider(
  installs: Array<{ kind: string; name: string; source: string }>,
  provider: string,
): string[] {
  const names = installs
    .filter((install) => install.source === provider || install.name === provider)
    .map((install) => install.name);
  return [...new Set(names)].sort();
}

/** The Composio connection request id we stored when the OAuth flow started. */
function metadataState(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const state = (metadata as { state?: unknown }).state;
  return typeof state === "string" && state ? state : undefined;
}

/** Start of the rolling seven-day window shown by the account UI. */
export function usageSummaryStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - 7 * 24 * 60 * 60_000);
}

/**
 * Completes only a pending/error connection backed by a stored Composio
 * request. Connected and revoked rows are immutable here, making polling
 * idempotent and preventing a late callback from resurrecting a revocation.
 */
export async function completeStoredConnection(
  deps: Pick<RouterDeps, "prisma" | "composio">,
  actor: Actor,
  existing: {
    id: string;
    provider: string;
    status: string;
    providerRef: string | null;
    metadata: unknown;
  },
  code?: string,
): Promise<void> {
  if (existing.status === "connected" || existing.status === "revoked") return;
  if (!deps.composio) return;
  const state = existing.providerRef ?? metadataState(existing.metadata);
  if (!state) return;

  const adapterContext = {
    operationId: "connections.complete",
    traceId: "connections.complete",
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    signal: composioAbortSignal(),
  };
  const finished = await deps.composio
    .complete({ state, code }, adapterContext)
    .catch(() => undefined);
  const ready =
    Boolean(finished) ||
    (await deps.composio
      .connectionReady(actor.userId, existing.provider, composioAbortSignal())
      .catch(() => false));
  if (!ready) return;

  await deps.prisma.connection.updateMany({
    where: {
      id: existing.id,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      status: { in: ["pending", "error"] },
    },
    data: {
      status: "connected",
      ...(finished ? { providerRef: finished.connectionRef } : {}),
    },
  });
}

/** External cleanup is best-effort and precedes one atomic local deletion. */
export async function deleteAccountData(deps: RouterDeps, actor: Actor): Promise<void> {
  const userId = actor.userId;
  const owned = await deps.prisma.member.findMany({
    where: { userId, role: "owner" },
    select: { organizationId: true },
  });
  const workspaceIds = owned.map((row) => row.organizationId);
  const [billingAccounts, connections] = await Promise.all([
    deps.prisma.billingAccount.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        stripeSubscriptionId: { not: null },
      },
      select: { stripeSubscriptionId: true },
    }),
    deps.prisma.connection.findMany({
      where: { userId, status: { not: "revoked" } },
      select: { provider: true },
    }),
  ]);

  if (deps.billing) {
    await Promise.allSettled(
      billingAccounts.flatMap((account) =>
        account.stripeSubscriptionId
          ? [deps.billing!.cancelSubscription(account.stripeSubscriptionId)]
          : [],
      ),
    );
  }
  if (deps.composio) {
    await Promise.allSettled(
      [...new Set(connections.map((row) => row.provider).filter(Boolean))].map((provider) =>
        deps.composio!.revoke(provider, {
          operationId: "account.delete",
          traceId: "account.delete",
          workspaceId: actor.workspaceId,
          userId,
          signal: composioAbortSignal(),
        }),
      ),
    );
  }

  // Tudo numa transação só, de propósito: apagar meia conta é pior do que não apagar.
  // Ela cabia mal nos 5 s que o Prisma dava (13,4 s medidos numa conta com histórico); o
  // prazo agora vem do `createDb` e os índices novos de chave estrangeira derrubaram o
  // custo da cascata (1466 ms -> 228 ms num bot com 10 mil runs, medido com EXPLAIN ANALYZE).
  await deps.prisma.$transaction(async (tx) => {
    await tx.deploymentSettings.updateMany({
      where: { ownerUserId: userId },
      data: { ownerUserId: null },
    });
    if (workspaceIds.length) {
      // Organization relations (billing, bots, connections, memory, runs,
      // computers, etc.) all declare onDelete: Cascade in schema.prisma.
      await tx.organization.deleteMany({ where: { id: { in: workspaceIds } } });
    }
    // Auth/session/account/member/credential/secret relations cascade from User.
    await tx.user.delete({ where: { id: userId } });
  });
}

export { capabilityDigest };

async function persistModelCredential(
  deps: RouterDeps,
  actor: Actor,
  input: {
    provider: string;
    plaintext: string;
    label?: string;
    modelId?: string;
    /** O servidor falou com o provedor e a credencial passou? A tela só diz "confirmada" se sim. */
    verified?: boolean;
  },
) {
  const stored = await deps.secrets.put(input.plaintext, {
    operationId: "cred",
    traceId: "cred",
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  const cred = await deps.prisma.$transaction(async (tx) => {
    const secret = await tx.secret.create({
      data: {
        id: stored.id,
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        kind: "model",
        ciphertext: stored.ciphertext,
      },
    });
    await tx.userModelCredential.updateMany({
      where: { userId: actor.userId, workspaceId: actor.workspaceId },
      data: { isDefault: false },
    });
    return tx.userModelCredential.create({
      data: {
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        provider: input.provider,
        label: input.label ?? input.provider,
        secretId: secret.id,
        isDefault: true,
        // O padrão global do .env é de UM provedor; para os outros, o catálogo do
        // próprio provedor responde — senão a assinatura nascia apontando para um
        // modelo que aquele provedor não tem.
        defaultModel:
          input.modelId ??
          (input.provider === deps.env.defaultProvider
            ? deps.env.defaultModel
            : defaultModelForProvider(input.provider)),
      },
    });
  });
  return {
    id: cred.id,
    provider: cred.provider,
    label: cred.label,
    hasKey: true,
    isDefault: true,
    verified: input.verified ?? false,
  };
}

/**
 * Um run sem worker por perto é o silêncio que esta tela mais confunde: a pessoa mandou, nada
 * acontece, e o composer diz "trabalhando". Vale para o run parado na fila e para o run cujo
 * worker morreu no meio do trabalho (lease vencido há tempo demais). Em vez de esperar a
 * varredura periódica da API, o snapshot resolve na hora — o run vira `failed`, a frase entra
 * no fio e ele deixa de contar como ativo. Um run recente nem é olhado.
 */
async function reconcileStrandedRun<
  T extends {
    id: string;
    botId: string;
    status: string;
    updatedAt: Date;
    leaseExpiresAt?: Date | null;
  },
>(deps: RouterDeps, run: T | null): Promise<T | null> {
  if (!run || !runLooksStranded(run)) return run;
  const presence = workerPresenceFor(deps);
  const failed = await failRunsWithoutWorker(
    {
      prisma: deps.prisma,
      workerSeenAt: () => presence.seenAt(),
      apiStartedAt: presence.startedAt,
      notifications: deps.notifications,
    },
    { botId: run.botId },
  ).catch(() => [] as string[]);
  return failed.includes(run.id) ? null : run;
}

export function normalizeThreadSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function threadSearchText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap((block) =>
      block &&
      typeof block === "object" &&
      "kind" in block &&
      block.kind === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join(" ")
    .trim();
}

export const THREAD_HISTORY_DEFAULT_LIMIT = 50;

interface HistoryPageInput {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  /** Internal export path only; RPC history inputs can never set this. */
  unbounded?: boolean;
}

export function historyWindow(input: HistoryPageInput) {
  const limit = input.limit ?? THREAD_HISTORY_DEFAULT_LIMIT;
  if (input.unbounded) {
    return { orderBy: { seq: "desc" as const }, reverse: true };
  }
  if (input.beforeSeq !== undefined) {
    return {
      seq: { lt: input.beforeSeq },
      orderBy: { seq: "desc" as const },
      take: limit,
      reverse: true,
    };
  }
  if (input.afterSeq !== undefined && input.afterSeq >= 0) {
    return {
      seq: { gt: input.afterSeq },
      orderBy: { seq: "asc" as const },
      reverse: false,
    };
  }
  return { orderBy: { seq: "desc" as const }, take: limit, reverse: true };
}

async function snapshot(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
  page: HistoryPageInput,
  screenOrigin?: string,
): Promise<ThreadSnapshot> {
  const bot = await createRepos(deps.prisma).getBot(actor, botId);
  if (!bot.thread) throw new IsolationError();
  const threadId = bot.thread.id;
  const window = historyWindow(page);
  const incrementalAfter = page.beforeSeq === undefined ? (page.afterSeq ?? -1) : -1;

  const [conversation, conversations, events, queued, last, home] = await Promise.all([
    activeConversationForBot(deps.prisma, botId),
    deps.prisma.conversation.findMany({
      where: { botId },
      orderBy: { createdAt: "desc" },
    }),
    eventsAfter(deps.prisma, threadId, incrementalAfter, { newest: incrementalAfter < 0 }),
    deps.prisma.run.findFirst({
      where: {
        botId,
        threadId,
        status: {
          in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    deps.prisma.event.findFirst({
      where: { threadId },
      orderBy: { seq: "desc" },
    }),
    deps.prisma.agentHome.findUnique({ where: { botId } }),
    // A tela relê a conversa a cada 4 s. Marcar como lido o que já está lido era uma
    // escrita a cada leitura, em toda tela aberta, e ainda empurrava o `updatedAt` do
    // bot — o que remexia a ordem da lista de bots sem nada ter mudado.
    bot.unread
      ? deps.prisma.bot.update({ where: { id: botId }, data: { unread: false } })
      : undefined,
  ]);
  const run = await reconcileStrandedRun(deps, queued);
  const projected = projectMessages(events);
  const rows = await deps.prisma.message.findMany({
    where: {
      threadId,
      ...("seq" in window ? { seq: window.seq } : {}),
      OR: [{ conversationId: conversation.id }, { conversationId: null }],
    },
    orderBy: window.orderBy,
    ...("take" in window ? { take: window.take } : {}),
  });
  const orderedRows = window.reverse ? [...rows].reverse() : rows;
  const persisted = orderedRows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as "user" | "bot" | "system",
    blocks: row.blocks as ThreadSnapshot["messages"][number]["blocks"],
    runId: row.runId ?? undefined,
    fromBotId: row.fromBotId ?? undefined,
    authorBotId: row.authorBotId ?? undefined,
    conversationId: row.conversationId ?? undefined,
    parentId: row.parentId ?? undefined,
    replyToId: row.replyToId ?? undefined,
    reactions: (row.reactions as Record<string, string[]> | null) ?? undefined,
    createdAt: row.createdAt.toISOString(),
  }));
  const live = (page.beforeSeq === undefined ? projected : []).filter((message) => {
    if (message.blocks.some((block) => block.kind === "progress")) return true;
    if (!message.id.startsWith("subagent:")) return false;
    return !persisted.some((row) =>
      row.blocks.some(
        (block) => block.kind === "subagent" && message.id === `subagent:${block.agentId}`,
      ),
    );
  });
  // Conversation-scoped snapshots must not fall back to the full event projection:
  // after a clear the message table is empty, and projected would resurrect wiped turns
  // (and mix in other conversations that share this thread's event log).
  const combined = persisted.length || live.length ? [...persisted, ...live] : [];
  const messages = activePath(combined, conversation.activeLeafId);
  return {
    botId,
    threadId,
    cursor: last?.seq ?? -1,
    messages,
    run: run
      ? {
          id: run.id,
          botId: run.botId,
          threadId: run.threadId,
          taskId: run.taskId,
          status: run.status as never,
          trigger: run.trigger as never,
          modelProvider: run.modelProvider,
          modelId: run.modelId,
          error: run.error,
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
        }
      : null,
    computer: await computerStatus(deps, actor, botId, {
      bot,
      homeRevision: home?.revision ?? null,
      screenOrigin,
    }),
    conversations: conversations.map(mapConversation),
    activeConversationId: conversation.id,
  };
}

async function groupSnapshot(
  deps: RouterDeps,
  actor: Actor,
  groupId: string,
  page: HistoryPageInput,
): Promise<GroupThreadSnapshot> {
  const group = await createRepos(deps.prisma).getBotGroup(actor, groupId);
  const window = historyWindow(page);
  const [rows, last, runs] = await Promise.all([
    deps.prisma.message.findMany({
      where: {
        threadId: group.threadId,
        ...("seq" in window ? { seq: window.seq } : {}),
      },
      orderBy: window.orderBy,
      ...("take" in window ? { take: window.take } : {}),
    }),
    deps.prisma.event.findFirst({
      where: { threadId: group.threadId },
      orderBy: { seq: "desc" },
    }),
    deps.prisma.run.findMany({
      where: {
        threadId: group.threadId,
        status: {
          in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
        },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const orderedRows = window.reverse ? [...rows].reverse() : rows;
  return {
    groupId,
    threadId: group.threadId,
    cursor: last?.seq ?? -1,
    messages: orderedRows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      seq: row.seq,
      role: row.role as "user" | "bot" | "system",
      blocks: row.blocks as GroupThreadSnapshot["messages"][number]["blocks"],
      runId: row.runId ?? undefined,
      fromBotId: row.fromBotId ?? undefined,
      authorBotId: row.authorBotId ?? undefined,
      createdAt: row.createdAt.toISOString(),
    })),
    runs: runs.map(mapRun),
  };
}

function mapRun(run: {
  id: string;
  botId: string;
  threadId: string;
  taskId: string;
  status: string;
  trigger: string;
  modelProvider: string | null;
  modelId: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}) {
  return {
    id: run.id,
    botId: run.botId,
    threadId: run.threadId,
    taskId: run.taskId,
    status: run.status as never,
    trigger: run.trigger as never,
    modelProvider: run.modelProvider,
    modelId: run.modelId,
    error: run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

async function mentionedBots(
  prisma: PrismaClient,
  actor: Actor,
  senderBotId: string,
  text: string,
  mentionBotIds: string[] = [],
) {
  const bots = await prisma.bot.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      id: { not: senderBotId },
    },
    select: { id: true, name: true },
  });
  const explicit = new Set(mentionBotIds);
  return bots.filter((bot) => {
    if (explicit.has(bot.id)) return true;
    const escaped = bot.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escaped}(?![\\p{L}\\p{N}_-])`, "iu").test(text);
  });
}

/**
 * O caminho comum de "ensinar uma tarefa": achar o computador do bot e recusar quem
 * não está com o controle. Um lease vencido devolve a máquina ao bot antes de recusar,
 * como no envio de teclas.
 */
async function requireOwnControl(
  deps: RouterDeps,
  repos: ReturnType<typeof createRepos>,
  actor: Actor,
  botId: string,
) {
  const bot = await repos.getBot(actor, botId);
  const desktop = bot.desktopSession;
  const computer = desktop?.computer;
  const providerRef = desktop ? workspaceProviderRef(desktop) : undefined;
  if (!desktop || !computer || !providerRef) {
    throw new ORPCError("FORBIDDEN", {
      message: "O computador deste bot não está de pé.",
    });
  }
  const check = checkControlLease(desktop, { userId: actor.userId }, new Date());
  if (!check.ok) {
    if (check.reason === "expired") {
      await releaseControlAndRevoke(deps, {
        botId: bot.id,
        fence: desktop.controlFence,
      });
    }
    throw new ORPCError("FORBIDDEN", {
      message: controlDenialMessage(check.reason),
    });
  }
  return {
    bot,
    computerRef: {
      id: providerRef,
      botId: bot.id,
      kind: computer.kind as never,
      providerRef,
      display: desktop.display,
      screenUrl: desktop.screenUrl ?? undefined,
    },
    runContext: {
      operationId: "teach",
      traceId: "teach",
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      botId: bot.id,
      signal: new AbortController().signal,
    },
  };
}

async function releaseControlAndRevoke(
  deps: RouterDeps,
  input: { botId: string; fence: number },
): Promise<boolean> {
  const released = await releaseControlLease(deps.prisma, input);
  if (!released) return false;
  await revokeControlScreenOrSchedule(
    { prisma: deps.prisma, sandbox: deps.sandbox, wakeup: deps.wakeup },
    input.botId,
  );
  return true;
}

async function computerStatus(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
  loaded?: {
    bot?: Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>;
    homeRevision?: string | null;
    /** Origem por onde o cliente chegou; sem ela, a do servidor. */
    screenOrigin?: string;
  },
): Promise<ComputerStatus> {
  const bot = loaded?.bot ?? (await createRepos(deps.prisma).getBot(actor, botId));
  let desktop = bot.desktopSession;
  const computer = desktop?.computer;
  const homeRevision =
    loaded && "homeRevision" in loaded
      ? (loaded.homeRevision ?? null)
      : ((await deps.prisma.agentHome.findUnique({ where: { botId } }))?.revision ?? null);
  // Status is what the screen believes: never report a lease that has already run out.
  if (desktop && desktop.controlHolder === "user" && !controlLeaseLive(desktop, new Date())) {
    const released = await releaseControlAndRevoke(deps, {
      botId,
      fence: desktop.controlFence,
    });
    if (released) {
      desktop = {
        ...desktop,
        controlHolder: "bot",
        controlLeaseId: null,
        controlLeaseUserId: null,
        controlLeaseExpiresAt: null,
      };
    }
  }
  const hasControl = Boolean(
    desktop && checkControlLease(desktop, { userId: actor.userId }, new Date()).ok,
  );
  // A capability noVNC reaches the VNC socket directly. The visual `view_only` query is
  // not an authorization boundary, so no URL leaves the API until this actor owns the lease.
  let liveScreenUrl = desktop?.screenUrl ?? undefined;
  if (
    desktop &&
    computer &&
    hasControl &&
    screenUsesTransientVncCredential(computer.kind) &&
    (desktop.state === "running" || desktop.state === "booting")
  ) {
    liveScreenUrl = await ensureDesktopScreenUrl(
      { prisma: deps.prisma, sandbox: deps.sandbox },
      desktop,
      {
        operationId: "computer.status.screen",
        traceId: "computer.status.screen",
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        signal: new AbortController().signal,
      },
      { refresh: true },
    ).catch(() => undefined);
  }
  const driving =
    desktop && hasControl
      ? signStoredScreenUrl(
          liveScreenUrl,
          deps.env.screenProxySecret,
          loaded?.screenOrigin ?? deps.env.webOrigin,
          false,
        )
      : null;
  const state = publicComputerState(desktop?.state);
  return {
    botId,
    kind: (computer?.kind ?? "fake") as ComputerStatus["kind"],
    state,
    controlHolder: (desktop?.controlHolder ?? "none") as ComputerStatus["controlHolder"],
    controlLeaseExpiresAt: desktop?.controlLeaseExpiresAt?.toISOString() ?? null,
    screenAvailable: state === "running" || state === "booting",
    homeRevision,
    screenUrl: driving,
  };
}

/**
 * O banco guarda estados de fencing enquanto suspende ou destrói uma sessão. Eles são
 * detalhes internos e não fazem parte do contrato público do computador. Deixar o cast
 * atravessar esses valores fazia qualquer `threads/get` falhar na validação — e o celular
 * substituía a conversa inteira por "Output validation failed" justamente nessa janela.
 */
function publicComputerState(state: string | null | undefined): ComputerStatus["state"] {
  switch (state) {
    case undefined:
    case null:
    case "stopped":
      return "stopped";
    case "booting":
    case "running":
    case "suspended":
    case "error":
      return state;
    case "suspending":
      return "suspended";
    case "deleting":
      return "stopped";
    default:
      // Uma linha antiga ou parcialmente migrada não pode tornar o chat ilegível.
      return "error";
  }
}

/** Trecho curto do recado citado, para o bot entender a que a pessoa respondeu. */
function quotedText(blocks: unknown): string {
  const list = Array.isArray(blocks) ? blocks : [];
  const text = list
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

async function deploymentDto(prisma: PrismaClient, env: RouterDeps["env"]) {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
  });
  const claim = await prisma.deploymentClaim.findUnique({
    where: { id: "default" },
  });
  return {
    ownerUserId: settings?.ownerUserId ?? null,
    deploymentClaimed: Boolean(claim?.claimedAt),
    signupsEnabled: settings?.signupsEnabled ?? false,
    signupAllowlist: settings?.signupAllowlist
      ? settings.signupAllowlist.split(",").filter(Boolean)
      : [],
    hasDeploymentModelCredential: Boolean(settings?.deploymentModelCredentialCipher),
    defaultProvider: settings?.defaultModelProvider ?? null,
    defaultModel: settings?.defaultModelId ?? null,
    // The machine actually in force, not the column: the picker must not confirm a choice
    // the deploy cannot honor.
    sandboxProvider: deploymentMachine(env, settings?.sandboxProvider, {
      hasCredential: Boolean(settings?.sandboxCredentialCipher),
      endpoint: settings?.sandboxEndpoint,
    }).machine,
    sandboxEndpoint: settings?.sandboxEndpoint ?? null,
    hasSandboxCredential: Boolean(settings?.sandboxCredentialCipher),
    hasComposioCredential: Boolean(env.composioApiKey) || Boolean(settings?.composioApiKeyCipher),
    composioKeySource: env.composioApiKey
      ? ("env" as const)
      : settings?.composioApiKeyCipher
        ? ("stored" as const)
        : ("none" as const),
    webhookPublicUrl: settings?.webhookPublicUrl ?? null,
  };
}

/**
 * The one place webhook create/rotate credentials are minted: the saved
 * `deployment_settings.webhookPublicUrl` when present, `env.apiUrl` otherwise. Never a
 * request Host — that would let a spoofed Host header rewrite a credential a person is
 * about to paste into an external system.
 */
export async function webhookCredentialFor(deps: RouterDeps, endpointId: string, secret: string) {
  const settings = await deps.prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { webhookPublicUrl: true },
  });
  const baseUrl = resolveWebhookPublicBase(settings?.webhookPublicUrl, deps.env.apiUrl);
  return buildWebhookCredential({ baseUrl, endpointId, secret });
}

/**
 * `webhooks.testRun` never returns `{ runId: null }`: a rejected or ignored delivery
 * becomes a coherent ORPCError instead, with a code chosen to match the same outcome a
 * real delivery through `/hooks/*` would have produced.
 */
export function webhookTestRunError(result: WebhookReceiveResult): ORPCError<string, unknown> {
  switch (result.reason) {
    case "paused":
      return new ORPCError("CONFLICT", {
        message: "Este webhook está pausado.",
      });
    case "rate_limited":
      return new ORPCError("TOO_MANY_REQUESTS", {
        message: "Este webhook excedeu o limite de entregas por minuto.",
      });
    case "too_many_runs":
      return new ORPCError("TOO_MANY_REQUESTS", {
        message: "Este webhook já tem execuções demais em andamento.",
      });
    case "bot_missing_thread":
      return new ORPCError("NOT_FOUND", {
        message: "O bot deste webhook não está disponível.",
      });
    case "event_type_filtered":
      return new ORPCError("BAD_REQUEST", {
        message: "Este evento seria ignorado pelo filtro configurado no webhook.",
      });
    default:
      // Generic Portuguese message: `result.reason` (when present at all) is an internal,
      // snake_case token meant for logs/attempts, never something to surface verbatim to
      // whoever clicked "testar" in the UI.
      return new ORPCError("BAD_REQUEST", {
        message: "Não foi possível executar este teste de webhook.",
      });
  }
}

async function saveDeploymentMachine(
  deps: RouterDeps,
  ownerUserId: string,
  input: {
    signupsEnabled?: boolean;
    signupAllowlist?: string[];
    sandboxProvider?: string;
    sandboxEndpoint?: string;
    sandboxApiKey?: string;
    /** Composio key pasted in Plugins; `null` removes the stored one. */
    composioApiKey?: string | null;
    /** Already validated (http(s), no credentials/query/fragment) by the contract; `null` clears it. */
    webhookPublicUrl?: string | null;
  },
) {
  // Uma fonte só para o cadastro: com SIGNUPS_ENABLED no .env, quem manda é o .env (a API
  // alinha o interruptor salvo a cada subida). Aceitar a gravação aqui seria prometer uma
  // troca que o próximo boot desfaz sem avisar — melhor recusar dizendo onde se muda.
  if (input.signupsEnabled !== undefined && deps.env.signupsEnabled !== undefined) {
    throw new ORPCError("BAD_REQUEST", {
      message:
        "Este deploy decide o cadastro pelo .env: defina SIGNUPS_ENABLED lá e reinicie o Quibt Bot.",
    });
  }
  if (input.sandboxProvider) {
    if (!editionGateFor(deps.env).canChooseMachine) {
      throw new ORPCError("FORBIDDEN", {
        message: "Quibt Cloud gerencia o computador. A máquina não é escolhida pelo usuário.",
      });
    }
    const boot = bootableKind(input.sandboxProvider);
    if (!boot) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Essa máquina não está no catálogo.",
      });
    }
    input = { ...input, sandboxProvider: boot };
    const definition = catalogDefinition(boot);
    const existing = await deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: {
        sandboxProvider: true,
        sandboxEndpoint: true,
        sandboxCredentialCipher: true,
      },
    });
    const available = deps.env.availableMachines ?? ["docker"];
    const hasSavedKey =
      Boolean(existing?.sandboxCredentialCipher) && existing?.sandboxProvider === boot;
    if (definition?.needsEndpoint && boot === "remote-supervisor") {
      const hasEndpoint =
        Boolean(input.sandboxEndpoint?.trim()) ||
        Boolean(existing?.sandboxEndpoint) ||
        Boolean(deps.env.sandboxSupervisorUrl);
      if (!hasEndpoint) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Cole a URL do supervisor da sua VPS.",
        });
      }
    }
    if (definition?.needsKey) {
      const envCovers =
        (boot === "e2b" && (available.includes("e2b") || Boolean(deps.env.e2bApiKey))) ||
        (boot === "box" && (available.includes("box") || Boolean(deps.env.boxApiKey))) ||
        (boot === "remote-supervisor" && Boolean(deps.env.sandboxSupervisorToken));
      if (!input.sandboxApiKey?.trim() && !hasSavedKey && !envCovers) {
        throw new ORPCError("BAD_REQUEST", {
          message:
            boot === "remote-supervisor"
              ? "Cole o token do supervisor da sua VPS."
              : `Cole a chave da sua conta ${boot === "e2b" ? "E2B" : "Box"}.`,
        });
      }
    }
  }
  let cipher: string | undefined;
  if (input.sandboxApiKey?.trim()) {
    const stored = await deps.secrets.put(input.sandboxApiKey.trim(), {
      operationId: "sandbox-credential",
      traceId: "deployment",
      workspaceId: "default",
      userId: ownerUserId,
      signal: new AbortController().signal,
    });
    cipher = stored.ciphertext;
  }
  let composioCipher: string | null | undefined;
  if (input.composioApiKey === null) {
    composioCipher = null;
  } else if (input.composioApiKey?.trim()) {
    const stored = await deps.secrets.put(input.composioApiKey.trim(), {
      operationId: "composio-credential",
      traceId: "deployment",
      workspaceId: "default",
      userId: ownerUserId,
      signal: new AbortController().signal,
    });
    composioCipher = stored.ciphertext;
  }
  const webhookPublicUrl =
    input.webhookPublicUrl === undefined
      ? undefined
      : input.webhookPublicUrl === null
        ? null
        : normalizeWebhookBaseUrl(input.webhookPublicUrl);
  await deps.prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      ownerUserId,
      signupsEnabled: input.signupsEnabled ?? false,
      signupAllowlist: (input.signupAllowlist ?? []).join(","),
      sandboxProvider: input.sandboxProvider,
      sandboxEndpoint: input.sandboxEndpoint,
      sandboxCredentialCipher: cipher,
      composioApiKeyCipher: composioCipher ?? undefined,
      webhookPublicUrl,
    },
    update: {
      ...(input.signupsEnabled === undefined ? {} : { signupsEnabled: input.signupsEnabled }),
      ...(input.signupAllowlist ? { signupAllowlist: input.signupAllowlist.join(",") } : {}),
      ...(input.sandboxProvider === undefined ? {} : { sandboxProvider: input.sandboxProvider }),
      ...(input.sandboxEndpoint === undefined ? {} : { sandboxEndpoint: input.sandboxEndpoint }),
      ...(cipher === undefined ? {} : { sandboxCredentialCipher: cipher }),
      ...(composioCipher === undefined ? {} : { composioApiKeyCipher: composioCipher }),
      ...(webhookPublicUrl === undefined ? {} : { webhookPublicUrl }),
    },
  });
  deps.onDeploymentSettingsChanged?.();
}

async function computerCatalog(deps: RouterDeps, query: string) {
  const settings = await deps.prisma.deploymentSettings.findUnique({
    where: { id: "default" },
  });
  let savedKey: string | undefined;
  if (settings?.sandboxCredentialCipher) {
    try {
      savedKey = deps.secrets.load(settings.sandboxCredentialCipher);
    } catch {
      savedKey = undefined;
    }
  }
  const kind = settings?.sandboxProvider ?? "";
  return filterCatalog(query, {
    e2bApiKey: deps.env.e2bApiKey ?? (kind === "e2b" ? savedKey : undefined),
    boxApiKey: deps.env.boxApiKey ?? (kind === "box" ? savedKey : undefined),
    remoteSupervisorUrl:
      kind === "remote-supervisor" ? (settings?.sandboxEndpoint ?? undefined) : undefined,
    remoteSupervisorToken: kind === "remote-supervisor" ? savedKey : undefined,
    dockerReady: true,
  }).map((entry) => ({
    kind: entry.kind,
    family: entry.family,
    title: entry.title,
    body: entry.body,
    category: entry.category,
    needsKey: entry.needsKey,
    needsEndpoint: entry.needsEndpoint,
    needsDocker: entry.needsDocker,
    keyLabel: entry.keyLabel,
    endpointLabel: entry.endpointLabel,
    ready: entry.ready,
    configured: entry.configured,
    searchable: entry.searchable,
    recipe: entry.recipe,
  }));
}

async function savedMachineProbeInput(
  deps: RouterDeps,
  input: { kind: string; endpoint?: string; apiKey?: string },
) {
  const boot = bootableKind(input.kind);
  if (!boot || (input.apiKey?.trim() && (boot !== "remote-supervisor" || input.endpoint?.trim()))) {
    return input;
  }
  const settings = await deps.prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: {
      sandboxProvider: true,
      sandboxEndpoint: true,
      sandboxCredentialCipher: true,
    },
  });
  if (settings?.sandboxProvider !== boot) return input;
  let savedKey: string | undefined;
  if (!input.apiKey?.trim() && settings.sandboxCredentialCipher) {
    try {
      savedKey = deps.secrets.load(settings.sandboxCredentialCipher);
    } catch {
      savedKey = undefined;
    }
  }
  return {
    ...input,
    endpoint: input.endpoint?.trim() || settings.sandboxEndpoint || undefined,
    apiKey: input.apiKey?.trim() || savedKey,
  };
}

function mapRoutine(row: {
  id: string;
  botId: string | null;
  groupId: string | null;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  active: boolean;
  notify: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    groupId: row.groupId,
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    active: row.active,
    notify: row.notify,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export { requireMembership };
