import type {
  SshInstallTransport,
  SshTransportConfig,
  SshTransportCredentials,
} from "./remote-installer.js";

export interface SshInstallTransportOptions extends SshTransportConfig {
  loadCredential?: () => Promise<SshTransportCredentials>;
}

export function createSshInstallTransport(
  _options: SshInstallTransportOptions,
): SshInstallTransport {
  const unsupported = () => {
    throw new Error("SSH remote install is only available on iOS and Android.");
  };
  return {
    inspectIdentity: unsupported,
    attachCredential: () => undefined,
    connect: unsupported,
    runInstall: unsupported,
    runUpdate: unsupported,
    close: async () => undefined,
  };
}

export const sshTransportSupported = false;
