import type { SandboxKind } from "@quibt/contracts";

export interface AdapterContext {
  operationId: string;
  traceId: string;
  workspaceId: string;
  userId: string;
  botId?: string;
  runId?: string;
  signal: AbortSignal;
  connectedProviders?: string[];
}

export interface AdapterDescriptor<TCapabilities> {
  id: string;
  contractVersion: string;
  adapterVersion: string;
  capabilities: TCapabilities;
}

export interface PortableFile {
  path: string;
  content: Uint8Array;
  executable?: boolean;
}

export interface ComputerRef {
  id: string;
  botId: string;
  kind: SandboxKind;
  providerRef: string;
  display?: number;
  screenUrl?: string;
}

/** Shared workspace providers may remove only a bot session while keeping the container. */
export type DestroyBotSessionOptions = {
  preserveComputer: boolean;
};

export interface CommandRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  pty?: boolean;
  /** Maximum wall-clock runtime before the command and its descendants are terminated. */
  timeoutMs?: number;
}

export type ProcessEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number };

export interface ScreenRequest {
  view: "stream" | "snapshot";
}

export interface ScreenSession {
  url: string | null;
  mimeType: string;
  close(): Promise<void>;
}

export type ComputerInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | {
      kind: "pointer";
      x: number;
      y: number;
      button?: "left" | "right";
      type: "move" | "moveRelative" | "down" | "up" | "click" | "tap";
    }
  | { kind: "clipboard"; text: string };

export interface ControlLeaseRef {
  leaseId: string;
  holder: "user" | "bot";
  fence: number;
}

export interface SnapshotRef {
  id: string;
  createdAt: string;
}

export interface SandboxCapabilities {
  graphical: boolean;
  pty: boolean;
  snapshots: boolean;
  takeover: boolean;
  persistentHome: boolean;
}

export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ConnectorCall {
  tool: string;
  args: Record<string, unknown>;
  connectionId?: string;
  executionId: string;
}

export type ConnectorEvent =
  | { type: "log"; message: string }
  | { type: "result"; data: unknown }
  | { type: "error"; message: string };

export interface ConnectorCapabilities {
  discover: boolean;
  oauth: boolean;
  secretsBrokered: boolean;
}

export interface MemoryReadRequest {
  scope: "bot" | "user";
  botId?: string;
  path?: string;
}

export interface MemorySnapshot {
  documents: Array<{ id: string; path: string; content: string; revision: number }>;
}

export interface MemorySearchRequest {
  query: string;
  scope: "bot" | "user" | "all";
  botId?: string;
}

export interface MemorySearchResult {
  path: string;
  snippet: string;
  score: number;
}

export interface MemoryCommitRequest {
  scope: "bot" | "user";
  botId?: string;
  path: string;
  content: string;
  sourceRunId?: string;
  sourceThreadId?: string;
}

export interface MemoryRevision {
  id: string;
  path: string;
  revision: number;
  content: string;
}

export interface MemoryExportRequest {
  scope: "bot" | "user" | "all";
  botId?: string;
}

export interface MemoryCapabilities {
  search: boolean;
  revisions: boolean;
  markdownPortable: boolean;
}

export interface AgentRunRequest {
  botId: string;
  threadId: string;
  runId: string;
  prompt: string;
  instructions: string;
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  tools: ConnectorTool[];
  model: {
    provider: string;
    id: string;
    apiKey?: string;
    /**
     * Credencial OAuth serializada, para provedores de assinatura (Codex, Claude,
     * Copilot, xAI). Eles não aceitam chave de API: o token precisa entrar como
     * credencial armazenada, senão o provedor fica "não configurado".
     */
    oauthCredential?: string;
  };
  resumeFromCheckpoint?: string;
  script?: ScriptedTurn[];
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
    executionId: string,
  ) => Promise<unknown>;
}

export interface ScriptedTurn {
  assistant?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  ask?: { text: string; detail?: string };
  takeover?: { reason: string };
  files?: Array<{ path: string; content: string }>;
  memory?: Array<{ scope: "bot" | "user"; path: string; content: string }>;
  complete?: boolean;
}

export type AgentRuntimeEvent =
  | { type: "text"; text: string }
  | { type: "progress"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; executionId: string }
  | { type: "ask"; text: string; detail?: string }
  | { type: "takeover"; reason: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; provider: string; model: string }
  | { type: "checkpoint"; blob: string }
  | {
      type: "subagent";
      agentId: string;
      name: string;
      task: string;
      status: "running" | "completed" | "failed";
      progress?: string;
      result?: string;
    }
  /**
   * O turno falhou no provedor. `message` já vem em português, pronta para o chat;
   * `retryable` diz se o executor pode tentar o run de novo antes de mostrar a falha.
   */
  | { type: "error"; message: string; retryable: boolean }
  | { type: "done"; text?: string };

export interface AgentRuntimeCapabilities {
  streaming: boolean;
  compaction: boolean;
  tools: boolean;
  scripted: boolean;
}

export interface WakeupJob {
  name: string;
  payload: Record<string, unknown>;
  runAt?: Date;
  jobKey?: string;
}

export interface SecretRecord {
  id: string;
  ciphertext: string;
}

export interface ArtifactPut {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface NotificationMessage {
  kind: "completion" | "failure" | "help" | "takeover";
  title: string;
  body: string;
  botId: string;
  threadId: string;
}
