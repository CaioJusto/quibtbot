import type { InstallerEvent } from "@quibt/installer";
import { describe, expect, it, vi } from "vitest";
import { createServerBoxRequest } from "./box-api.js";
import {
  buildRemoteUpdateShell,
  INSTALL_RELEASE,
  LINUX_ARTIFACTS,
  releaseManifestFixture,
  resolveEmbeddedReleaseArtifacts,
} from "./release-artifacts.js";
import {
  collectTransportSecrets,
  createMockSshTransport,
  fingerprintsMatch,
  type InstallResult,
  normalizeSha256Fingerprint,
  parseInstallerOutput,
  parseRemoteUpdateOutput,
  type RemoteInstallTransport,
  runVerifiedRemoteInstall,
  runVerifiedRemoteUpdate,
  type SshTransportCredentials,
  sanitizeInstallerEvent,
} from "./remote-installer.js";

const SAMPLE_HEX = "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456";
const SAMPLE_FINGERPRINT = normalizeSha256Fingerprint(SAMPLE_HEX);

const passwordCreds: SshTransportCredentials = {
  type: "password",
  password: "hunter2",
};

function mockTransport(
  handlers: Partial<{
    inspectIdentity: RemoteInstallTransport["inspectIdentity"];
    connect: RemoteInstallTransport["connect"];
    runInstall: RemoteInstallTransport["runInstall"];
    close: RemoteInstallTransport["close"];
  }> = {},
): RemoteInstallTransport {
  return {
    inspectIdentity:
      handlers.inspectIdentity ??
      (async () => ({ algorithm: "ssh-ed25519", fingerprint: SAMPLE_FINGERPRINT })),
    connect: handlers.connect ?? (async () => undefined),
    runInstall:
      handlers.runInstall ??
      (async () => ({
        ok: true,
        url: "https://203.0.113.10:5173",
        pairing: { url: "https://203.0.113.10:5173", code: "ABCDE" },
      })),
    close: handlers.close ?? (async () => undefined),
  };
}

describe("normalizeSha256Fingerprint", () => {
  it("normalizes hex fingerprints", () => {
    expect(fingerprintsMatch(SAMPLE_HEX, normalizeSha256Fingerprint(SAMPLE_HEX))).toBe(true);
  });
});

describe("sanitizeInstallerEvent", () => {
  it("removes known secrets from installer events", () => {
    const secrets = collectTransportSecrets(passwordCreds);
    const event = sanitizeInstallerEvent(
      { step: "requirements", status: "failed", message: "auth failed for hunter2" },
      secrets,
    );
    expect(event.message).not.toContain("hunter2");
    expect(event.message).toContain("[REDACTED]");
  });
});

describe("parseInstallerOutput", () => {
  it("extracts url and code into pairing while omitting pairing lines from log", () => {
    const secrets = collectTransportSecrets(passwordCreds);
    const parsed = parseInstallerOutput(
      `[health] succeeded: ready\nURL: https://203.0.113.10:5173\nCode: ABCDE\nToken: secret-token\nDeep link: quibt://connect?token=secret-token\nExpires: 2026-08-17T12:00:00Z\n<svg></svg>\n`,
      secrets,
    );
    expect(parsed.pairing?.url).toBe("https://203.0.113.10:5173");
    expect(parsed.pairing?.code).toBe("ABCDE");
    expect(parsed.pairing?.token).toBe("secret-token");
    expect(parsed.pairing?.deepLink).toBe("quibt://connect?token=secret-token");
    expect(parsed.pairing?.expiresAt).toBe("2026-08-17T12:00:00Z");
    expect(parsed.pairing?.qrSvg).toBe("<svg></svg>");
    expect(parsed.log).not.toContain("https://203.0.113.10:5173");
    expect(parsed.log).not.toContain("ABCDE");
    expect(parsed.log).not.toMatch(/^URL:/m);
    expect(parsed.log).not.toMatch(/^Code:/m);
    expect(parsed.log).not.toContain("secret-token");
    expect(parsed.log).not.toContain("quibt://");
    expect(parsed.log).not.toContain("Expires:");
    expect(parsed.log).not.toContain("<svg");
    expect(parsed.log).toContain("[health] succeeded: ready");
  });
});

describe("remote server update", () => {
  it("downloads the verified release binary and invokes update without pairing output", () => {
    const command = buildRemoteUpdateShell(resolveEmbeddedReleaseArtifacts());
    expect(command).toContain('if [ "$ACTUAL" != "$EXPECTED" ]');
    expect(command).toContain('"$tmpdir/quibtbot" update --non-interactive');
    expect(command).not.toContain("--show-sensitive");
  });

  it("extracts the release and backup while redacting the credential", () => {
    const parsed = parseRemoteUpdateOutput(
      '[database] succeeded: backup hunter2\n{\n  "release": "0.2.14",\n  "previousRelease": "0.2.8",\n  "backupPath": "/var/lib/quibt/backups/ok"\n}\n',
      ["hunter2"],
    );
    expect(parsed).toMatchObject({
      ok: true,
      release: "0.2.14",
      previousRelease: "0.2.8",
      backupPath: "/var/lib/quibt/backups/ok",
    });
    expect(parsed.log).not.toContain("hunter2");
  });

  it("uses the stored credential only after fingerprint verification", async () => {
    const loadCredential = vi.fn(async () => passwordCreds);
    const transport = createMockSshTransport({
      release: releaseManifestFixture(),
      installOutput:
        '[health] succeeded: API ready\n{\n  "release": "0.2.14",\n  "previousRelease": "0.2.8",\n  "backupPath": "/var/lib/quibt/backups/ok"\n}\n',
    });
    const identity = await transport.inspectIdentity();
    transport.attachCredential(loadCredential);

    const result = await runVerifiedRemoteUpdate(transport, {
      expectedFingerprint: identity.fingerprint,
      onEvent: () => undefined,
    });

    expect(loadCredential).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, release: "0.2.14", previousRelease: "0.2.8" });
  });
});

describe("runVerifiedRemoteInstall", () => {
  it("does not connect when expected fingerprint is missing", async () => {
    const connect = vi.fn(async () => undefined);
    const transport = mockTransport({ connect });

    const result = await runVerifiedRemoteInstall(transport, {
      expectedFingerprint: "",
      onEvent: () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it("closes transport on fingerprint mismatch and keeps secrets out of events", async () => {
    const events: InstallerEvent[] = [];
    const close = vi.fn(async () => undefined);
    const transport = mockTransport({
      connect: async () => {
        throw new Error("SSH host fingerprint mismatch");
      },
      close,
    });

    const result = await runVerifiedRemoteInstall(transport, {
      expectedFingerprint: "SHA256:totally-different",
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(JSON.stringify({ events, result })).not.toContain("hunter2");
  });

  it("returns pairing from typed installer output on success", async () => {
    const transport = mockTransport({
      runInstall: async (onEvent) => {
        onEvent({ step: "health", status: "succeeded", message: "ready" });
        return {
          ok: true,
          url: "https://203.0.113.10:5173",
          pairing: { url: "https://203.0.113.10:5173", code: "ABCDE" },
        } satisfies InstallResult;
      },
    });

    const result = await runVerifiedRemoteInstall(transport, {
      expectedFingerprint: SAMPLE_FINGERPRINT,
      onEvent: () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.pairing?.code).toBe("ABCDE");
    expect(result.url).toBe("https://203.0.113.10:5173");
  });
});

describe("createMockSshTransport", () => {
  it("inspects host identity without credentials attached", async () => {
    const transport = createMockSshTransport({
      release: releaseManifestFixture(),
    });

    const identity = await transport.inspectIdentity();
    expect(identity.fingerprint.startsWith("SHA256:")).toBe(true);

    await expect(transport.connect(identity.fingerprint)).rejects.toThrow(
      /credentials are required/i,
    );
  });

  it("loads credentials only after attachCredential and confirmed fingerprint", async () => {
    const loadCredential = vi.fn(async () => passwordCreds);
    const transport = createMockSshTransport({
      release: releaseManifestFixture(),
      installOutput:
        "URL: https://203.0.113.10:5173\nCode: ABCDE\nToken: secret-token\nDeep link: quibt://connect?token=secret-token\n",
    });

    const identity = await transport.inspectIdentity();
    expect(loadCredential).not.toHaveBeenCalled();

    transport.attachCredential(loadCredential);

    const result = await runVerifiedRemoteInstall(transport, {
      expectedFingerprint: identity.fingerprint,
      onEvent: () => undefined,
    });

    expect(loadCredential).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.pairing?.code).toBe("ABCDE");
  });
});

describe("INSTALL_RELEASE do celular", () => {
  it("é o mesmo número do installer, sem importar o pacote Node no app", async () => {
    const { INSTALL_RELEASE: installer } = await import("@quibt/installer");
    expect(INSTALL_RELEASE).toBe(installer);
  });
});

describe("resolveEmbeddedReleaseArtifacts", () => {
  it("ships a manifest the phone can really install from", () => {
    // Este era o teste que guardava o defeito: o manifesto embutido vinha com digests
    // zerados e "pending", então a instalação por SSH morria depois de já ter conectado
    // no servidor. Agora ele vem do pipeline de release, como o do computador.
    const release = resolveEmbeddedReleaseArtifacts();
    expect(release.release).toBe(INSTALL_RELEASE);
    for (const artifact of LINUX_ARTIFACTS) {
      expect(release.digests[artifact]).toMatch(/^[a-f0-9]{64}$/i);
    }
  });

  it("still fails closed when a manifest arrives pending or com digest zerado", () => {
    expect(() =>
      resolveEmbeddedReleaseArtifacts(releaseManifestFixture({ pipelineStatus: "pending" })),
    ).toThrow(/not ready for remote install/i);
    expect(() =>
      resolveEmbeddedReleaseArtifacts(
        releaseManifestFixture({
          digests: {
            "quibtbot-linux-x64": "0".repeat(64),
            "quibtbot-linux-arm64": "2".repeat(64),
          },
        }),
      ),
    ).toThrow(/is not populated/i);
  });

  it("accepts ready fixture digests for tests", () => {
    const release = resolveEmbeddedReleaseArtifacts(releaseManifestFixture());
    expect(release.digests["quibtbot-linux-x64"]).not.toMatch(/^0+$/);
  });
});

describe("box server contract", () => {
  it("creates persistent no-env server boxes", () => {
    expect(createServerBoxRequest()).toEqual({ ttlSeconds: null, noEnv: true });
  });
});
