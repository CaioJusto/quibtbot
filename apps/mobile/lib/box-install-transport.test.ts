import type { InstallerEvent } from "@quibt/installer";
import { describe, expect, it, vi } from "vitest";
import { BOX_TRIAL_SERVER_TTL_SECONDS, createServerBoxRequest } from "./box-api.js";
import {
  createBoxInstallTransport,
  runBoxRemoteInstall,
  runBoxRemoteUpdate,
} from "./box-install-transport.js";
import { releaseManifestFixture } from "./release-artifacts.js";

const BOX_ID = "bx_23456789";
const PUBLIC_URL = "https://quibt-owner-5173.on.ascii.dev";

interface BoxFetchOptions {
  emptyInstall?: boolean;
  finalFailure?: boolean;
  listBoxes?: unknown[];
  createTrial?: boolean;
}

function createBoxFetch(options: BoxFetchOptions = {}) {
  let processId = 0;
  let preparationCount = 0;
  const commands = new Map<number, string>();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];

  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const request = {
      method: init?.method ?? "GET",
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
    };
    requests.push(request);

    if (url.origin === PUBLIC_URL && request.method === "POST" && url.pathname === "/rpc/health") {
      return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
        status: 200,
      });
    }

    if (request.method === "GET" && url.pathname.endsWith("/boxes")) {
      return new Response(
        JSON.stringify({
          boxes: options.listBoxes ?? [
            {
              id: BOX_ID,
              name: "Quibt Bot server",
              state: "ready",
              url: "https://box-console.on.ascii.dev",
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (request.method === "POST" && url.pathname.endsWith("/boxes")) {
      const body = request.body as { ttlSeconds?: number | null };
      if (options.createTrial && body.ttlSeconds === null) {
        return new Response(
          JSON.stringify({
            error: { code: "trial_auto_stop_required", message: "Trial requires auto-stop" },
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          box: {
            id: BOX_ID,
            name: null,
            state: "ready",
            url: "https://box-console.on.ascii.dev",
          },
        }),
        { status: 200 },
      );
    }

    if (request.method === "PATCH" && url.pathname.endsWith(`/boxes/${BOX_ID}`)) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    if (request.method === "GET" && url.pathname.endsWith(`/boxes/${BOX_ID}`)) {
      return new Response(
        JSON.stringify({
          box: {
            id: BOX_ID,
            name: "Quibt Bot server",
            state: "ready",
            url: "https://box-console.on.ascii.dev",
          },
        }),
        { status: 200 },
      );
    }

    if (request.method === "POST" && url.pathname.endsWith(`/boxes/${BOX_ID}/commands`)) {
      processId += 1;
      commands.set(processId, String((request.body as { command?: unknown }).command ?? ""));
      return new Response(JSON.stringify({ success: true, processId }), { status: 200 });
    }

    const commandMatch = url.pathname.match(/\/commands\/(\d+)$/);
    if (request.method === "GET" && commandMatch?.[1]) {
      const command = commands.get(Number(commandMatch[1])) ?? "";
      if (command.includes("QUIBT_BOX_INSTALL_READY")) {
        preparationCount += 1;
        if (options.emptyInstall && preparationCount === 1) {
          return new Response(
            JSON.stringify({
              running: false,
              exitCode: 42,
              stdout: "",
              stderr: "QUIBT_BOX_INSTALL_MISSING\n",
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            running: false,
            exitCode: 0,
            stdout: "QUIBT_BOX_INSTALL_READY\n",
            stderr: "",
          }),
          { status: 200 },
        );
      }
      if (command.startsWith("host 5173")) {
        return new Response(
          JSON.stringify({
            running: false,
            exitCode: 0,
            stdout: `Hosted publicly at ${PUBLIC_URL}\n`,
            stderr: "",
          }),
          { status: 200 },
        );
      }
      if (command.includes("QUIBT_BOX_OWNER")) {
        return new Response(
          JSON.stringify({
            running: false,
            exitCode: options.finalFailure ? 1 : 0,
            stdout: options.finalFailure
              ? ""
              : `URL: ${PUBLIC_URL}\nCode: BC09NEQ8\nToken: fresh-secret-token\nExpires: 2026-09-01T10:00:00.000Z\n`,
            stderr: options.finalFailure
              ? "Token: super-secret-token\nCode: BC09NEQ8\nconfiguration failed\n"
              : "",
          }),
          { status: 200 },
        );
      }
      if (command.includes("update --non-interactive")) {
        return new Response(
          JSON.stringify({
            running: false,
            exitCode: 0,
            stdout:
              '[database] succeeded: backup ready\n{\n  "release": "0.2.19",\n  "previousRelease": "0.2.16",\n  "backupPath": "/var/lib/quibt/backups/pre-update"\n}\n',
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

describe("createBoxInstallTransport", () => {
  it("recovers an existing install without resolving release artifacts", async () => {
    const loadApiKey = vi.fn(async () => "box_live_secret_key");
    const { fetchImpl, commands } = createBoxFetch();
    const transport = createBoxInstallTransport({
      loadApiKey,
      fetch: fetchImpl,
      // A pending manifest would throw if the existing-install path tried to resolve it.
      release: releaseManifestFixture({ pipelineStatus: "pending" }),
    });
    const close = vi.spyOn(transport, "close");

    const result = await runBoxRemoteInstall(transport, () => undefined);

    expect(result.ok).toBe(true);
    expect(result.url).toBe(PUBLIC_URL);
    expect(result.pairing?.code).toBe("BC09NEQ8");
    expect(result.pairing?.url).toBe(PUBLIC_URL);
    expect([...commands.values()].some((command) => command.startsWith("host 5173"))).toBe(true);
    expect([...commands.values()].some((command) => command.includes("curl -fsSL"))).toBe(false);
    expect(loadApiKey.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(close).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("box_live_secret_key");
    expect(createServerBoxRequest()).toEqual({ ttlSeconds: null, noEnv: true });
  });

  it("never returns the bootstrap loopback URL from a fresh Box", async () => {
    const { fetchImpl, commands } = createBoxFetch({ emptyInstall: true });
    const transport = createBoxInstallTransport({
      loadApiKey: async () => "box_live_valid",
      fetch: fetchImpl,
      release: releaseManifestFixture(),
    });

    const result = await runBoxRemoteInstall(transport, () => undefined);

    expect(result.ok).toBe(true);
    expect(result.url).toBe(PUBLIC_URL);
    expect(result.url).not.toContain("127.0.0.1");
    expect([...commands.values()].some((command) => command.includes("curl -fsSL"))).toBe(true);
  });

  it("does not put pairing secrets from the final configuration into errors", async () => {
    const { fetchImpl } = createBoxFetch({ finalFailure: true });
    const transport = createBoxInstallTransport({
      loadApiKey: async () => "box_live_secret_key",
      fetch: fetchImpl,
      release: releaseManifestFixture(),
    });

    const result = await runBoxRemoteInstall(transport, () => undefined);

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("super-secret-token");
    expect(result.error).not.toContain("BC09NEQ8");
    expect(result.log).not.toContain("super-secret-token");
  });

  it("retries with the two-hour maximum when a Box trial rejects no-auto-stop", async () => {
    const events: InstallerEvent[] = [];
    const { fetchImpl, requests } = createBoxFetch({ listBoxes: [], createTrial: true });
    const transport = createBoxInstallTransport({
      loadApiKey: async () => "box_live_valid",
      fetch: fetchImpl,
      release: releaseManifestFixture({ pipelineStatus: "pending" }),
    });

    const result = await runBoxRemoteInstall(transport, (event) => events.push(event));

    expect(result.ok).toBe(true);
    const createBodies = requests
      .filter((request) => request.method === "POST" && request.path.endsWith("/boxes"))
      .map((request) => request.body);
    expect(createBodies).toEqual([
      createServerBoxRequest(),
      createServerBoxRequest(BOX_TRIAL_SERVER_TTL_SECONDS),
    ]);
    expect(events.some((event) => event.message.includes("até 2 horas"))).toBe(true);
  });

  it("shows an actionable error when Box rejects the API key", async () => {
    const transport = createBoxInstallTransport({
      loadApiKey: async () => "revoked-key",
      fetch: (async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
        })) as typeof fetch,
      release: releaseManifestFixture(),
    });

    const result = await runBoxRemoteInstall(transport, () => undefined);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("chave da Box foi recusada");
    expect(result.error).toContain("box.ascii.dev");
    expect(result.error).not.toContain("revoked-key");
  });

  it("recovers the single recent trial Box instead of creating another machine", async () => {
    const now = Date.now();
    const onBoxAllocated = vi.fn(async () => undefined);
    const { fetchImpl, requests } = createBoxFetch({
      listBoxes: [
        {
          id: BOX_ID,
          name: "Box 2026-08-28 11:03",
          state: "ready",
          url: "https://box-console.on.ascii.dev",
          createdAt: new Date(now - 2 * 60_000).toISOString(),
          archiveAfter: new Date(now - 2 * 60_000 + 2 * 60 * 60_000).toISOString(),
        },
      ],
    });
    const transport = createBoxInstallTransport({
      loadApiKey: async () => "box_live_valid",
      fetch: fetchImpl,
      release: releaseManifestFixture({ pipelineStatus: "pending" }),
      onBoxAllocated,
    });

    const result = await runBoxRemoteInstall(transport, () => undefined);

    expect(result.ok).toBe(true);
    expect(onBoxAllocated).toHaveBeenCalledWith(BOX_ID);
    expect(
      requests.some((request) => request.method === "POST" && request.path.endsWith("/boxes")),
    ).toBe(false);
  });

  it("updates only the saved Box, preserves it, and restores public HTTPS", async () => {
    const { fetchImpl, requests, commands } = createBoxFetch();
    const transport = createBoxInstallTransport({
      boxId: BOX_ID,
      loadApiKey: async () => "box_live_valid",
      fetch: fetchImpl,
      release: releaseManifestFixture(),
    });

    const result = await runBoxRemoteUpdate(transport, () => undefined);

    expect(result).toMatchObject({
      ok: true,
      release: "0.2.19",
      previousRelease: "0.2.16",
      backupPath: "/var/lib/quibt/backups/pre-update",
    });
    expect(
      requests.some((request) => request.method === "POST" && request.path.endsWith("/boxes")),
    ).toBe(false);
    expect(
      [...commands.values()].some((command) => command.includes("update --non-interactive")),
    ).toBe(true);
    expect([...commands.values()].some((command) => command.startsWith("host 5173"))).toBe(true);
  });

  it("never creates a new Box when update has no saved server id", async () => {
    const { fetchImpl, requests } = createBoxFetch({ listBoxes: [] });
    const transport = createBoxInstallTransport({
      loadApiKey: async () => "box_live_valid",
      fetch: fetchImpl,
      release: releaseManifestFixture(),
    });

    const result = await runBoxRemoteUpdate(transport, () => undefined);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("máquina Box salva");
    expect(requests).toHaveLength(0);
  });
});
