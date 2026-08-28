import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLAIMED_PAIRING_INSTRUCTION,
  createClock,
  createProcessRunner,
  finalizePairingInstall,
  type InstallerEvent,
  inspectInstallState,
  isInstallStateComplete,
  nextInstallStep,
  runInstall,
  runPair,
  runUninstall,
} from "@quibt/installer";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { appBundlePath } from "./app-bundle.js";
import { firstDeepLinkFromArgv, webUrlFromDeepLink } from "./deep-link.js";
import { isMainFrameLoadFailure, parseDidFailLoad } from "./did-fail-load.js";
import {
  LOCAL_UNAVAILABLE_MESSAGE,
  planInitialNavigation,
  REMOTE_UNAVAILABLE_MESSAGE,
} from "./initial-page.js";
import { InstallEmitContextRegistry } from "./install-emit-context.js";
import { InstallConcurrencyGate } from "./install-gate.js";
import { withDesktopRetryHint } from "./install-messages.js";
import { lanApiUrl } from "./lan.js";
import {
  DESKTOP_CAPABILITY_HEADER,
  desktopAuthSecretFromEnvFile,
  desktopSessionCapability,
  isLocalSessionRequest,
} from "./local-session.js";
import {
  claimOwnerEnrollment,
  isFirstOwnerSignupRequest,
  type PendingOwnerEnrollment,
  shouldClearOwnerEnrollment,
  validOwnerEnrollmentToken,
} from "./owner-enrollment.js";
import { guidedVpsBootstrapCommand } from "./release-artifacts.js";
import { type loadEmbeddedReleaseManifest, remoteInstallAvailability } from "./release-manifest.js";
import {
  cancelBoxInstall,
  fingerprintsMatch,
  inspectSshHost,
  installOnBox,
  installOverVerifiedSsh,
  type RemotePairingOutput,
  type SshAuth,
} from "./remote-installer.js";
import {
  clearBoxApiKey,
  clearBoxServerId,
  clearSshCredential,
  loadBoxApiKey,
  loadBoxServerId,
  loadSshCredential,
  rehydrateSshAuth,
  sshCredentialLabel,
  trySaveBoxApiKey,
  trySaveBoxServerId,
  trySaveSshCredentialPlain,
} from "./remote-secrets.js";
import {
  clearRemoteUrl,
  loadRemoteUrl,
  normalizeAppUrl,
  remoteUrlFile,
  saveRemoteUrl,
} from "./remote-url.js";
import { SshInspectionStore } from "./ssh-inspection-store.js";
import {
  envFilePath,
  isLocalWebUrl,
  localApiReadyUrl,
  probeUrl,
  resolveStack,
  toComposeMode,
} from "./stack.js";
import { disableRemoteAccess, enableRemoteAccess, readRemoteAccess } from "./tailscale.js";
import { TrustedOriginPolicy } from "./trusted-origins.js";
import { shouldLoadOfflinePage, windowRevealActions } from "./window-behavior.js";
import { waitForWebContentsLoad } from "./window-navigation.js";
import { browserWindowOptions } from "./window-options.js";

interface StackStartResult {
  ok: boolean;
  message: string;
  log?: string;
  url?: string;
  warning?: string;
  /** Religar não achou o Docker: a tela volta ao modo instalação, com botão e termos. */
  needsInstall?: boolean;
  pairing?: {
    url: string;
    code: string;
    expiresAt: string;
    qrSvg: string;
  };
}

interface RemoteSshInspectPayload {
  host: string;
  port?: number;
  username: string;
}

interface RemoteSshPayload {
  inspectionId: string;
  host: string;
  port?: number;
  username: string;
  authType: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  expectedFingerprint: string;
  saveCredential?: boolean;
  operationId?: string;
}

interface RemoteBoxPayload {
  apiKey?: string;
  saveApiKey?: boolean;
  boxId?: string;
  operationId?: string;
}

const WEB_URL = process.env.QUIBT_WEB_URL ?? "http://127.0.0.1:5173";
const trustedPolicy = new TrustedOriginPolicy(WEB_URL);
const PROTOCOL = "quibt";
const MAX_DESKTOP_FILE_BYTES = 10 * 1024 * 1024;
const OFFLINE_PAGE = path.join(import.meta.dirname, "setup.html");
const OFFLINE_PAGE_URL = pathToFileURL(OFFLINE_PAGE).href;

if (process.defaultApp) {
  const script = process.argv[1];
  if (script) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(script)]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Em desenvolvimento o app usa outro nome, e com ele outra pasta de dados e outra
// trava de instância única. Sem isso, `pnpm desktop` segurava a trava de "Quibt Bot"
// e o aplicativo instalado abria, via que já havia instância e saía calado — dava a
// impressão de que o pacote estava quebrado.
app.setName(app.isPackaged ? "Quibt Bot" : "Quibt Bot (dev)");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // The running instance receives our argv through `second-instance` and takes over.
  app.quit();
}

let pendingDeepLink = firstDeepLinkFromArgv(process.argv);
let requestedUrl: string | null = null;
let activeNavigationId = 0;
let intentionalNavigationInFlight = false;
let startupRecoveryMessage: string | null = null;
/** O stack já instalado está só desligado: a tela de setup religa sozinha ao abrir. */
let autoStartPending = false;
let pendingOwnerEnrollment: PendingOwnerEnrollment | null = null;
let pendingLocalOwnerInvite: { apiBase: string; code: string; expiresAt: number } | null = null;
let ownerEnrollmentPreparation: Promise<void> | null = null;
const localInstallGate = new InstallConcurrencyGate<StackStartResult>();
const remoteInstallGate = new InstallConcurrencyGate<StackStartResult>();
const localEmitContexts = new InstallEmitContextRegistry();
const remoteEmitContexts = new InstallEmitContextRegistry();
const sshInspectionStore = new SshInspectionStore();

function parseSshPort(raw: unknown): number | { error: string } {
  const port = typeof raw === "number" && Number.isFinite(raw) ? raw : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { error: "Porta SSH inválida. Use um número entre 1 e 65535." };
  }
  return port;
}

function parseSshInspectPayload(raw: unknown): RemoteSshInspectPayload | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Dados SSH inválidos." };
  const payload = raw as Record<string, unknown>;
  if (typeof payload.host !== "string" || !payload.host.trim()) {
    return { error: "Informe o host SSH." };
  }
  if (typeof payload.username !== "string" || !payload.username.trim()) {
    return { error: "Informe o usuário SSH." };
  }
  const port = parseSshPort(payload.port);
  if (typeof port === "object") return port;
  return {
    host: payload.host.trim(),
    port,
    username: payload.username.trim(),
  };
}

function parseSshPayload(raw: unknown): RemoteSshPayload | { error: string } {
  const base = parseSshInspectPayload(raw);
  if ("error" in base) return base;
  const payload = raw as Record<string, unknown>;
  if (typeof payload.inspectionId !== "string" || !payload.inspectionId.trim()) {
    return { error: "Leia a impressão digital do host antes de instalar." };
  }
  if (typeof payload.expectedFingerprint !== "string" || !payload.expectedFingerprint.trim()) {
    return { error: "Confirme a impressão digital do host antes de conectar." };
  }
  const authType = payload.authType === "privateKey" ? "privateKey" : "password";
  if (authType === "password") {
    if (typeof payload.password !== "string" || !payload.password) {
      return { error: "Informe a senha SSH." };
    }
  } else if (typeof payload.privateKey !== "string" || !payload.privateKey.trim()) {
    return { error: "Informe a chave privada." };
  }
  return {
    inspectionId: payload.inspectionId.trim(),
    host: base.host,
    port: base.port,
    username: base.username,
    authType,
    password: typeof payload.password === "string" ? payload.password : undefined,
    privateKey: typeof payload.privateKey === "string" ? payload.privateKey : undefined,
    passphrase: typeof payload.passphrase === "string" ? payload.passphrase : undefined,
    expectedFingerprint: payload.expectedFingerprint.trim(),
    saveCredential: payload.saveCredential === true,
    operationId: typeof payload.operationId === "string" ? payload.operationId : undefined,
  };
}

function sshAuthFromPayload(payload: RemoteSshPayload): SshAuth {
  if (payload.authType === "password") {
    return { type: "password", password: payload.password ?? "" };
  }
  return {
    type: "privateKey",
    privateKey: payload.privateKey ?? "",
    ...(payload.passphrase ? { passphrase: payload.passphrase } : {}),
  };
}

async function connectInstalledRemote(
  event: Electron.IpcMainInvokeEvent,
  rawUrl: string,
): Promise<StackStartResult> {
  const normalized = normalizeAppUrl(rawUrl);
  if (!normalized.ok) return { ok: false, message: normalized.message };
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, message: "Janela do app não encontrada." };
  const userData = userDataPath();
  trustedPolicy.setRemote(normalized.url);
  try {
    await navigateToUrl(win, normalized.url);
    saveRemoteUrl(userData, normalized.url, new Date().toISOString());
    return { ok: true, message: "Conectado ao servidor remoto.", url: normalized.url };
  } catch (error) {
    trustedPolicy.setRemote(loadRemoteUrl(userData));
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Falha ao conectar ao servidor remoto.",
    };
  }
}

const REMOTE_INSTALL_PENDING_MESSAGE =
  "Instalação remota indisponível neste build de desenvolvimento até o manifesto de release ficar pronto.";

function remoteInstallGateState(): {
  available: boolean;
  message?: string;
  manifest?: ReturnType<typeof loadEmbeddedReleaseManifest>;
} {
  const availability = remoteInstallAvailability({ allowPending: false });
  if (availability.available) return availability;
  if (!app.isPackaged) {
    return { available: false, message: REMOTE_INSTALL_PENDING_MESSAGE };
  }
  return availability;
}

function requireRemoteInstallManifest() {
  const state = remoteInstallGateState();
  if (!state.available || !state.manifest) {
    throw new Error(state.message ?? "Remote install is unavailable in this build.");
  }
  return state.manifest;
}

async function runRemoteInstall(
  event: Electron.IpcMainInvokeEvent,
  operationId: string,
  work: (signal: AbortSignal) => Promise<StackStartResult>,
): Promise<StackStartResult> {
  remoteEmitContexts.set(operationId, {
    senderId: event.sender.id,
    navigationId: activeNavigationId,
  });
  try {
    return await remoteInstallGate.run(operationId, work);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Instalação remota indisponível.",
    };
  } finally {
    remoteEmitContexts.clear(operationId);
  }
}

function mergeWarnings(...warnings: Array<string | undefined>): string | undefined {
  const merged = warnings.filter(Boolean);
  return merged.length > 0 ? merged.join(" ") : undefined;
}

async function finalizeRemoteInstall(
  event: Electron.IpcMainInvokeEvent,
  operationId: string,
  result: {
    ok: boolean;
    url?: string;
    pairing?: RemotePairingOutput;
    error?: string;
    log?: string;
    warning?: string;
  },
  fallbackMessage: string,
): Promise<StackStartResult> {
  if (result.pairing?.code) mayEmitInstallPairing(event, operationId, result.pairing);
  if (result.ok && result.url) {
    if (result.pairing?.code) {
      try {
        pendingOwnerEnrollment = await claimOwnerEnrollment(
          result.url,
          result.pairing.token ? { token: result.pairing.token } : { code: result.pairing.code },
          fetch,
        );
      } catch (error) {
        return {
          ok: false,
          message: `O servidor foi instalado, mas não foi possível preparar a primeira conta: ${
            error instanceof Error ? error.message : "convite inválido"
          }`,
          log: result.log,
          url: result.url,
          warning: result.warning,
        };
      }
    }
    const connected = await connectInstalledRemote(event, result.url);
    return {
      ok: connected.ok,
      message: connected.ok
        ? fallbackMessage
        : (connected.message ?? result.error ?? "Instalação concluída, mas a URL não respondeu."),
      log: result.log,
      url: result.url,
      warning: mergeWarnings(result.warning, connected.ok ? undefined : undefined),
    };
  }
  return {
    ok: false,
    message: result.error ?? "Instalação remota falhou.",
    log: result.log,
    url: result.url,
    warning: result.warning,
  };
}

function userDataPath(): string {
  return app.getPath("userData");
}

function bootstrapTrustedOrigins(userData: string): void {
  trustedPolicy.bootstrap(WEB_URL, loadRemoteUrl(userData));
}

function effectiveWebUrl(userData: string): string {
  return loadRemoteUrl(userData) ?? WEB_URL;
}

function localApiBase(publicUrl: string): string | null {
  const readyUrl = localApiReadyUrl(publicUrl);
  return readyUrl?.replace(/\/ready$/, "") ?? null;
}

/** O install-state.json diz "completo": o Quibt já mora neste computador. */
function installedLocally(userData: string): boolean {
  const inspected = inspectInstallState(userData);
  return inspected.ok && inspected.state !== null && isInstallStateComplete(inspected.state);
}

function rememberLocalOwnerInvite(
  apiBase: string,
  pairing: { code: string; expiresAt: string },
): void {
  const expiresAt = Date.parse(pairing.expiresAt);
  if (!pairing.code.trim() || !Number.isFinite(expiresAt)) return;
  pendingLocalOwnerInvite = { apiBase, code: pairing.code, expiresAt };
}

async function mintLocalOwnerInvite(publicUrl: string): Promise<{
  apiBase: string;
  code: string;
  expiresAt: number;
} | null> {
  const resolution = resolveStack({
    userData: userDataPath(),
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    webUrl: publicUrl,
  });
  const composeMode = toComposeMode(resolution.mode);
  if (resolution.error) throw new Error(resolution.error);
  if (!resolution.composeFile || !composeMode) {
    throw new Error("Não foi possível localizar o stack local para preparar o proprietário.");
  }
  const paired = await runPair({
    dataDir: resolution.dataDir,
    publicUrl,
    composeFile: resolution.composeFile,
    composeMode,
    run: createProcessRunner(),
    fetch,
  });
  if (!paired.ok) {
    if (paired.message === CLAIMED_PAIRING_INSTRUCTION) return null;
    throw new Error(paired.message);
  }
  const apiBase = localApiBase(publicUrl);
  const expiresAt = Date.parse(paired.pairing.expiresAt);
  if (!apiBase || !Number.isFinite(expiresAt)) {
    throw new Error("O convite local de proprietário é inválido.");
  }
  return { apiBase, code: paired.pairing.code, expiresAt };
}

async function prepareLocalOwnerEnrollment(): Promise<void> {
  if (validOwnerEnrollmentToken(pendingOwnerEnrollment)) return;
  pendingOwnerEnrollment = null;
  if (ownerEnrollmentPreparation) return ownerEnrollmentPreparation;

  ownerEnrollmentPreparation = (async () => {
    const publicUrl = effectiveWebUrl(userDataPath());
    if (!isLocalWebUrl(publicUrl)) return;

    let invite = pendingLocalOwnerInvite;
    if (!invite || invite.expiresAt <= Date.now()) {
      pendingLocalOwnerInvite = null;
      invite = await mintLocalOwnerInvite(publicUrl);
    }
    if (!invite) return;

    try {
      pendingOwnerEnrollment = await claimOwnerEnrollment(invite.apiBase, invite.code, fetch);
      pendingLocalOwnerInvite = null;
      return;
    } catch {
      // The displayed code may have expired or been claimed on the phone. Reissue once so
      // reopening the desktop app still gives the local owner a working signup.
      pendingLocalOwnerInvite = null;
    }

    const fresh = await mintLocalOwnerInvite(publicUrl);
    if (!fresh) return;
    pendingOwnerEnrollment = await claimOwnerEnrollment(fresh.apiBase, fresh.code, fetch);
  })();

  try {
    await ownerEnrollmentPreparation;
  } finally {
    ownerEnrollmentPreparation = null;
  }
}

function readRemoteSavedAt(userData: string): string {
  try {
    const raw = JSON.parse(readFileSync(remoteUrlFile(userData), "utf8")) as { savedAt?: string };
    if (typeof raw.savedAt === "string") return raw.savedAt;
  } catch {
    return new Date().toISOString();
  }
  return new Date().toISOString();
}

async function navigateToUrl(win: BrowserWindow, url: string): Promise<void> {
  if (win.isDestroyed()) return;
  const navigationToken = ++activeNavigationId;
  requestedUrl = url;
  intentionalNavigationInFlight = true;
  try {
    await waitForWebContentsLoad(
      win.webContents,
      () => activeNavigationId === navigationToken,
      () => win.loadURL(url),
    );
  } finally {
    if (activeNavigationId === navigationToken) intentionalNavigationInFlight = false;
  }
}

async function navigateToSetup(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  const navigationToken = ++activeNavigationId;
  requestedUrl = OFFLINE_PAGE_URL;
  intentionalNavigationInFlight = true;
  try {
    await waitForWebContentsLoad(
      win.webContents,
      () => activeNavigationId === navigationToken,
      () => win.loadFile(OFFLINE_PAGE),
    );
  } finally {
    if (activeNavigationId === navigationToken) intentionalNavigationInFlight = false;
  }
}

function revealWindow(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  for (const action of windowRevealActions({
    minimized: win.isMinimized(),
    visible: win.isVisible(),
    focused: win.isFocused(),
  })) {
    if (action === "restore") win.restore();
    if (action === "show") win.show();
    if (action === "focus") win.focus();
  }
}

function grantsFile() {
  return path.join(app.getPath("userData"), "folder-grants.json");
}

function loadGrants(): string[] {
  try {
    const raw = JSON.parse(readFileSync(grantsFile(), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((grant): grant is string => typeof grant === "string")
      .flatMap((grant) => {
        try {
          return [realpathSync(grant)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function saveGrants(grants: string[]) {
  mkdirSync(path.dirname(grantsFile()), { recursive: true });
  writeFileSync(grantsFile(), JSON.stringify(grants, null, 2));
}

function validateFilePath(filePath: unknown): asserts filePath is string {
  if (typeof filePath !== "string" || !filePath || filePath.length > 4_096) {
    throw new Error("Invalid file path");
  }
}

function inside(root: string, target: string) {
  return target === root || target.startsWith(root + path.sep);
}

function assertGrantedRead(filePath: string) {
  validateFilePath(filePath);
  const resolved = realpathSync(filePath);
  const ok = loadGrants().some((grant) => inside(grant, resolved));
  if (!ok) throw new Error("Folder is not granted");
  return resolved;
}

function assertGrantedWrite(filePath: string) {
  validateFilePath(filePath);
  const resolved = path.resolve(filePath);
  const grant = loadGrants().find((root) => inside(root, resolved));
  if (!grant) throw new Error("Folder is not granted");
  let ancestor = path.dirname(resolved);
  while (!existsSync(ancestor) && ancestor !== grant) ancestor = path.dirname(ancestor);
  const canonicalAncestor = realpathSync(ancestor);
  if (!inside(grant, canonicalAncestor)) throw new Error("Folder is not granted");
  if (existsSync(resolved)) {
    if (lstatSync(resolved).isSymbolicLink()) throw new Error("Symbolic links are not writable");
    const canonicalTarget = realpathSync(resolved);
    if (!inside(grant, canonicalTarget)) throw new Error("Folder is not granted");
  }
  return resolved;
}

function isTrustedUrl(raw: string) {
  return trustedPolicy.isTrusted(raw);
}

function mayEmitInstallEvent(
  event: Electron.IpcMainInvokeEvent,
  operationId: string,
  registry: InstallEmitContextRegistry,
  payload: Record<string, unknown>,
): void {
  const context = registry.get(operationId);
  if (!context) return;
  if (event.sender.isDestroyed()) return;
  if (event.sender.id !== context.senderId) return;
  if (activeNavigationId !== context.navigationId) return;
  assertExactSetupRenderer(event);
  event.sender.send("desktop.installEvent", payload);
}

function assertExactSetupRenderer(event: Electron.IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || frame.url !== OFFLINE_PAGE_URL) {
    throw new Error("Untrusted setup renderer");
  }
}

function mayEmitInstallPairing(
  event: Electron.IpcMainInvokeEvent,
  operationId: string,
  pairing: RemotePairingOutput,
): void {
  assertExactSetupRenderer(event);
  const context = remoteEmitContexts.get(operationId);
  if (!context) return;
  if (event.sender.isDestroyed()) return;
  if (event.sender.id !== context.senderId) return;
  if (activeNavigationId !== context.navigationId) return;
  event.sender.send("desktop.installPairing", {
    url: pairing.url,
    code: pairing.code,
    expiresAt: pairing.expiresAt,
    qrSvg: pairing.qrSvg,
  });
}

function installEventLabel(step: InstallerEvent["step"]): string {
  switch (step) {
    case "requirements":
      return "Preparar Docker automaticamente";
    case "environment":
      return "Gerar segredos locais";
    case "images":
      return "Preparar imagens";
    case "services":
      return "Subir Postgres, API, worker e o computador";
    case "database":
      return "Aplicar migrações";
    case "health":
      return "Verificar saúde da API";
    case "pairing":
      return "Preparar pareamento";
    default:
      return step;
  }
}

function assertTrustedRenderer(event: Electron.IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !isTrustedUrl(frame.url)) {
    throw new Error("Untrusted desktop renderer");
  }
}

function assertLocalRenderer(event: Electron.IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !trustedPolicy.isLocal(frame.url)) {
    throw new Error("Native desktop capability requires the bundled local app");
  }
}

// The bundled offline page is a file:// URL (origin "null"), so it can never pass
// isTrustedUrl; its only privilege is asking to reload the app.
function assertTrustedOrOfflineRenderer(event: Electron.IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (frame && frame === event.sender.mainFrame && frame.url === OFFLINE_PAGE_URL) return;
  assertTrustedRenderer(event);
}

function assertLocalOrOfflineRenderer(event: Electron.IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (frame && frame === event.sender.mainFrame && frame.url === OFFLINE_PAGE_URL) return;
  assertLocalRenderer(event);
}

function windowFrom(event: Electron.IpcMainInvokeEvent) {
  assertTrustedRenderer(event);
  return BrowserWindow.fromWebContents(event.sender);
}

function developmentIcon() {
  if (app.isPackaged) return undefined;
  const icon = path.join(app.getAppPath(), "assets", "icon.png");
  return existsSync(icon) ? icon : undefined;
}

/**
 * "Abrir o app já é entrar" — provando posse do segredo desta instalação.
 *
 * A API só aceita o auto-login por rede vindo de loopback estrito. Com a stack em Docker
 * isso nunca acontece: o dono chega ao container como `172.17.0.1`, igual a qualquer
 * aparelho do Wi-Fi (a 3100 é publicada em `0.0.0.0` para o QR do celular). Este app, que
 * administra a instalação, assina uma capacidade curta e de uso único com o segredo do
 * `quibt.env`. Sem esse arquivo não há cabeçalho: a pessoa entra pela tela de login.
 */
function registerLocalSessionCapabilityBridge(win: BrowserWindow): void {
  const filter = { urls: ["http://*/*", "https://*/*"] };
  win.webContents.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const webUrl = effectiveWebUrl(userDataPath());
    if (!isLocalSessionRequest(details.url, webUrl)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const secret = desktopAuthSecretFromEnvFile(envFilePath(userDataPath()));
    if (!secret) {
      // Falha clara e sem confiança inventada: segue sem cabeçalho, a API responde 404
      // e o app cai no login normal.
      console.warn("[quibt] sem BETTER_AUTH_SECRET em quibt.env: sessão local não assinada");
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    details.requestHeaders[DESKTOP_CAPABILITY_HEADER] = desktopSessionCapability({
      authSecret: secret,
      method: details.method,
      path: new URL(details.url).pathname,
    });
    callback({ requestHeaders: details.requestHeaders });
  });
}

function registerOwnerEnrollmentRequestBridge(win: BrowserWindow): void {
  const filter = { urls: ["http://*/*", "https://*/*"] };
  const webRequest = win.webContents.session.webRequest;
  webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const webUrl = effectiveWebUrl(userDataPath());
    const token = validOwnerEnrollmentToken(pendingOwnerEnrollment);
    if (token && isFirstOwnerSignupRequest(details.url, webUrl)) {
      details.requestHeaders["x-quibt-enrollment"] = token;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  webRequest.onCompleted(filter, (details) => {
    const webUrl = effectiveWebUrl(userDataPath());
    if (
      pendingOwnerEnrollment &&
      isFirstOwnerSignupRequest(details.url, webUrl) &&
      shouldClearOwnerEnrollment(details.statusCode)
    ) {
      pendingOwnerEnrollment = null;
    }
  });
}

function createWindow() {
  const icon = developmentIcon();
  const win = new BrowserWindow({
    ...browserWindowOptions(process.platform),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  registerOwnerEnrollmentRequestBridge(win);
  registerLocalSessionCapabilityBridge(win);
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || wc.getURL();
    const local = wc === win.webContents && trustedPolicy.isLocal(requestingUrl);
    callback(local && (permission === "notifications" || permission === "media"));
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isTrustedUrl(url)) return;
    event.preventDefault();
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
  });
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (intentionalNavigationInFlight) return;
      const failure = parseDidFailLoad(
        _event,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      );
      if (!isMainFrameLoadFailure(failure)) return;
      const showOffline = shouldLoadOfflinePage({
        isMainFrame: failure.isMainFrame,
        url: failure.validatedURL,
        errorCode: failure.errorCode,
        requestedUrl,
        offlineAvailable: existsSync(OFFLINE_PAGE),
        destroyed: win.isDestroyed(),
      });
      if (showOffline) void navigateToSetup(win);
    },
  );
  void openInitialPage(win).catch(() => {
    startupRecoveryMessage = LOCAL_UNAVAILABLE_MESSAGE;
  });
  return win;
}

async function openInitialPage(win: BrowserWindow) {
  const userData = userDataPath();
  bootstrapTrustedOrigins(userData);
  const target = effectiveWebUrl(userData);
  const plan = await planInitialNavigation(target, probeUrl, isLocalWebUrl, () =>
    installedLocally(userData),
  );

  if (plan.action === "setup") {
    if (plan.clearRemote) clearRemoteUrl(userData);
    trustedPolicy.setRemote(null);
    // Instalado e desligado não é "não responde": a tela de setup religa sozinha e
    // mostra "Ligando o Quibt Bot…" em vez do aviso de stack indisponível.
    autoStartPending = plan.autoStart === true;
    startupRecoveryMessage = autoStartPending ? null : plan.message;
    if (!win.isDestroyed() && existsSync(OFFLINE_PAGE)) {
      await navigateToSetup(win);
    }
    return;
  }

  trustedPolicy.setRemote(plan.remote ? plan.url : null);
  if (!plan.remote && isLocalWebUrl(plan.url)) {
    try {
      await prepareLocalOwnerEnrollment();
    } catch (error) {
      startupRecoveryMessage =
        error instanceof Error
          ? `O servidor abriu, mas o acesso do proprietário não ficou pronto: ${error.message}`
          : "O servidor abriu, mas o acesso do proprietário não ficou pronto.";
      if (!win.isDestroyed() && existsSync(OFFLINE_PAGE)) {
        await navigateToSetup(win);
      }
      return;
    }
  }
  try {
    await navigateToUrl(win, plan.url);
  } catch {
    if (plan.remote) {
      clearRemoteUrl(userData);
      trustedPolicy.setRemote(null);
      startupRecoveryMessage = REMOTE_UNAVAILABLE_MESSAGE;
    } else {
      startupRecoveryMessage = LOCAL_UNAVAILABLE_MESSAGE;
    }
    if (!win.isDestroyed() && existsSync(OFFLINE_PAGE)) {
      await navigateToSetup(win);
    }
  }
}

function openDeepLink(raw: string) {
  const next = webUrlFromDeepLink(raw, effectiveWebUrl(userDataPath()));
  if (!next) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    pendingDeepLink = raw;
    // A link that arrives while the app is ready but has no window (macOS) must still open it.
    if (app.isReady()) {
      createWindow();
      flushPendingDeepLink();
    }
    return;
  }
  trustedPolicy.setRemote(isLocalWebUrl(next) ? null : next);
  void navigateToUrl(win, next);
  revealWindow(win);
}

const APP_NAME = "Quibt Bot";

/**
 * No macOS o primeiro menu leva o nome do bundle, e em desenvolvimento o bundle é
 * o do Electron. Um menu próprio devolve o nome do produto sem perder os atalhos.
 */
function applicationMenu() {
  const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about", label: `Sobre o ${APP_NAME}` },
        { type: "separator" },
        { role: "hide", label: `Ocultar ${APP_NAME}` },
        { role: "hideOthers", label: "Ocultar outros" },
        { role: "unhide", label: "Mostrar tudo" },
        { type: "separator" },
        { label: `Desinstalar o ${APP_NAME}…`, click: () => void uninstallFromDesktop() },
        { type: "separator" },
        { role: "quit", label: `Sair do ${APP_NAME}` },
      ],
    },
    { role: "editMenu", label: "Editar" },
    { role: "viewMenu", label: "Exibir" },
    { role: "windowMenu", label: "Janela" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Instalar põe containers, imagens e uma pasta de dados na máquina; apagar o app
 * sozinho deixava tudo isso para trás. Este é o caminho de volta: pergunta uma vez,
 * desfaz o que o install criou (e só isso), e por fim manda o próprio app para o lixo.
 */
let uninstalling = false;

async function uninstallFromDesktop(): Promise<void> {
  if (uninstalling) return;
  const userData = userDataPath();
  const resolution = resolveStack({
    userData,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    webUrl: effectiveWebUrl(userData),
  });
  const win = BrowserWindow.getAllWindows()[0];
  const ask = await dialog.showMessageBox(win ?? (null as unknown as BrowserWindow), {
    type: "warning",
    buttons: ["Desinstalar tudo", "Desinstalar e manter as imagens", "Cancelar"],
    defaultId: 2,
    cancelId: 2,
    title: `Desinstalar o ${APP_NAME}`,
    message: "Tirar o Quibt Bot deste computador?",
    detail: [
      `Isto remove os serviços do Quibt no Docker, os computadores dos bots, as imagens baixadas (uns 6 GB) e a pasta de dados (${userData}) — conversas, memória e segredos inclusos.`,
      "Manter as imagens só acelera uma reinstalação. O Docker continua instalado. Bots numa VPS, E2B ou Box não são tocados.",
    ].join("\n\n"),
    checkboxLabel: "Manter meus dados (banco e arquivos dos bots) para reinstalar depois",
    checkboxChecked: false,
  });
  if (ask.response === 2) return;
  uninstalling = true;
  const keepData = ask.checkboxChecked;
  const keepImages = ask.response === 1;
  const result = await runUninstall({
    dataDir: userData,
    composeFile: resolution.composeFile ?? "",
    run: createProcessRunner(),
    keepData,
    keepImages,
    // Sem manifesto do compose (build sem recursos), o down não tem o que derrubar; o resto segue.
    onEvent: (event) => console.log(`[uninstall:${event.step}] ${event.status}: ${event.message}`),
  });
  uninstalling = false;
  const bundle = app.isPackaged ? appBundlePath(app.getPath("exe")) : null;
  const summary = result.leftovers.length
    ? `Ficou:\n${result.leftovers.join("\n")}`
    : "Nada ficou para trás.";
  await dialog.showMessageBox(win ?? (null as unknown as BrowserWindow), {
    type: result.ok ? "info" : "warning",
    buttons: ["Fechar o app"],
    title: `Desinstalar o ${APP_NAME}`,
    message: result.ok ? "O Quibt saiu deste computador." : "A desinstalação não terminou limpa.",
    detail: [summary, bundle ? `O app vai para o Lixo ao fechar.` : ""]
      .filter(Boolean)
      .join("\n\n"),
  });
  if (bundle) {
    await shell.trashItem(bundle).catch(() => undefined);
  }
  if (!keepData && process.platform !== "win32") {
    // O Chromium ainda grava cache na pasta ao sair; um último rm, fora do processo, termina o serviço.
    spawn("sh", ["-c", `sleep 2; rm -rf "${userData.replace(/"/g, '\\"')}"`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  app.exit(0);
}

function flushPendingDeepLink() {
  if (!pendingDeepLink) return;
  const raw = pendingDeepLink;
  pendingDeepLink = null;
  openDeepLink(raw);
}

async function runLocalInstall(
  event: Electron.IpcMainInvokeEvent,
  operationId: string,
): Promise<StackStartResult> {
  localEmitContexts.set(operationId, {
    senderId: event.sender.id,
    navigationId: activeNavigationId,
  });
  try {
    const userData = userDataPath();
    const publicUrl = effectiveWebUrl(userData);
    const resolution = resolveStack({
      userData,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      webUrl: publicUrl,
    });

    if (resolution.error) {
      return { ok: false, message: resolution.error };
    }

    if (resolution.mode === "remote") {
      return {
        ok: false,
        message:
          "Este app aponta para um servidor remoto. Use Conectar a outro servidor ou defina QUIBT_WEB_URL=http://127.0.0.1:5173.",
      };
    }

    if (!resolution.composeFile) {
      return {
        ok: false,
        message:
          resolution.mode === "packaged-images"
            ? "Este instalador não encontrou compose/docker-compose.desktop.yml nos recursos do app. Reinstale o pacote ou defina QUIBT_COMPOSE_FILE."
            : "Não achei o docker-compose. Rode a partir do repositório (pnpm desktop) ou aponte QUIBT_WEB_URL para um deploy remoto.",
      };
    }

    const composeMode = toComposeMode(resolution.mode);
    if (!composeMode) {
      return { ok: false, message: "Modo de instalação inválido para este ambiente." };
    }

    const logs: string[] = [];
    const result = await runInstall({
      dataDir: resolution.dataDir,
      publicUrl: isLocalWebUrl(publicUrl) ? publicUrl : WEB_URL,
      composeFile: resolution.composeFile,
      composeMode,
      run: createProcessRunner(),
      fetch,
      clock: createClock(),
      onEvent: (installEvent) => {
        logs.push(`[${installEvent.step}] ${installEvent.status}: ${installEvent.message}`);
        mayEmitInstallEvent(event, operationId, localEmitContexts, {
          ...installEvent,
          label: installEventLabel(installEvent.step),
        });
      },
    });

    if (!result.ok) {
      // A frase do orquestrador já diz o que fazer; o stderr cru fica nos detalhes.
      const failedStep = result.alreadyInstalled ? null : nextInstallStep(result.state);
      const reason = withDesktopRetryHint(
        result.error ?? "A instalação falhou. Veja os detalhes técnicos abaixo.",
      );
      if (result.errorDetail) logs.push(`[detalhes técnicos]\n${result.errorDetail}`);
      return {
        ok: false,
        message: failedStep ? `${installEventLabel(failedStep)} falhou: ${reason}` : reason,
        log: logs.join("\n"),
        needsInstall: result.dockerMissing === true,
      };
    }
    const log = logs.join("\n");

    if (result.pairing) {
      const apiBase = localApiBase(publicUrl);
      if (apiBase) rememberLocalOwnerInvite(apiBase, result.pairing);
    }

    const readyUrl = localApiReadyUrl(isLocalWebUrl(publicUrl) ? publicUrl : WEB_URL);
    const webOrigin = new URL(isLocalWebUrl(publicUrl) ? publicUrl : WEB_URL).origin;
    for (let i = 0; i < 40; i += 1) {
      const apiOk = readyUrl ? await probeUrl(readyUrl) : true;
      const webOk = await probeUrl(`${webOrigin}/`);
      if (apiOk && webOk) {
        return {
          ok: true,
          message: result.pairing
            ? "Instalação concluída. Use o código abaixo para parear o celular."
            : result.alreadyInstalled
              ? `Quibt Bot no ar em ${result.url ?? webOrigin}.`
              : "Stack no ar.",
          log,
          pairing: result.pairing
            ? {
                url: result.pairing.url,
                code: result.pairing.code,
                expiresAt: result.pairing.expiresAt,
                qrSvg: result.pairing.qrSvg,
              }
            : undefined,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return {
      ok: false,
      // "Subiu" só quando um compose up de fato rodou nesta chamada.
      message: result.servicesStarted
        ? "O stack subiu, mas a API /ready ou a UI em :5173 ainda não respondem. Espere um minuto e tente de novo."
        : "A instalação consta como concluída, mas a API /ready ou a UI em :5173 não respondem. Tente de novo; se continuar, veja os detalhes técnicos.",
      log,
    };
  } finally {
    localEmitContexts.clear(operationId);
  }
}

// O nome de exibição é sempre o do produto; quem muda em desenvolvimento é a pasta
// de dados, decidida lá em cima antes da trava.
if (app.isPackaged) app.setName(APP_NAME);

if (gotLock) {
  app.whenReady().then(() => {
    const icon = developmentIcon();
    if (process.platform === "darwin" && icon) app.dock?.setIcon(icon);
    if (process.platform === "darwin") applicationMenu();
    ipcMain.handle("desktop.platform", (event) => {
      assertTrustedRenderer(event);
      return process.platform;
    });
    ipcMain.handle("desktop.startupNotice", (event) => {
      assertTrustedOrOfflineRenderer(event);
      const message = startupRecoveryMessage;
      startupRecoveryMessage = null;
      return message;
    });
    ipcMain.handle("desktop.autoStartPending", (event) => {
      // Lido uma vez pela tela de setup: religa o stack instalado sem clique.
      assertExactSetupRenderer(event);
      const pending = autoStartPending;
      autoStartPending = false;
      return pending;
    });
    ipcMain.handle("desktop.reloadApp", async (event) => {
      assertTrustedOrOfflineRenderer(event);
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      const userData = userDataPath();
      const target = effectiveWebUrl(userData);
      trustedPolicy.setRemote(isLocalWebUrl(target) ? null : target);
      if (isLocalWebUrl(target)) await prepareLocalOwnerEnrollment();
      await navigateToUrl(win, target);
    });
    ipcMain.handle("desktop.lanInfo", async (event) => {
      assertLocalRenderer(event);
      // O endereço do tailnet vence o da LAN: é o único que continua valendo quando
      // o celular sai do wi-fi, e não muda quando este computador troca de rede.
      const remote = await readRemoteAccess().catch(() => null);
      const api = remote?.kind === "on" ? remote.url : lanApiUrl();
      return { api, remote: remote ?? { kind: "off", reason: "missing" } };
    });
    ipcMain.handle("desktop.remoteAccess", async (event, raw: unknown) => {
      assertLocalRenderer(event);
      const wanted = raw && typeof raw === "object" ? (raw as { enabled?: unknown }).enabled : null;
      if (wanted === true) return enableRemoteAccess();
      if (wanted === false) return disableRemoteAccess();
      return readRemoteAccess();
    });
    ipcMain.handle("desktop.uninstall", async (event) => {
      // O mesmo caminho do menu "Desinstalar o Quibt Bot…", alcançável de dentro do
      // produto (Conta) e do assistente — quem não vai ao menu do sistema ainda acha.
      assertLocalOrOfflineRenderer(event);
      await uninstallFromDesktop();
    });
    ipcMain.handle("desktop.startStack", async (event, raw: unknown) => {
      assertLocalOrOfflineRenderer(event);
      const operationId =
        raw &&
        typeof raw === "object" &&
        typeof (raw as Record<string, unknown>).operationId === "string"
          ? String((raw as Record<string, unknown>).operationId)
          : "local-install";
      try {
        return await localInstallGate.run(operationId, () => runLocalInstall(event, operationId));
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Instalação local indisponível.",
        };
      }
    });
    ipcMain.handle("desktop.completeLocalPairing", async (event) => {
      assertExactSetupRenderer(event);
      try {
        await finalizePairingInstall(userDataPath(), createClock());
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error ? error.message : "Não foi possível concluir o pareamento.",
        };
      }
    });
    ipcMain.handle("desktop.connectRemote", async (event, rawUrl: unknown) => {
      assertLocalOrOfflineRenderer(event);
      if (typeof rawUrl !== "string") {
        return { ok: false, message: "URL inválida. Use http:// ou https://." };
      }
      const normalized = normalizeAppUrl(rawUrl);
      if (!normalized.ok) return { ok: false, message: normalized.message };
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: false, message: "Janela do app não encontrada." };
      const userData = userDataPath();
      const previousRemote = loadRemoteUrl(userData);
      const previousSavedAt = previousRemote ? readRemoteSavedAt(userData) : null;
      trustedPolicy.setRemote(normalized.url);
      try {
        await navigateToUrl(win, normalized.url);
        saveRemoteUrl(userData, normalized.url, new Date().toISOString());
        return { ok: true, message: "Conectado ao servidor remoto." };
      } catch (error) {
        trustedPolicy.setRemote(previousRemote);
        if (previousRemote && previousSavedAt) {
          saveRemoteUrl(userData, previousRemote, previousSavedAt);
        } else {
          clearRemoteUrl(userData);
        }
        try {
          await navigateToSetup(win);
        } catch {
          // setup navigation failure is reported below
        }
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Falha ao conectar.",
        };
      }
    });
    ipcMain.handle("desktop.forgetRemote", async (event) => {
      assertTrustedOrOfflineRenderer(event);
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: false, message: "Janela do app não encontrada." };
      const userData = userDataPath();
      clearRemoteUrl(userData);
      trustedPolicy.setRemote(null);
      try {
        await navigateToSetup(win);
        return { ok: true, message: "Voltando para instalação neste computador." };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Falha ao abrir o setup local.",
        };
      }
    });
    ipcMain.handle("desktop.remoteInstallStatus", (event) => {
      assertLocalOrOfflineRenderer(event);
      const state = remoteInstallGateState();
      return { available: state.available, message: state.message ?? null };
    });
    ipcMain.handle("desktop.guidedVpsBootstrap", async (event) => {
      assertLocalOrOfflineRenderer(event);
      const state = remoteInstallGateState();
      if (!state.available || !state.manifest) {
        return {
          ok: false,
          message: state.message ?? "Manifesto de release inválido ou indisponível.",
        };
      }
      try {
        const command = guidedVpsBootstrapCommand(state.manifest);
        return { ok: true, command };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Manifesto de release inválido ou indisponível.",
        };
      }
    });
    ipcMain.handle("desktop.inspectSshHost", async (event, raw: unknown) => {
      assertLocalOrOfflineRenderer(event);
      const parsed = parseSshInspectPayload(raw);
      if ("error" in parsed) return { ok: false, message: parsed.error };
      try {
        const identity = await inspectSshHost({
          hostname: parsed.host,
          port: parsed.port,
          username: parsed.username,
        });
        const inspection = sshInspectionStore.create({
          hostname: identity.hostname,
          ip: identity.ip,
          port: identity.port,
          username: parsed.username,
          algorithm: identity.algorithm,
          fingerprint: identity.fingerprint,
        });
        return {
          ok: true,
          inspectionId: inspection.inspectionId,
          hostname: identity.hostname,
          ip: identity.ip,
          port: identity.port,
          algorithm: identity.algorithm,
          fingerprint: identity.fingerprint,
          display: `${identity.hostname} (${identity.ip}:${identity.port})`,
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Falha ao ler impressão digital SSH.",
        };
      }
    });
    ipcMain.handle("desktop.installOverSsh", async (event, raw: unknown) => {
      assertLocalOrOfflineRenderer(event);
      const parsed = parseSshPayload(raw);
      if ("error" in parsed) return { ok: false, message: parsed.error };
      const inspection = sshInspectionStore.consume(parsed.inspectionId);
      if (!inspection) {
        return { ok: false, message: "Inspeção SSH expirada. Leia a impressão digital novamente." };
      }
      if (inspection.username !== parsed.username || inspection.hostname !== parsed.host) {
        return { ok: false, message: "Os dados SSH não correspondem à inspeção confirmada." };
      }
      if (!fingerprintsMatch(inspection.fingerprint, parsed.expectedFingerprint)) {
        return { ok: false, message: "A impressão digital confirmada não corresponde à inspeção." };
      }
      const state = remoteInstallGateState();
      if (!state.available) {
        return { ok: false, message: state.message ?? "Instalação remota indisponível." };
      }
      const operationId = parsed.operationId ?? "remote-ssh";
      return runRemoteInstall(event, operationId, async (signal) => {
        let warning: string | undefined;
        const manifest = requireRemoteInstallManifest();
        const result = await installOverVerifiedSsh(
          {
            hostname: inspection.hostname,
            ip: inspection.ip,
            port: inspection.port,
            username: inspection.username,
            auth: sshAuthFromPayload(parsed),
          },
          inspection.fingerprint,
          (installEvent) => {
            mayEmitInstallEvent(event, operationId, remoteEmitContexts, {
              ...installEvent,
              label: installEventLabel(installEvent.step),
            });
          },
          { signal, releaseManifest: manifest },
        );
        if (result.ok && parsed.saveCredential) {
          const auth = sshAuthFromPayload(parsed);
          const saved = trySaveSshCredentialPlain(userDataPath(), {
            hostname: inspection.hostname,
            ip: inspection.ip,
            port: inspection.port,
            username: inspection.username,
            authType: parsed.authType,
            secret: auth.type === "password" ? auth.password : auth.privateKey,
            ...(auth.type === "privateKey" && auth.passphrase
              ? { passphrase: auth.passphrase }
              : {}),
            fingerprint: inspection.fingerprint,
          });
          if (!saved.ok) warning = saved.warning;
        }
        const finalized = await finalizeRemoteInstall(
          event,
          operationId,
          { ...result, warning: mergeWarnings(result.warning, warning) },
          "Servidor remoto instalado e conectado.",
        );
        return finalized;
      });
    });
    ipcMain.handle("desktop.installOnBox", async (event, raw: unknown) => {
      assertLocalOrOfflineRenderer(event);
      const payload = (raw ?? {}) as RemoteBoxPayload;
      const userData = userDataPath();
      const apiKey =
        (typeof payload.apiKey === "string" && payload.apiKey.trim()) ||
        loadBoxApiKey(userData) ||
        "";
      if (!apiKey) {
        return { ok: false, message: "Informe a API key Box." };
      }
      const state = remoteInstallGateState();
      if (!state.available) {
        return { ok: false, message: state.message ?? "Instalação remota indisponível." };
      }
      const operationId = payload.operationId ?? "remote-box";
      const boxId = payload.boxId ?? loadBoxServerId(userData) ?? undefined;
      return runRemoteInstall(event, operationId, async (signal) => {
        let warning: string | undefined;
        remoteInstallGate.setActiveState({ kind: "box", apiKey });
        if (payload.saveApiKey && typeof payload.apiKey === "string" && payload.apiKey.trim()) {
          const saved = trySaveBoxApiKey(userData, payload.apiKey.trim());
          if (!saved.ok) warning = saved.warning;
        }
        const manifest = requireRemoteInstallManifest();
        const result = await installOnBox(
          { apiKey, boxId },
          (installEvent) => {
            mayEmitInstallEvent(event, operationId, remoteEmitContexts, {
              ...installEvent,
              label: installEventLabel(installEvent.step),
            });
          },
          {
            signal,
            releaseManifest: manifest,
            onBoxAllocated: (allocatedBoxId) => {
              remoteInstallGate.setActiveState({ kind: "box", apiKey, boxId: allocatedBoxId });
            },
          },
        );
        if (result.ok && result.boxId) {
          const savedBox = trySaveBoxServerId(userData, result.boxId);
          if (!savedBox.ok) warning = mergeWarnings(warning, savedBox.warning);
        }
        return finalizeRemoteInstall(
          event,
          operationId,
          { ...result, warning: mergeWarnings(result.warning, warning) },
          "Servidor Box instalado e conectado.",
        );
      });
    });
    ipcMain.handle("desktop.cancelRemoteInstall", async (event, raw: unknown) => {
      assertLocalOrOfflineRenderer(event);
      const payload = (raw ?? {}) as { operationId?: string; kind?: "ssh" | "box" };
      if (!payload.operationId) {
        return { ok: false, message: "Operação remota não encontrada." };
      }
      const active = remoteInstallGate.activeState();
      const cancelled = remoteInstallGate.cancel(payload.operationId);
      if (payload.kind === "box" && active?.kind === "box" && active.apiKey && active.boxId) {
        await cancelBoxInstall(active.apiKey, active.boxId, fetch, { timeoutMs: 10_000 }).catch(
          () => undefined,
        );
      }
      return {
        ok: cancelled,
        message: cancelled
          ? "Instalação remota cancelada."
          : "Nenhuma instalação remota ativa com esse id.",
      };
    });
    ipcMain.handle("desktop.remoteSecrets", (event) => {
      assertLocalOrOfflineRenderer(event);
      const userData = userDataPath();
      const ssh = loadSshCredential(userData);
      return {
        hasBoxApiKey: Boolean(loadBoxApiKey(userData)),
        boxServerId: loadBoxServerId(userData),
        ssh: ssh
          ? {
              label: sshCredentialLabel(ssh),
              fingerprint: ssh.fingerprint,
              savedAt: ssh.savedAt,
              canRehydrate: Boolean(rehydrateSshAuth(ssh)),
            }
          : null,
      };
    });
    ipcMain.handle("desktop.forgetRemoteSecrets", (event, raw: unknown) => {
      assertLocalOrOfflineRenderer(event);
      const userData = userDataPath();
      const target = typeof raw === "string" ? raw : "all";
      if (target === "box" || target === "all") {
        clearBoxApiKey(userData);
        clearBoxServerId(userData);
      }
      if (target === "ssh" || target === "all") clearSshCredential(userData);
      return { ok: true, message: "Credenciais de infraestrutura removidas." };
    });
    ipcMain.handle("desktop.window.close", (event) => {
      windowFrom(event)?.close();
    });
    ipcMain.handle("desktop.window.minimize", (event) => {
      windowFrom(event)?.minimize();
    });
    ipcMain.handle("desktop.window.toggleMaximize", (event) => {
      const win = windowFrom(event);
      if (!win) return;
      if (win.isMaximized() || win.isFullScreen()) {
        win.setFullScreen(false);
        if (win.isMaximized()) win.unmaximize();
      } else {
        win.maximize();
      }
    });
    ipcMain.handle("desktop.window.state", (event) => {
      const win = windowFrom(event);
      return {
        minimized: win?.isMinimized() ?? false,
        maximized: win?.isMaximized() ?? false,
        fullScreen: win?.isFullScreen() ?? false,
      };
    });
    ipcMain.handle("desktop.grantFolder", async (event) => {
      assertLocalRenderer(event);
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error("Desktop window not found");
      const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
      const folder = result.filePaths[0];
      if (!folder) return null;
      const canonicalFolder = realpathSync(folder);
      const grants = loadGrants();
      if (!grants.includes(canonicalFolder)) {
        grants.push(canonicalFolder);
        saveGrants(grants);
      }
      return canonicalFolder;
    });
    ipcMain.handle("desktop.listGrants", (event) => {
      assertLocalRenderer(event);
      return loadGrants();
    });
    ipcMain.handle("desktop.readGranted", (event, filePath: string) => {
      assertLocalRenderer(event);
      const target = assertGrantedRead(filePath);
      const stats = statSync(target);
      if (!stats.isFile() || stats.size > MAX_DESKTOP_FILE_BYTES) throw new Error("Invalid file");
      return readFileSync(target, "utf8");
    });
    ipcMain.handle("desktop.writeGranted", (event, filePath: string, content: string) => {
      assertLocalRenderer(event);
      if (typeof content !== "string" || Buffer.byteLength(content) > MAX_DESKTOP_FILE_BYTES) {
        throw new Error("File is too large");
      }
      const target = assertGrantedWrite(filePath);
      mkdirSync(path.dirname(target), { recursive: true });
      const descriptor = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(descriptor, content, "utf8");
      } finally {
        closeSync(descriptor);
      }
      return true;
    });
    createWindow();
    flushPendingDeepLink();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        flushPendingDeepLink();
      }
    });
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    openDeepLink(url);
  });

  app.on("second-instance", (_event, argv) => {
    const raw = firstDeepLinkFromArgv(argv);
    if (raw) openDeepLink(raw);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) revealWindow(win);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
