import type { InstallerEvent } from "@quibt/installer";
import { describe, expect, it, vi } from "vitest";
import { BOX_TRIAL_SERVER_TTL_SECONDS, createServerBoxRequest } from "./box-api.js";
import { buildRemoteBootstrapShell, releaseManifestFixture } from "./release-artifacts.js";
import {
  detectSshHostKeyAlgorithm,
  fingerprintsMatch,
  inspectSshHost,
  installOnBox,
  installOverVerifiedSsh,
  isServerBoxRecord,
  isValidBoxId,
  normalizeSha256Fingerprint,
  type RemoteInstallerDeps,
  resolveSshTarget,
  type SshHostInput,
  type SshSessionLike,
} from "./remote-installer.js";

const SAMPLE_HEX = "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456";
const SAMPLE_KEY = Buffer.from([
  0,
  0,
  0,
  11,
  ...Buffer.from("ssh-ed25519"),
  0,
  0,
  0,
  4,
  1,
  2,
  3,
  4,
]);

const verified = releaseManifestFixture();

function fakeSshFactory(
  handlers: {
    onInspect?: (config: Record<string, unknown>) => void;
    onConnect?: (config: Record<string, unknown>) => SshSessionLike | Promise<SshSessionLike>;
  } = {},
): RemoteInstallerDeps["ssh"] {
  return {
    createClient() {
      return {
        connect(config) {
          return new Promise((resolve, reject) => {
            const hasAuth =
              typeof config.password === "string" ||
              typeof config.privateKey === "string" ||
              typeof config.passphrase === "string";
            const hostVerifier = config.hostVerifier as
              | ((value: string | Buffer) => boolean)
              | undefined;

            if (!hasAuth) {
              handlers.onInspect?.(config);
              if (typeof hostVerifier === "function") {
                hostVerifier(SAMPLE_KEY);
              }
              reject(new Error("host key rejected during inspect"));
              return;
            }

            if (!hostVerifier) {
              reject(new Error("hostVerifier is required"));
              return;
            }
            const allowed =
              typeof hostVerifier === "function" &&
              hostVerifier(SAMPLE_HEX) &&
              !hostVerifier("deadbeef");
            if (!allowed) {
              reject(new Error("host key mismatch"));
              return;
            }

            Promise.resolve(handlers.onConnect?.(config))
              .then((session) => {
                if (!session) {
                  reject(new Error("SSH session was not created"));
                  return;
                }
                resolve(session);
              })
              .catch(reject);
          });
        },
      };
    },
  };
}

const passwordInput: SshHostInput = {
  hostname: "vps.example",
  ip: "203.0.113.10",
  port: 22,
  username: "root",
  auth: { type: "password", password: "hunter2" },
};

describe("embedded release bootstrap integration", () => {
  it("uses explicit digest comparison in bootstrap scripts", () => {
    const script = buildRemoteBootstrapShell({
      baseUrl: verified.baseUrl,
      release: verified.release,
      digests: verified.digests,
    });
    expect(script).not.toContain("sha256sum -c");
    expect(script).toContain('if [ "$ACTUAL" != "$EXPECTED" ]');
    expect(script).toContain('" --version');
  });
});

describe("ssh target resolution and fingerprint", () => {
  it("resolves hostname once to an IP", async () => {
    const target = await resolveSshTarget("vps.example", 2222, async () => ({
      address: "203.0.113.10",
      family: 4,
    }));
    expect(target).toEqual({ hostname: "vps.example", ip: "203.0.113.10", port: 2222 });
  });

  it("detects host key algorithm from raw key material", () => {
    expect(detectSshHostKeyAlgorithm(SAMPLE_KEY)).toBe("ssh-ed25519");
  });

  it("does not pass credentials before fingerprint inspection", async () => {
    const ssh = fakeSshFactory({
      onInspect(config) {
        expect(config.host).toBe("203.0.113.10");
        expect(config.password).toBeUndefined();
        expect(config.privateKey).toBeUndefined();
      },
    });
    const identity = await inspectSshHost(
      { hostname: "vps.example", port: 22, username: "root" },
      { ssh, lookupHost: async () => ({ address: "203.0.113.10", family: 4 }) },
    );
    expect(identity.algorithm).toBe("ssh-ed25519");
    expect(identity.ip).toBe("203.0.113.10");
    expect(identity.fingerprint.startsWith("SHA256:")).toBe(true);
  });
});

describe("installOverVerifiedSsh", () => {
  it("aborts on fingerprint mismatch and keeps secrets out of events", async () => {
    const events: InstallerEvent[] = [];
    const result = await installOverVerifiedSsh(
      passwordInput,
      "SHA256:totally-different",
      (event) => events.push(event),
      { ssh: fakeSshFactory(), releaseManifest: verified },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify({ events, result })).not.toContain("hunter2");
  });

  it("returns pairing in a dedicated field and keeps token out of logs", async () => {
    const ssh = fakeSshFactory({
      onConnect: () => ({
        async exec(command) {
          if (command.startsWith("uname -m")) return { code: 0, stdout: "x86_64\n", stderr: "" };
          expect(command).toContain('if [ "$ACTUAL" != "$EXPECTED" ]');
          return {
            code: 0,
            stdout: `[health] succeeded: ready\nURL: https://203.0.113.10:5173\nCode: ABCDE\nToken: secret-token\nDeep link: quibt://connect?token=secret-token\n<svg></svg>\n`,
            stderr: "",
          };
        },
        end() {},
      }),
    });

    const result = await installOverVerifiedSsh(
      passwordInput,
      normalizeSha256Fingerprint(SAMPLE_HEX),
      () => {},
      { ssh, releaseManifest: verified },
    );
    expect(result.ok).toBe(true);
    expect(result.pairing?.code).toBe("ABCDE");
    expect(result.pairing?.token).toBe("secret-token");
    expect(result.pairing?.qrSvg).toBe("<svg></svg>");
    expect(result.log).not.toContain("secret-token");
    expect(result.log).not.toContain("ABCDE");
    expect(result.log).not.toContain("quibt://");
    expect(result.log).not.toContain("<svg");
  });
});

const BOX_ID = "bx_23456789";
const BOX_PUBLIC_URL = "https://quibt-owner-5173.on.ascii.dev";

function desktopBoxFetch(options: { empty?: boolean; trial?: boolean } = {}) {
  let processId = 0;
  let preparationCount = 0;
  let createAttempts = 0;
  const commands = new Map<number, string>();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, body });

    if (url.origin === BOX_PUBLIC_URL && method === "POST" && url.pathname === "/rpc/health") {
      return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
        status: 200,
      });
    }
    if (method === "GET" && url.pathname.endsWith("/boxes")) {
      return new Response(
        JSON.stringify({
          boxes: options.empty
            ? []
            : [{ id: BOX_ID, name: "Quibt Bot server", state: "ready", environment: null }],
        }),
        { status: 200 },
      );
    }
    if (method === "POST" && url.pathname.endsWith("/boxes")) {
      createAttempts += 1;
      if (options.trial && createAttempts === 1) {
        return new Response(
          JSON.stringify({
            code: "trial_auto_stop_required",
            message: "Trial boxes require an auto-stop TTL",
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ box: { id: BOX_ID, name: null, state: "ready", environment: null } }),
        { status: 200 },
      );
    }
    if (method === "PATCH" && url.pathname.endsWith(`/boxes/${BOX_ID}`)) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (method === "GET" && url.pathname.endsWith(`/boxes/${BOX_ID}`)) {
      return new Response(
        JSON.stringify({
          box: { id: BOX_ID, name: "Quibt Bot server", state: "ready", environment: null },
        }),
        { status: 200 },
      );
    }
    if (method === "POST" && url.pathname.endsWith(`/boxes/${BOX_ID}/commands`)) {
      expect(body).toMatchObject({ detached: true });
      processId += 1;
      commands.set(processId, String((body as { command?: unknown }).command ?? ""));
      return new Response(JSON.stringify({ success: true, processId }), { status: 200 });
    }
    const commandMatch = url.pathname.match(/\/commands\/(\d+)$/);
    if (method === "GET" && commandMatch?.[1]) {
      const command = commands.get(Number(commandMatch[1])) ?? "";
      if (command.includes("QUIBT_BOX_INSTALL_READY")) {
        preparationCount += 1;
        return new Response(
          JSON.stringify({
            running: false,
            exitCode: options.empty && preparationCount === 1 ? 42 : 0,
            stdout: options.empty && preparationCount === 1 ? "" : "QUIBT_BOX_INSTALL_READY\n",
            stderr: options.empty && preparationCount === 1 ? "QUIBT_BOX_INSTALL_MISSING\n" : "",
          }),
          { status: 200 },
        );
      }
      if (command.startsWith("host 5173")) {
        return new Response(
          JSON.stringify({
            running: false,
            exitCode: 0,
            stdout: `Hosted publicly at ${BOX_PUBLIC_URL}\n`,
            stderr: "",
          }),
          { status: 200 },
        );
      }
      if (command.includes("QUIBT_BOX_OWNER")) {
        return new Response(
          JSON.stringify({
            running: false,
            exitCode: 0,
            stdout: `URL: ${BOX_PUBLIC_URL}\nCode: BC09NEQ8\nToken: secret-token\nExpires: 2026-09-01T10:00:00.000Z\n`,
            stderr: "",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          running: false,
          exitCode: 0,
          stdout: "URL: http://127.0.0.1:5173\nCode: OLDINVIT\n",
          stderr: "",
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as typeof fetch, requests, commands };
}

describe("installOnBox", () => {
  it("recovers an existing Box through its public HTTPS host without re-downloading", async () => {
    const { fetchImpl, commands } = desktopBoxFetch();
    let allocatedBoxId: string | undefined;
    const result = await installOnBox({ apiKey: "box_live_secret_key" }, () => {}, {
      fetch: fetchImpl,
      releaseManifest: releaseManifestFixture({ pipelineStatus: "pending" }),
      onBoxAllocated: (boxId) => {
        allocatedBoxId = boxId;
      },
    });

    expect(result.ok).toBe(true);
    expect(result.boxId).toBe(BOX_ID);
    expect(allocatedBoxId).toBe(BOX_ID);
    expect(result.url).toBe(BOX_PUBLIC_URL);
    expect(result.pairing?.code).toBe("BC09NEQ8");
    expect([...commands.values()].some((command) => command.includes("curl -fsSL"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("box_live_secret_key");
    expect(isValidBoxId(BOX_ID)).toBe(true);
    expect(
      isServerBoxRecord({
        id: BOX_ID,
        name: "Quibt Bot server",
        state: "ready",
        environment: null,
      }),
    ).toBe(true);
  });

  it("creates and records a new server Box before waiting, then replaces loopback", async () => {
    const { fetchImpl, commands, requests } = desktopBoxFetch({ empty: true });
    let allocated = false;
    const result = await installOnBox({ apiKey: "box_key" }, () => {}, {
      fetch: fetchImpl,
      releaseManifest: verified,
      onBoxAllocated: () => {
        allocated = true;
      },
    });

    expect(result.ok).toBe(true);
    expect(result.url).toBe(BOX_PUBLIC_URL);
    expect(allocated).toBe(true);
    expect(
      requests.find((request) => request.method === "POST" && request.path.endsWith("/boxes"))
        ?.body,
    ).toEqual(createServerBoxRequest());
    expect([...commands.values()].some((command) => command.includes("curl -fsSL"))).toBe(true);
  });

  it("retries Box trial creation with a two-hour TTL and reports the fallback", async () => {
    const events: InstallerEvent[] = [];
    const { fetchImpl, requests } = desktopBoxFetch({ empty: true, trial: true });
    const result = await installOnBox({ apiKey: "box_key" }, (event) => events.push(event), {
      fetch: fetchImpl,
      releaseManifest: verified,
    });

    expect(result.ok).toBe(true);
    expect(
      requests
        .filter((request) => request.method === "POST" && request.path.endsWith("/boxes"))
        .map((request) => request.body),
    ).toEqual([createServerBoxRequest(), createServerBoxRequest(BOX_TRIAL_SERVER_TTL_SECONDS)]);
    expect(events.some((event) => event.message.includes("até 2 horas"))).toBe(true);
  });
});

describe("normalizeSha256Fingerprint", () => {
  it("normalizes hex fingerprints", () => {
    expect(fingerprintsMatch(SAMPLE_HEX, normalizeSha256Fingerprint(SAMPLE_HEX))).toBe(true);
  });
});
