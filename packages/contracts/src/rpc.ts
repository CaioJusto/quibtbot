import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { CAPABILITY_LIMITS, capabilityConfigIssue } from "./capabilities.js";
import {
  ArtifactSchema,
  BillingSnapshotSchema,
  BotGroupSchema,
  BotSchema,
  CapabilityInstallSchema,
  ComputerCatalogItemSchema,
  ComputerProbeSchema,
  ComputerStatusSchema,
  ConnectionCatalogItemSchema,
  ConnectionSchema,
  ConversationSchema,
  CreateBotGroupInput,
  CreateBotInput,
  CreateRoutineInput,
  CreateWebhookInput,
  DeploymentSettingsSchema,
  ExportManifestSchema,
  GroupThreadSnapshotSchema,
  MemoryContentInput,
  MemoryDocumentSchema,
  MeSchema,
  ModelConnectResultSchema,
  ModelCredentialSchema,
  ModelInputText,
  RoutineRunSchema,
  RoutineSchema,
  SandboxEndpointInput,
  ThreadSearchResultSchema,
  ThreadSnapshotSchema,
  UpdateBotGroupInput,
  UpdateBotInput,
  UpdateRoutineInput,
  UpdateWebhookInput,
  UsageRecordSchema,
  VoiceStatusSchema,
  WebhookAttemptSchema,
  WebhookCredentialSchema,
  WebhookPublicUrlInput,
  WebhookSchema,
  WorkerPresenceSchema,
} from "./domain.js";
import { ProductEventSchema } from "./events.js";
import { Id } from "./ids.js";

const botId = z.object({ botId: Id });

/**
 * A resposta de `computer.input` e `computer.heartbeat`. Devolver o prazo novo é o que faz o
 * "controle até HH:mm" andar na tela: sem isso o rótulo ficava parado no horário do takeover
 * e sumia quando aquele minuto passava, mesmo com o lease já renovado. `null` quando esta
 * batida não renovou nada.
 */
const ControlTouchSchema = z.object({
  ok: z.literal(true),
  controlLeaseExpiresAt: z.string().nullable().optional(),
});

export const appContract = {
  health: oc.output(
    z.object({
      ok: z.literal(true),
      version: z.string(),
      edition: z.enum(["oss", "cloud"]).default("oss"),
      billingEnabled: z.boolean().default(false),
      sandbox: z.string(),
      canChooseMachine: z.boolean().default(true),
      availableMachines: z.array(z.string()).default(["docker"]),
      /** Sem mailer, a redefinição de senha acontece no próprio computador. */
      mailerEnabled: z.boolean().default(true),
      needsFirstOwner: z.boolean().default(false),
      /** Há um worker vivo para pegar a fila? Sem ele, mandar mensagem é silêncio. */
      worker: WorkerPresenceSchema.default({ alive: true, lastSeenAt: null }),
    }),
  ),
  me: oc.output(MeSchema),
  deployment: {
    get: oc.output(DeploymentSettingsSchema),
    update: oc
      .input(
        z.object({
          signupsEnabled: z.boolean().optional(),
          signupAllowlist: z.array(z.string()).optional(),
          sandboxProvider: z.string().optional(),
          sandboxEndpoint: SandboxEndpointInput.optional(),
          sandboxApiKey: z.string().optional(),
          /** Composio key pasted by the owner; `null` removes the stored one. */
          composioApiKey: z.string().max(400).nullable().optional(),
          webhookPublicUrl: WebhookPublicUrlInput.optional(),
        }),
      )
      .output(DeploymentSettingsSchema),
  },
  computers: {
    catalog: oc
      .input(z.object({ query: z.string().optional() }).optional())
      .output(z.array(ComputerCatalogItemSchema)),
    probe: oc
      .input(
        z.object({
          kind: z.string(),
          endpoint: z.string().optional(),
          apiKey: z.string().optional(),
        }),
      )
      .output(ComputerProbeSchema),
    activate: oc
      .input(
        z.object({
          kind: z.string(),
          // O mesmo `sandboxEndpoint` por outro nome: é este campo que a tela de máquina
          // grava. Validar só o `deployment.update` deixaria o caminho de verdade aberto.
          endpoint: SandboxEndpointInput.optional(),
          apiKey: z.string().optional(),
        }),
      )
      .output(DeploymentSettingsSchema),
  },
  models: {
    list: oc.output(
      z.array(
        z.object({
          provider: z.string(),
          providerName: z.string().optional(),
          id: z.string(),
          label: z.string(),
          billing: z.string(),
          auth: z.enum(["api-key", "oauth", "both"]).optional(),
          oauthLabel: z.string().optional(),
          subscription: z.boolean().optional(),
          signIn: z.enum(["device-code"]).optional(),
        }),
      ),
    ),
    credentials: oc.output(z.array(ModelCredentialSchema)),
    connect: oc
      .input(
        z.object({
          provider: z.string(),
          apiKey: z.string().min(8),
          label: z.string().optional(),
          modelId: z.string().optional(),
        }),
      )
      .output(ModelConnectResultSchema),
    beginOAuth: oc
      .input(
        z.object({
          provider: z.string(),
          label: z.string().optional(),
          modelId: z.string().optional(),
        }),
      )
      .output(
        z.object({
          loginId: z.string(),
          verificationUri: z.string().url(),
          userCode: z.string(),
          expiresInSeconds: z.number().int(),
        }),
      ),
    completeOAuth: oc.input(z.object({ loginId: z.string() })).output(
      z.discriminatedUnion("status", [
        z.object({ status: z.literal("pending") }),
        z.object({
          status: z.literal("connected"),
          credential: ModelCredentialSchema,
        }),
        z.object({ status: z.literal("error"), error: z.string() }),
      ]),
    ),
    usePlan: oc.output(z.object({ ok: z.literal(true) })),
    setDefault: oc
      .input(z.object({ provider: z.string(), modelId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
  },
  /** Voz reutiliza o login ChatGPT/Codex de `models`; o áudio sai em bytes por POST /tts. */
  voice: {
    status: oc.output(VoiceStatusSchema),
  },
  bots: {
    list: oc.output(z.array(BotSchema)),
    get: oc.input(botId).output(BotSchema),
    create: oc.input(CreateBotInput).output(BotSchema),
    update: oc.input(UpdateBotInput).output(BotSchema),
    remove: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    duplicate: oc.input(botId).output(BotSchema),
  },
  conversations: {
    list: oc.input(botId).output(z.array(ConversationSchema)),
    create: oc
      .input(z.object({ botId: Id, title: z.string().max(80).optional() }))
      .output(ConversationSchema),
    switch: oc.input(z.object({ botId: Id, conversationId: Id })).output(ConversationSchema),
    rename: oc
      .input(
        z.object({
          botId: Id,
          conversationId: Id,
          title: z.string().min(1).max(80),
        }),
      )
      .output(ConversationSchema),
    remove: oc
      .input(z.object({ botId: Id, conversationId: Id }))
      .output(z.object({ ok: z.literal(true) })),
  },
  peers: {
    list: oc.input(botId).output(z.array(BotSchema)),
    send: oc.input(z.object({ fromBotId: Id, toBotId: Id, text: ModelInputText })).output(
      z.object({
        ok: z.literal(true),
        taskId: Id,
        runId: Id,
        seq: z.number().int().nonnegative(),
      }),
    ),
  },
  botGroups: {
    list: oc.output(z.array(BotGroupSchema)),
    get: oc.input(z.object({ groupId: Id })).output(BotGroupSchema),
    create: oc.input(CreateBotGroupInput).output(BotGroupSchema),
    update: oc.input(UpdateBotGroupInput).output(BotGroupSchema),
    remove: oc.input(z.object({ groupId: Id })).output(z.object({ ok: z.literal(true) })),
    addMember: oc.input(z.object({ groupId: Id, botId: Id })).output(BotGroupSchema),
    removeMember: oc.input(z.object({ groupId: Id, botId: Id })).output(BotGroupSchema),
    thread: oc
      .input(
        z.object({
          groupId: Id,
          afterSeq: z.number().int().min(-1).optional(),
          beforeSeq: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      )
      .output(GroupThreadSnapshotSchema),
    subscribe: oc
      .input(z.object({ groupId: Id, cursor: z.number().int().min(-1) }))
      .output(eventIterator(ProductEventSchema)),
    send: oc
      .input(
        z.object({
          groupId: Id,
          text: ModelInputText,
          clientNonce: z.string().optional(),
          mentionBotIds: z.array(Id).optional(),
        }),
      )
      .output(
        z.object({
          seq: z.number().int().nonnegative(),
          runIds: z.array(Id),
        }),
      ),
  },
  threads: {
    get: oc
      .input(
        z.object({
          botId: Id,
          afterSeq: z.number().int().min(-1).optional(),
          beforeSeq: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      )
      .output(ThreadSnapshotSchema),
    search: oc
      .input(
        z.object({
          query: z.string().trim().min(2).max(100),
          limit: z.number().int().min(1).max(20).optional(),
        }),
      )
      .output(z.array(ThreadSearchResultSchema)),
    subscribe: oc
      .input(z.object({ botId: Id, cursor: z.number().int().min(-1) }))
      .output(eventIterator(ProductEventSchema)),
    send: oc
      .input(
        z.object({
          botId: Id,
          text: ModelInputText,
          clientNonce: z.string().optional(),
          mentionBotIds: z.array(Id).optional(),
          /** Recado que esta mensagem responde: o bot recebe o trecho citado. */
          replyToId: Id.optional(),
          /** Arquivos já enviados por `POST /files/:botId`, anexados a este recado. */
          attachments: z.array(Id).max(8).optional(),
        }),
      )
      .output(z.object({ taskId: Id, runId: Id, seq: z.number().int() })),
    /** Liga ou desliga a reação desta pessoa num recado. */
    react: oc
      .input(
        z.object({
          botId: Id,
          messageId: Id,
          emoji: z.string().min(1).max(24),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    stop: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    clear: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    followUp: oc
      .input(z.object({ botId: Id, text: ModelInputText }))
      .output(z.object({ ok: z.literal(true) })),
    answer: oc
      .input(z.object({ botId: Id, runId: Id, answer: ModelInputText }))
      .output(z.object({ ok: z.literal(true) })),
    edit: oc
      .input(z.object({ botId: Id, messageId: Id, text: ModelInputText }))
      .output(z.object({ taskId: Id, runId: Id, seq: z.number().int() })),
    switchBranch: oc
      .input(z.object({ botId: Id, messageId: Id }))
      .output(z.object({ ok: z.literal(true), activeLeafId: Id })),
  },
  computer: {
    status: oc.input(botId).output(ComputerStatusSchema),
    boot: oc.input(botId).output(ComputerStatusSchema),
    stop: oc.input(botId).output(ComputerStatusSchema),
    takeover: oc.input(botId).output(z.object({ leaseId: Id, expiresAt: z.string() })),
    release: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    input: oc
      .input(
        z.object({
          botId: Id,
          kind: z.enum(["key", "pointer", "clipboard"]),
          payload: z.record(z.string(), z.unknown()),
          /** The lease from `computer.takeover`; refused when it is not the live one. */
          leaseId: Id.optional(),
        }),
      )
      .output(ControlTouchSchema),
    files: oc.input(z.object({ botId: Id, path: z.string().default("/") })).output(
      z.array(
        z.object({
          path: z.string(),
          kind: z.enum(["file", "dir"]),
          size: z.number(),
        }),
      ),
    ),
    readFile: oc
      .input(z.object({ botId: Id, path: z.string() }))
      .output(z.object({ path: z.string(), content: z.string() })),
    screenUrl: oc.input(botId).output(z.object({ url: z.string().nullable() })),
    /**
     * Um retrato parado da tela, para quem olha sem controlar: a capacidade do noVNC é
     * interativa e só vai para quem tem a posse; a imagem não é. Vem como data URL PNG,
     * `null` quando o computador não está ligado.
     */
    preview: oc.input(botId).output(
      z.object({
        image: z.string().nullable(),
        capturedAt: z.string().nullable(),
      }),
    ),
    heartbeat: oc
      .input(
        z.object({
          botId: Id,
          /**
           * A pessoa está na frente da tela do bot agora: aba à vista, janela em foco e o
           * teclado dentro do quadro (no celular, o app em primeiro plano nessa tela). O
           * que se digita dentro do noVNC não passa por `computer.input` — vai direto pelo
           * WebSocket —, então esta é a única prova de uso que o servidor recebe desse
           * caminho. Sem ela a batida só acorda o container.
           */
          atScreen: z.boolean().optional(),
        }),
      )
      .output(ControlTouchSchema),
    /**
     * Ensinar uma tarefa: `teachStart` marca o ponto de partida dentro do computador e
     * `teachCapture` colhe o que aconteceu desde então — páginas, comandos e arquivos.
     * O texto volta para a pessoa revisar antes de virar skill; nada é salvo aqui.
     */
    teachStart: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    teachCapture: oc.input(botId).output(
      z.object({
        urls: z.array(z.string()),
        commands: z.array(z.string()),
        files: z.array(z.string()),
        empty: z.boolean(),
      }),
    ),
    grantFolder: oc
      .input(z.object({ folder: z.string().min(1) }))
      .output(z.object({ grants: z.array(z.string()) })),
    listGrants: oc.output(z.object({ grants: z.array(z.string()) })),
  },
  /**
   * Aparelhos pedindo para entrar com o código curto. Digitar o código só põe o
   * aparelho nesta fila; quem está no computador é que aprova, e vê qual é.
   */
  deviceRequests: {
    list: oc.output(z.array(z.object({ id: z.string(), device: z.string(), askedAt: z.string() }))),
    decide: oc
      .input(z.object({ requestId: z.string().min(1), approved: z.boolean() }))
      .output(z.object({ ok: z.boolean() })),
  },
  memory: {
    list: oc
      .input(
        z.object({
          botId: Id.optional(),
          scope: z.enum(["bot", "user"]).optional(),
        }),
      )
      .output(z.array(MemoryDocumentSchema)),
    update: oc
      .input(z.object({ documentId: Id, content: MemoryContentInput }))
      .output(MemoryDocumentSchema),
    exportMarkdown: oc.input(z.object({ botId: Id.optional() })).output(z.string()),
  },
  routines: {
    list: oc
      .input(
        z
          .object({ botId: Id.optional(), groupId: Id.optional() })
          .refine((input) => Boolean(input.botId) !== Boolean(input.groupId), {
            message: "Provide exactly one of botId or groupId",
          }),
      )
      .output(z.array(RoutineSchema)),
    runs: oc
      .input(
        z.object({
          routineId: Id,
          limit: z.number().int().min(1).max(100).optional(),
        }),
      )
      .output(z.array(RoutineRunSchema)),
    create: oc.input(CreateRoutineInput).output(RoutineSchema),
    update: oc.input(UpdateRoutineInput).output(RoutineSchema),
    remove: oc.input(z.object({ routineId: Id })).output(z.object({ ok: z.literal(true) })),
    testRun: oc.input(z.object({ routineId: Id })).output(z.object({ runId: Id })),
  },
  webhooks: {
    list: oc.input(botId).output(z.array(WebhookSchema)),
    create: oc.input(CreateWebhookInput).output(
      z.object({
        webhook: WebhookSchema,
        credential: WebhookCredentialSchema,
      }),
    ),
    update: oc.input(UpdateWebhookInput).output(WebhookSchema),
    remove: oc.input(z.object({ webhookId: Id })).output(z.object({ ok: z.literal(true) })),
    rotateSecret: oc.input(z.object({ webhookId: Id })).output(
      z.object({
        webhook: WebhookSchema,
        credential: WebhookCredentialSchema,
      }),
    ),
    testRun: oc.input(z.object({ webhookId: Id })).output(z.object({ runId: Id })),
    attempts: oc
      .input(
        z.object({
          webhookId: Id,
          limit: z.number().int().min(1).max(100).optional(),
        }),
      )
      .output(z.array(WebhookAttemptSchema)),
  },
  capabilities: {
    list: oc.output(z.array(CapabilityInstallSchema)),
    install: oc
      .input(
        z.object({
          kind: z.enum(["skill", "plugin", "mcp"]),
          name: z.string().trim().min(1).max(CAPABILITY_LIMITS.nameChars),
          source: z.string().trim().min(1).max(CAPABILITY_LIMITS.sourceChars),
          config: z
            .record(z.string(), z.unknown())
            .superRefine((value, context) => {
              const issue = capabilityConfigIssue(value);
              if (issue)
                context.addIssue({
                  code: "custom",
                  message: `capability config ${issue}`,
                });
            })
            .default({}),
        }),
      )
      .output(CapabilityInstallSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  account: {
    /** Deletes the signed-in user and the workspace they own. Irreversible. */
    delete: oc.output(z.object({ ok: z.literal(true) })),
  },
  connections: {
    catalog: oc
      .input(z.object({ query: z.string().optional() }))
      .output(z.array(ConnectionCatalogItemSchema)),
    list: oc.output(z.array(ConnectionSchema)),
    begin: oc
      .input(
        z.object({
          provider: z.string(),
          displayName: z.string(),
          /** Where the provider should send the browser back. Origin-checked server side. */
          redirectUrl: z.string().optional(),
        }),
      )
      .output(z.object({ connectionId: Id, authorizationUrl: z.string().nullable() })),
    complete: oc
      .input(z.object({ connectionId: Id, code: z.string().optional() }))
      .output(ConnectionSchema),
    revoke: oc.input(z.object({ connectionId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  artifacts: {
    list: oc.input(botId).output(z.array(ArtifactSchema)),
  },
  billing: {
    get: oc.output(BillingSnapshotSchema),
    checkout: oc
      .input(
        z.object({
          planId: z.string().min(1),
          successUrl: z.string().url().optional(),
          cancelUrl: z.string().url().optional(),
        }),
      )
      .output(z.object({ url: z.string() })),
    portal: oc.output(z.object({ url: z.string() })),
  },
  usage: {
    list: oc.output(z.array(UsageRecordSchema)),
    summary: oc.output(
      z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        runs: z.number(),
      }),
    ),
  },
  export: {
    bot: oc.input(botId).output(ExportManifestSchema),
  },
  notifications: {
    registerPush: oc
      .input(
        z.object({
          token: z
            .string()
            .trim()
            .regex(/^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]+\]$/),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    unregisterPush: oc
      .input(z.object({ token: z.string().trim().min(1).max(512) }))
      .output(z.object({ ok: z.literal(true) })),
  },
};

export type AppContract = typeof appContract;
