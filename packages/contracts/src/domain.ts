import * as z from "zod";
import { ThreadMessageSchema } from "./events.js";
import { Id, MemoryScope, RunStatus, SandboxKind } from "./ids.js";

/** Caps every free-text field that can reach a model (messages, memory, routines). */
export const MAX_MODEL_INPUT_CHARS = 20_000;
export const ModelInputText = z.string().min(1).max(MAX_MODEL_INPUT_CHARS);
export const MemoryContentInput = z.string().max(MAX_MODEL_INPUT_CHARS);
const RoutineNameInput = z.string().min(1).max(80);

export const BotSchema = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string(),
  title: z.string(),
  description: z.string(),
  instructions: z.string(),
  color: z.string(),
  shape: z.string().default("circle"),
  notifyOnFinish: z.boolean(),
  parentBotId: Id.nullable(),
  pinned: z.boolean().default(false),
  unread: z.boolean().default(false),
  autoApprove: z.boolean().default(true),
  alwaysAllow: z.array(z.string()).default([]),
  chiefOfStaff: z.boolean().default(false),
  hidden: z.boolean().default(false),
  activeConversationId: Id.nullable().default(null),
  threadId: Id,
  preview: z.string(),
  status: z.string(),
  updatedAt: z.string(),
  createdAt: z.string(),
});
export type Bot = z.infer<typeof BotSchema>;

export const ConversationSchema = z.object({
  id: Id,
  botId: Id,
  title: z.string(),
  activeLeafId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const BotGroupMemberSchema = BotSchema.pick({
  id: true,
  name: true,
  title: true,
  color: true,
  shape: true,
});
export type BotGroupMember = z.infer<typeof BotGroupMemberSchema>;

export const BotGroupSchema = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string(),
  instructions: z.string(),
  threadId: Id,
  members: z.array(BotGroupMemberSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotGroup = z.infer<typeof BotGroupSchema>;

export const CreateBotGroupInput = z.object({
  name: z.string().min(1).max(80),
  botIds: z.array(Id).max(100).default([]),
});

export const UpdateBotGroupInput = z.object({
  groupId: Id,
  name: z.string().min(1).max(80).optional(),
  instructions: z.string().max(20000).optional(),
});

export const CreateBotInput = z.object({
  name: z.string().min(1).max(80),
  title: z.string().max(160).default(""),
  description: z.string().max(4000).default(""),
  instructions: z.string().max(20000).default(""),
  notifyOnFinish: z.boolean().default(true),
  color: z.string().optional(),
  shape: z.string().optional(),
});
export type CreateBotInput = z.infer<typeof CreateBotInput>;

export const UpdateBotInput = z.object({
  botId: Id,
  name: z.string().min(1).max(80).optional(),
  title: z.string().max(160).optional(),
  description: z.string().max(4000).optional(),
  instructions: z.string().max(20000).optional(),
  notifyOnFinish: z.boolean().optional(),
  color: z.string().optional(),
  shape: z.string().optional(),
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
  alwaysAllow: z.array(z.string()).optional(),
  chiefOfStaff: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

function hasExactlyOneRoutineOwner(input: { botId?: string | null; groupId?: string | null }) {
  return Boolean(input.botId) !== Boolean(input.groupId);
}

const RoutineObjectSchema = z.object({
  id: Id,
  botId: Id.nullable(),
  groupId: Id.nullable(),
  name: z.string(),
  prompt: z.string(),
  cron: z.string(),
  timezone: z.string(),
  active: z.boolean(),
  notify: z.boolean(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
});

export const RoutineSchema = RoutineObjectSchema.refine(hasExactlyOneRoutineOwner, {
  message: "A routine must belong to exactly one bot or group",
});
export type Routine = z.infer<typeof RoutineSchema>;

export const CreateRoutineInput = z
  .object({
    botId: Id.optional(),
    groupId: Id.optional(),
    name: RoutineNameInput,
    prompt: ModelInputText,
    cron: z.string().min(1),
    timezone: z.string().default("UTC"),
    notify: z.boolean().default(true),
    active: z.boolean().default(false),
  })
  .refine(hasExactlyOneRoutineOwner, {
    message: "Provide exactly one of botId or groupId",
  });

export const UpdateRoutineInput = z.object({
  routineId: Id,
  name: RoutineNameInput.optional(),
  prompt: ModelInputText.optional(),
  cron: z.string().min(1).optional(),
  timezone: z.string().optional(),
  active: z.boolean().optional(),
  notify: z.boolean().optional(),
});

export const WebhookOutcome = z.enum(["accepted", "duplicate", "ignored", "rejected"]);
export const WebhookSchema = z.object({
  id: Id,
  endpointId: z.string(),
  botId: Id,
  name: z.string(),
  prompt: z.string(),
  active: z.boolean(),
  eventTypes: z.array(z.string()),
  deliveryCount: z.number().int().nonnegative(),
  lastReceivedAt: z.string().nullable(),
  lastRunId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Webhook = z.infer<typeof WebhookSchema>;

export const WebhookAttemptSchema = z.object({
  id: Id,
  webhookId: Id,
  receivedAt: z.string(),
  outcome: WebhookOutcome,
  statusCode: z.number().int(),
  eventName: z.string().nullable(),
  preview: z.string().nullable(),
  deliveryId: z.string().nullable(),
  runId: Id.nullable(),
  reason: z.string().nullable(),
});
export type WebhookAttempt = z.infer<typeof WebhookAttemptSchema>;

export const WebhookCredentialSchema = z.object({
  endpointUrl: z.string().url(),
  secret: z.string(),
  url: z.string().url(),
});
export type WebhookCredential = z.infer<typeof WebhookCredentialSchema>;

const WebhookPromptInput = z.union([z.literal(""), ModelInputText]).default("");

export const CreateWebhookInput = z.object({
  botId: Id,
  name: z.string().trim().min(1).max(80),
  prompt: WebhookPromptInput,
  active: z.boolean().default(true),
  eventTypes: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});
export type CreateWebhookInput = z.infer<typeof CreateWebhookInput>;

export const UpdateWebhookInput = CreateWebhookInput.omit({ botId: true }).partial().extend({
  webhookId: Id,
});
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookInput>;

export const MemoryDocumentSchema = z.object({
  id: Id,
  scope: MemoryScope,
  botId: Id.nullable(),
  path: z.string(),
  content: z.string(),
  revision: z.number().int(),
  updatedAt: z.string(),
});
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;

export const ConnectionSchema = z.object({
  id: Id,
  provider: z.string(),
  displayName: z.string(),
  status: z.enum(["pending", "connected", "revoked", "error"]),
  capabilities: z.array(z.string()),
  createdAt: z.string(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const ConnectionCatalogItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  logo: z.string().nullable(),
  connected: z.boolean(),
  noAuth: z.boolean(),
});
export type ConnectionCatalogItem = z.infer<typeof ConnectionCatalogItemSchema>;

export const CapabilityInstallSchema = z.object({
  id: Id,
  kind: z.enum(["skill", "plugin", "mcp", "connection"]),
  name: z.string(),
  source: z.string(),
  version: z.string().nullable(),
  digest: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type CapabilityInstall = z.infer<typeof CapabilityInstallSchema>;

export const ArtifactSchema = z.object({
  id: Id,
  botId: Id,
  runId: Id.nullable(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  createdAt: z.string(),
});

export const UsageRecordSchema = z.object({
  id: Id,
  botId: Id.nullable(),
  runId: Id.nullable(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  createdAt: z.string(),
});

export const ComputerStatusSchema = z.object({
  botId: Id,
  kind: SandboxKind,
  state: z.enum(["stopped", "booting", "running", "suspended", "error"]),
  controlHolder: z.enum(["bot", "user", "none"]),
  /** When the current takeover lease runs out; null when the bot is in control. */
  controlLeaseExpiresAt: z.string().nullable(),
  screenAvailable: z.boolean(),
  homeRevision: z.string().nullable(),
  /**
   * Signed driving URL when this caller holds the live control lease and the
   * session already has a stored screen. Clients should prefer this over a
   * second `computer/screenUrl` round-trip.
   */
  screenUrl: z.string().nullable().optional(),
});
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;

export const RunSchema = z.object({
  id: Id,
  botId: Id,
  threadId: Id,
  taskId: Id,
  status: RunStatus,
  trigger: z.enum(["user", "routine", "resume", "follow_up", "peer", "group", "spawn", "webhook"]),
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type Run = z.infer<typeof RunSchema>;

export const ThreadSnapshotSchema = z.object({
  botId: Id,
  threadId: Id,
  cursor: z.number().int().min(-1),
  messages: z.array(ThreadMessageSchema),
  run: RunSchema.nullable(),
  computer: ComputerStatusSchema,
  conversations: z.array(ConversationSchema).default([]),
  activeConversationId: Id.nullable().default(null),
});
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>;

export const GroupThreadSnapshotSchema = z.object({
  groupId: Id,
  threadId: Id,
  cursor: z.number().int().min(-1),
  messages: z.array(ThreadMessageSchema),
  runs: z.array(RunSchema),
});
export type GroupThreadSnapshot = z.infer<typeof GroupThreadSnapshotSchema>;

export const ModelCredentialSchema = z.object({
  id: Id,
  provider: z.string(),
  label: z.string(),
  hasKey: z.boolean(),
  isDefault: z.boolean(),
});

export const ComputerCatalogItemSchema = z.object({
  kind: z.string(),
  family: z.string(),
  title: z.string(),
  body: z.string(),
  category: z.enum(["local", "remote", "cloud", "vps"]),
  needsKey: z.boolean(),
  needsEndpoint: z.boolean(),
  needsDocker: z.boolean(),
  keyLabel: z.string().optional(),
  endpointLabel: z.string().optional(),
  ready: z.boolean(),
  configured: z.boolean(),
  searchable: z.array(z.string()),
  recipe: z
    .object({
      provider: z.string(),
      hint: z.string(),
      docsUrl: z.string().optional(),
      installScript: z.string(),
    })
    .optional(),
});
export type ComputerCatalogItem = z.infer<typeof ComputerCatalogItemSchema>;

export const ComputerProbeSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type ComputerProbe = z.infer<typeof ComputerProbeSchema>;

export const BootstrapInviteMintSchema = z.object({
  code: z.string(),
  token: z.string(),
  expiresAt: z.string(),
});

export const BootstrapClaimOutputSchema = z.object({
  enrollmentToken: z.string(),
  expiresAt: z.string(),
});

/**
 * The webhook receiver never derives its own public URL from a request Host (that would
 * let a spoofed Host header rewrite the credential a person copies into an external
 * system). It only ever comes from this deployment setting or `env.apiUrl`, so this
 * validator is intentionally strict about what a person may paste here.
 */
function isValidWebhookPublicUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  return true;
}

export const WebhookPublicUrlInput = z
  .union([z.string(), z.null()])
  .refine((value) => value === null || isValidWebhookPublicUrl(value), {
    message: "URL pública de webhooks precisa ser http(s), sem usuário, senha, busca ou fragmento.",
  });

export const DeploymentSettingsSchema = z.object({
  ownerUserId: Id.nullable(),
  deploymentClaimed: z.boolean().default(false),
  signupsEnabled: z.boolean(),
  signupAllowlist: z.array(z.string()),
  hasDeploymentModelCredential: z.boolean(),
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  sandboxProvider: z.string().nullable(),
  sandboxEndpoint: z.string().nullable(),
  hasSandboxCredential: z.boolean(),
  /** A Composio key is in force — pasted by the owner or set in the env. */
  hasComposioCredential: z.boolean().default(false),
  /** Where that key comes from; the UI only offers "remove" for a pasted one. */
  composioKeySource: z.enum(["none", "env", "stored"]).default("none"),
  webhookPublicUrl: z.string().nullable(),
});
export type DeploymentSettings = z.infer<typeof DeploymentSettingsSchema>;

export const MeSchema = z.object({
  userId: Id,
  email: z.string().email(),
  name: z.string(),
  /** A foto de perfil (URL ou data URL pequena); `null` quando só há a inicial. */
  image: z.string().nullable().optional(),
  workspaceId: Id,
  isDeploymentOwner: z.boolean(),
  emailVerified: z.boolean(),
  needsModel: z.boolean(),
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  edition: z.enum(["oss", "cloud"]).default("oss"),
  canChooseMachine: z.boolean().default(true),
  // Same shape as DeploymentSettings.sandboxProvider: the machine in force is one concept, so the
  // two places that report it cannot drift into different types.
  sandboxProvider: z.string().nullable(),
});
export type Me = z.infer<typeof MeSchema>;

export const BillingSnapshotSchema = z.object({
  enabled: z.boolean(),
  planId: z.string(),
  planName: z.string(),
  status: z.enum(["trialing", "active", "past_due", "incomplete", "canceled", "self_hosted"]),
  trialEndsAt: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  usage: z.object({
    tokens: z.number().int().nonnegative(),
    computerMinutes: z.number().int().nonnegative(),
    bots: z.number().int().nonnegative(),
  }),
  limits: z.object({
    maxBots: z.number().int().nullable(),
    tokensPerMonth: z.number().int().nullable(),
    computerMinutesPerMonth: z.number().int().nullable(),
  }),
  plans: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      priceUsd: z.number().nonnegative(),
      maxBots: z.number().int().nullable(),
      tokensPerMonth: z.number().int().nullable(),
      computerMinutesPerMonth: z.number().int().nullable(),
    }),
  ),
});
export type BillingSnapshot = z.infer<typeof BillingSnapshotSchema>;

export const ExportManifestSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  bot: BotSchema.pick({ name: true, title: true, description: true, instructions: true }),
  memory: z.array(z.object({ path: z.string(), content: z.string() })),
  routines: z.array(
    RoutineObjectSchema.pick({ name: true, prompt: true, cron: true, timezone: true }),
  ),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  history: z.array(ThreadMessageSchema),
});
export type ExportManifest = z.infer<typeof ExportManifestSchema>;
