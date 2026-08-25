import { Platform } from "react-native";
import {
  buildRemoteBootstrapShell,
  type EmbeddedReleaseManifest,
  resolveEmbeddedReleaseArtifacts,
  selectLinuxArtifact,
} from "./release-artifacts.js";
import {
  collectTransportSecrets,
  emitInstallerEvent,
  fingerprintSha256FromKeyBytes,
  fingerprintsMatch,
  type InstallResult,
  normalizeSha256Fingerprint,
  normalizeSshPort,
  parseInstallerOutput,
  type SshInstallTransport,
  type SshTransportConfig,
  type SshTransportCredentials,
} from "./remote-installer.js";

export interface SshNativeBridge {
  inspectHostKey(host: string, port: number): Promise<{ algorithm: string; fingerprint: string }>;
  connectVerified(input: {
    host: string;
    port: number;
    username: string;
    expectedFingerprint: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
  }): Promise<string>;
  execute(clientKey: string, command: string): Promise<string>;
  disconnect(clientKey: string): Promise<void>;
}

type NativeSshModule = {
  inspectHostKey?: (
    host: string,
    port: number,
  ) => Promise<{ algorithm: string; fingerprint: string }>;
  connectVerifiedHost?: (
    host: string,
    port: number,
    username: string,
    expectedFingerprint: string,
    auth: { password?: string; privateKey?: string; passphrase?: string },
  ) => Promise<string>;
  execute?: (
    command: string,
    clientKey: string,
    callback: (error: unknown, response?: string) => void,
  ) => void;
  disconnectVerified?: (clientKey: string) => Promise<void>;
  disconnect?: (clientKey: string) => void;
};

function loadNativeModule(): NativeSshModule | null {
  try {
    const { NativeModules } = require("react-native") as typeof import("react-native");
    return (NativeModules.RNSSHClient ?? null) as NativeSshModule | null;
  } catch {
    return null;
  }
}

function createDefaultBridge(): SshNativeBridge {
  const native = loadNativeModule();
  if (
    !native?.inspectHostKey ||
    !native.connectVerifiedHost ||
    !native.execute ||
    !native.disconnect
  ) {
    throw new Error(
      "Verified SSH is unavailable: install the patched @dylankenneally/react-native-ssh-sftp native module.",
    );
  }

  return {
    inspectHostKey: (host, port) => native.inspectHostKey!(host, port),
    connectVerified: (input) =>
      native.connectVerifiedHost!(
        input.host,
        input.port,
        input.username,
        normalizeSha256Fingerprint(input.expectedFingerprint),
        {
          password: input.password,
          privateKey: input.privateKey,
          passphrase: input.passphrase,
        },
      ),
    execute: (clientKey, command) =>
      new Promise<string>((resolve, reject) => {
        native.execute!(command, clientKey, (error: unknown, response?: string) => {
          if (error) reject(error instanceof Error ? error : new Error(String(error)));
          else resolve(response ?? "");
        });
      }),
    disconnect: (clientKey) => {
      if (native.disconnectVerified) return native.disconnectVerified(clientKey);
      native.disconnect?.(clientKey);
      return Promise.resolve();
    },
  };
}

export interface SshInstallTransportOptions extends SshTransportConfig {
  bridge?: SshNativeBridge;
  resolveHost?: (hostname: string, port: number) => Promise<string>;
  release?: EmbeddedReleaseManifest;
}

export function createSshInstallTransport(
  options: SshInstallTransportOptions,
): SshInstallTransport {
  const bridge = options.bridge ?? createDefaultBridge();
  const port = normalizeSshPort(options.port);
  let resolvedHost = options.ip?.trim() || options.hostname.trim();
  let inspectedFingerprint = "";
  let clientKey: string | undefined;
  let credentials: SshTransportCredentials | undefined;
  let loadCredential: (() => Promise<SshTransportCredentials>) | undefined;

  async function resolveTargetHost(): Promise<string> {
    if (options.ip?.trim()) return options.ip.trim();
    if (options.resolveHost) return options.resolveHost(options.hostname, port);
    return options.hostname.trim();
  }

  const transport: SshInstallTransport = {
    attachCredential(loader) {
      loadCredential = loader;
    },
    async inspectIdentity() {
      resolvedHost = await resolveTargetHost();
      const identity = await bridge.inspectHostKey(resolvedHost, port);
      inspectedFingerprint = normalizeSha256Fingerprint(identity.fingerprint);
      return {
        algorithm: identity.algorithm,
        fingerprint: inspectedFingerprint,
      };
    },
    async connect(expectedFingerprint) {
      const expected = normalizeSha256Fingerprint(expectedFingerprint);
      if (!expected) {
        throw new Error("Expected SSH host fingerprint is required.");
      }
      if (!inspectedFingerprint) {
        throw new Error("Inspect the SSH host fingerprint before connecting.");
      }
      if (!fingerprintsMatch(inspectedFingerprint, expected)) {
        await transport.close();
        throw new Error("SSH host fingerprint mismatch");
      }
      if (!loadCredential) {
        throw new Error("SSH credentials are required after host verification.");
      }
      credentials = await loadCredential();
      const secrets = collectTransportSecrets(credentials);
      if (secrets.length === 0) {
        throw new Error("SSH credentials are required after host verification.");
      }

      clientKey = await bridge.connectVerified({
        host: resolvedHost,
        port,
        username: options.username,
        expectedFingerprint: expected,
        ...(credentials.type === "password"
          ? { password: credentials.password }
          : {
              privateKey: credentials.privateKey,
              passphrase: credentials.passphrase,
            }),
      });
    },
    async runInstall(onEvent) {
      if (!clientKey || !credentials) {
        throw new Error("SSH transport is not connected.");
      }
      const secrets = collectTransportSecrets(credentials);
      const release = resolveEmbeddedReleaseArtifacts(options.release);

      emitInstallerEvent(
        onEvent,
        {
          step: "requirements",
          status: "running",
          message: `Connecting to ${options.hostname}`,
        },
        secrets,
      );
      emitInstallerEvent(
        onEvent,
        { step: "requirements", status: "succeeded", message: "SSH host verified" },
        secrets,
      );

      const archResult = await bridge.execute(clientKey, "uname -m");
      const artifact = selectLinuxArtifact(archResult);
      if (!artifact) {
        throw new Error(`Unsupported remote architecture: ${archResult.trim() || "unknown"}`);
      }

      emitInstallerEvent(
        onEvent,
        {
          step: "images",
          status: "running",
          message: "Downloading and verifying quibtbot",
        },
        secrets,
      );

      const command = buildRemoteBootstrapShell(release);
      const output = await bridge.execute(clientKey, command);
      const parsed = parseInstallerOutput(output, secrets, onEvent);

      emitInstallerEvent(
        onEvent,
        { step: "health", status: "succeeded", message: "Remote install finished" },
        secrets,
      );

      return {
        ok: true,
        url: parsed.url,
        pairing: parsed.pairing?.code ? parsed.pairing : undefined,
        log: parsed.log,
      } satisfies InstallResult;
    },
    async close() {
      if (clientKey) {
        await bridge.disconnect(clientKey).catch(() => undefined);
      }
      clientKey = undefined;
      credentials = undefined;
      loadCredential = undefined;
    },
  };

  return transport;
}

export function createTestSshBridge(_fingerprint: string): SshNativeBridge {
  const keyBytes = Uint8Array.from([
    0,
    0,
    0,
    11,
    ...new TextEncoder().encode("ssh-ed25519"),
    0,
    0,
    0,
    4,
    1,
    2,
    3,
    4,
  ]);
  const actual = fingerprintSha256FromKeyBytes(keyBytes);
  let connected = false;
  let clientCounter = 0;

  return {
    async inspectHostKey() {
      return { algorithm: "ssh-ed25519", fingerprint: actual };
    },
    async connectVerified(input) {
      if (!fingerprintsMatch(actual, input.expectedFingerprint)) {
        throw new Error("SSH host fingerprint mismatch");
      }
      if (!input.password && !input.privateKey) {
        throw new Error("SSH credentials are required after host verification.");
      }
      connected = true;
      clientCounter += 1;
      return `client-${clientCounter}`;
    },
    async execute(_clientKey, command) {
      if (!connected) throw new Error("SSH transport is not connected.");
      if (command.startsWith("uname -m")) return "x86_64\n";
      if (command.includes('if [ "$ACTUAL" != "$EXPECTED" ]')) {
        return "URL: https://203.0.113.10:5173\nCode: ABCDE\n";
      }
      throw new Error(`Unexpected command: ${command.slice(0, 32)}`);
    },
    async disconnect() {
      connected = false;
    },
  };
}

export const sshTransportSupported = Platform.OS === "ios" || Platform.OS === "android";
