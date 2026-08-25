import type { InstallerEvent } from "@quibt/installer";
import { describe, expect, it, vi } from "vitest";
import { createServerBoxRequest } from "./box-api.js";
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

describe("installOnBox", () => {
  it("uses detached command polling and validates server box metadata", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    let polls = 0;
    let allocatedBoxId: string | undefined;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method ?? "GET", path: url.pathname, body });
      if (init?.method === "GET" && url.pathname === "/api/box/v1/boxes") {
        return new Response(
          JSON.stringify({
            ok: true,
            boxes: [
              {
                id: "bx_23456789",
                name: "Quibt Bot server",
                state: "ready",
                url: "https://quibt.on.ascii.dev",
                environment: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (init?.method === "GET" && url.pathname === "/api/box/v1/boxes/bx_23456789") {
        return new Response(
          JSON.stringify({
            ok: true,
            box: {
              id: "bx_23456789",
              name: "Quibt Bot server",
              state: "ready",
              url: "https://quibt.on.ascii.dev",
              environment: null,
            },
          }),
          { status: 200 },
        );
      }
      if (init?.method === "POST" && url.pathname === "/api/box/v1/boxes/bx_23456789/commands") {
        expect(body).toMatchObject({ detached: true });
        return new Response(JSON.stringify({ success: true, processId: 42 }), { status: 200 });
      }
      if (init?.method === "POST" && url.pathname === "/api/box/v1/boxes/bx_23456789/interrupt") {
        expect(body).toBeUndefined();
        return new Response(
          JSON.stringify({ ok: true, type: "box.interrupted", id: "bx_23456789" }),
          {
            status: 200,
          },
        );
      }
      if (init?.method === "GET" && url.pathname === "/api/box/v1/boxes/bx_23456789/commands/42") {
        polls += 1;
        return new Response(
          JSON.stringify({
            success: true,
            running: polls < 2,
            exitCode: polls < 2 ? null : 0,
            stdout:
              polls < 2
                ? "[images] running: bootstrap\n"
                : "URL: https://quibt.on.ascii.dev\nCode: ZYXWV\n",
            stderr: "",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    let allocatedAt: string | undefined;
    const result = await installOnBox({ apiKey: "box_live_secret_key" }, () => {}, {
      fetch: fetchImpl,
      releaseManifest: verified,
      onBoxAllocated: (boxId) => {
        allocatedBoxId = boxId;
        allocatedAt = "allocated";
      },
    });
    expect(result.ok).toBe(true);
    expect(result.boxId).toBe("bx_23456789");
    expect(allocatedBoxId).toBe("bx_23456789");
    expect(allocatedAt).toBe("allocated");
    expect(result.pairing?.code).toBe("ZYXWV");
    expect(JSON.stringify(result)).not.toContain("box_live_secret_key");
    expect(isValidBoxId("bx_23456789")).toBe(true);
    expect(
      isServerBoxRecord({
        id: "bx_23456789",
        name: "Quibt Bot server",
        state: "ready",
        environment: null,
      }),
    ).toBe(true);
  });

  it("creates server boxes with noEnv only and allocates before waiting", async () => {
    let allocated = false;
    let waited = false;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (init?.method === "GET" && url.pathname === "/api/box/v1/boxes") {
        return new Response(JSON.stringify({ ok: true, boxes: [] }), { status: 200 });
      }
      if (init?.method === "POST" && url.pathname === "/api/box/v1/boxes") {
        expect(body).toEqual(createServerBoxRequest());
        return new Response(
          JSON.stringify({
            ok: true,
            box: {
              id: "bx_23456789",
              name: "Quibt Bot server",
              state: "provisioning",
              environment: null,
            },
          }),
          { status: 200 },
        );
      }
      if (init?.method === "PATCH" && url.pathname === "/api/box/v1/boxes/bx_23456789") {
        return new Response(
          JSON.stringify({ ok: true, box: { id: "bx_23456789", environment: null } }),
          {
            status: 200,
          },
        );
      }
      if (init?.method === "GET" && url.pathname === "/api/box/v1/boxes/bx_23456789") {
        waited = true;
        expect(allocated).toBe(true);
        return new Response(
          JSON.stringify({
            ok: true,
            box: {
              id: "bx_23456789",
              name: "Quibt Bot server",
              state: "ready",
              url: "https://quibt.on.ascii.dev",
              environment: null,
            },
          }),
          { status: 200 },
        );
      }
      if (init?.method === "POST" && url.pathname === "/api/box/v1/boxes/bx_23456789/commands") {
        return new Response(JSON.stringify({ success: true, processId: 7 }), { status: 200 });
      }
      if (init?.method === "GET" && url.pathname === "/api/box/v1/boxes/bx_23456789/commands/7") {
        return new Response(
          JSON.stringify({
            success: true,
            running: false,
            exitCode: 0,
            stdout: "URL: https://x\nCode: ABCDE\n",
            stderr: "",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    await installOnBox({ apiKey: "box_key" }, () => {}, {
      fetch: fetchImpl,
      releaseManifest: verified,
      onBoxAllocated: () => {
        allocated = true;
      },
    });
    expect(allocated).toBe(true);
    expect(waited).toBe(true);
  });
});

describe("normalizeSha256Fingerprint", () => {
  it("normalizes hex fingerprints", () => {
    expect(fingerprintsMatch(SAMPLE_HEX, normalizeSha256Fingerprint(SAMPLE_HEX))).toBe(true);
  });
});
