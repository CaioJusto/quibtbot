import type {
  AdapterContext,
  AdapterDescriptor,
  AgentRunRequest,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  ArtifactPut,
  CommandRequest,
  ComputerInput,
  ComputerRef,
  ConnectorCall,
  ConnectorCapabilities,
  ConnectorEvent,
  ConnectorTool,
  ControlLeaseRef,
  DestroyBotSessionOptions,
  MemoryCapabilities,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  NotificationMessage,
  PortableFile,
  ProcessEvent,
  SandboxCapabilities,
  ScreenRequest,
  ScreenSession,
  SecretRecord,
  SnapshotRef,
  WakeupJob,
} from "./types.js";

/**
 * Onde o provedor está em relação a um computador que já provisionou. "stopped" é um
 * container que existe mas não roda (reboot, `docker stop`): dá para religar no lugar,
 * com `start`, sem provisionar de novo nem mexer nas linhas do banco. "unknown" é o
 * provedor sem resposta (rede, supervisor reiniciando) — e nunca vira motivo para
 * derrubar uma sessão boa.
 */
export type ComputerPresence = "running" | "stopped" | "missing" | "unknown";

export interface SandboxProvider {
  describe(): AdapterDescriptor<SandboxCapabilities>;
  provision(
    request: { botId: string; homePath: string; providerRef?: string; display?: number },
    context: AdapterContext,
  ): Promise<ComputerRef>;
  execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent>;
  connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession>;
  /** Immediately invalidates an already-issued interactive screen session, when supported. */
  revokeScreen?(computer: ComputerRef, context: AdapterContext): Promise<void>;
  /**
   * Retrato PNG (ou outro image/*) servido do túnel noVNC em 127.0.0.1, quando este
   * processo abriu um encaminhamento SSH. Sem túnel, devolve null e o caller cai no
   * screenshot dentro do container.
   */
  getLoopbackPreview?(
    computer: ComputerRef,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void>;
  snapshot(computer: ComputerRef, context: AdapterContext): Promise<SnapshotRef>;
  /**
   * Whether the provider can still serve this computer as it stands. `false` only when
   * it is positively gone (the container was removed, the box deleted) or stopped and
   * waiting for a boot; a provider that cannot answer must say `true` so a blip never
   * tears down a healthy session. Callers that need to tell "stopped" from "gone" use
   * `presence`.
   */
  exists?(computer: ComputerRef, context: AdapterContext): Promise<boolean>;
  /** Finer-grained `exists`: see {@link ComputerPresence}. */
  presence?(computer: ComputerRef, context: AdapterContext): Promise<ComputerPresence>;
  /**
   * Religa no lugar um computador que `presence` disse "stopped": mesma casa, mesmo id
   * quando possível. Devolve a referência viva; lança quando não deu (Docker fechado).
   */
  start?(computer: ComputerRef, context: AdapterContext): Promise<ComputerRef>;
  stop(computer: ComputerRef, context: AdapterContext): Promise<void>;
  destroy(computer: ComputerRef, context: AdapterContext): Promise<void>;
  /** Removes a bot session; when `preserveComputer` is true the shared container stays up. */
  destroyBotSession?(
    computer: ComputerRef,
    context: AdapterContext,
    options: DestroyBotSessionOptions,
  ): Promise<void>;
}

export interface ConnectorProvider {
  describe(): AdapterDescriptor<ConnectorCapabilities>;
  discoverTools(context: AdapterContext): Promise<ConnectorTool[]>;
  execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent>;
}

export interface ConnectionAuthProvider {
  describe(): AdapterDescriptor<{ oauth: boolean }>;
  begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }>;
  complete(
    request: { state: string; code?: string },
    context: AdapterContext,
  ): Promise<{ connectionRef: string }>;
  revoke(connectionRef: string, context: AdapterContext): Promise<void>;
}

export interface MemoryStore {
  describe(): AdapterDescriptor<MemoryCapabilities>;
  read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot>;
  search(request: MemorySearchRequest, context: AdapterContext): Promise<MemorySearchResult[]>;
  commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision>;
  exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile>;
  importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision>;
}

export interface AgentRuntime {
  describe(): AdapterDescriptor<AgentRuntimeCapabilities>;
  run(request: AgentRunRequest, context: AdapterContext): AsyncIterable<AgentRuntimeEvent>;
  abort(runId: string): Promise<void>;
}

export interface ModelProvider {
  describe(): AdapterDescriptor<{ catalog: boolean; byok: boolean }>;
  listModels(): Promise<Array<{ provider: string; id: string; label: string; billing: string }>>;
}

export interface WakeupDriver {
  describe(): AdapterDescriptor<{ cron: boolean; delay: boolean }>;
  enqueue(job: WakeupJob): Promise<void>;
  start(
    handlers: Record<string, (payload: Record<string, unknown>) => Promise<void>>,
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentHomeStore {
  describe(): AdapterDescriptor<{ revisions: boolean }>;
  checkout(botId: string, dest: string, context: AdapterContext): Promise<string>;
  commit(botId: string, src: string, context: AdapterContext): Promise<string>;
  restore(botId: string, revision: string, dest: string, context: AdapterContext): Promise<void>;
  exportHome(botId: string, context: AdapterContext): AsyncIterable<PortableFile>;
  readFile(botId: string, path: string, context: AdapterContext): Promise<string>;
  writeFile(botId: string, path: string, content: string, context: AdapterContext): Promise<void>;
  list(
    botId: string,
    path: string,
    context: AdapterContext,
  ): Promise<Array<{ path: string; kind: "file" | "dir"; size: number }>>;
}

export interface ArtifactStore {
  describe(): AdapterDescriptor<{ stream: boolean }>;
  put(artifact: ArtifactPut, context: AdapterContext): Promise<{ id: string; hash: string }>;
  get(id: string, context: AdapterContext): Promise<Uint8Array>;
  remove(id: string, context: AdapterContext): Promise<void>;
}

export interface SecretStore {
  describe(): AdapterDescriptor<{ rotate: boolean }>;
  put(plaintext: string, context: AdapterContext): Promise<SecretRecord>;
  get(id: string, context: AdapterContext): Promise<string>;
  redact(value: string): string;
}

export interface RealtimeFanout {
  describe(): AdapterDescriptor<{ postgres: boolean }>;
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
}

export interface NotificationProvider {
  describe(): AdapterDescriptor<{ push: boolean; email: boolean }>;
  send(message: NotificationMessage, context: AdapterContext): Promise<void>;
}

export interface ExecutionRunner {
  describe(): AdapterDescriptor<{ cloud: boolean; selfHosted: boolean; desktop: boolean }>;
  dispatch(runId: string, target: "cloud" | "self-hosted" | "desktop"): Promise<void>;
}
