import type { InstallerEvent } from "@quibt/installer";
import { describe, expect, it, vi } from "vitest";
import { BOX_TRIAL_SERVER_TTL_SECONDS, createServerBoxRequest } from "./box-api.js";
import { createBoxInstallTransport, runBoxRemoteInstall } from "./box-install-transport.js";
import { releaseManifestFixture } from "./release-artifacts.js";

describe("createBoxInstallTransport", () => {
  it("loads the API key from SecureStore on every Box API request", async () => {
    const loadApiKey = vi.fn(async () => "box_live_secret_key");
    let polls = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
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
            },
          }),
          { status: 200 },
        );
      }
      if (init?.method === "POST" && url.pathname === "/api/box/v1/boxes/bx_23456789/commands") {
        return new Response(JSON.stringify({ success: true, processId: 42 }), { status: 200 });
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

    const transport = createBoxInstallTransport({
      loadApiKey,
      fetch: fetchImpl as typeof fetch,
      release: releaseManifestFixture(),
    });
    const close = vi.spyOn(transport, "close");

    const result = await runBoxRemoteInstall(transport, () => undefined);

    expect(result.ok).toBe(true);
    expect(loadApiKey.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(close).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("box_live_secret_key");
    expect(createServerBoxRequest()).toEqual({ ttlSeconds: null, noEnv: true });
  });

  it("does not put pairing secrets from stderr into the error field", async () => {
    const loadApiKey = vi.fn(async () => "box_live_secret_key");
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
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
        return new Response(JSON.stringify({ success: true, processId: 7 }), { status: 200 });
      }
      if (init?.method === "GET" && url.pathname === "/api/box/v1/boxes/bx_23456789/commands/7") {
        return new Response(
          JSON.stringify({
            success: true,
            running: false,
            exitCode: 1,
            stdout: "",
            stderr: "Token: super-secret-token\nCode: ABCDE\nbootstrap failed\n",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const transport = createBoxInstallTransport({
      loadApiKey,
      fetch: fetchImpl as typeof fetch,
      release: releaseManifestFixture(),
    });
    const result = await runBoxRemoteInstall(transport, () => undefined);

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("super-secret-token");
    expect(result.error).not.toContain("ABCDE");
    expect(result.log).not.toContain("super-secret-token");
  });

  it("retries with the two-hour maximum when a Box trial rejects no-auto-stop", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const events: InstallerEvent[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const request = {
        method: init?.method ?? "GET",
        path: url.pathname,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      };
      requests.push(request);

      if (request.method === "GET" && url.pathname.endsWith("/boxes")) {
        return new Response(JSON.stringify({ boxes: [] }), { status: 200 });
      }
      if (request.method === "POST" && url.pathname.endsWith("/boxes")) {
        if ((request.body as { ttlSeconds?: number | null }).ttlSeconds === null) {
          return new Response(
            JSON.stringify({
              error: {
                code: "trial_auto_stop_required",
                message: "Trial boxes require auto-stop",
              },
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({
            box: {
              id: "bx_23456789",
              name: null,
              state: "ready",
              url: "https://quibt.on.ascii.dev",
            },
          }),
          { status: 200 },
        );
      }
      if (request.method === "PATCH" && url.pathname.endsWith("/boxes/bx_23456789")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (request.method === "GET" && url.pathname.endsWith("/boxes/bx_23456789")) {
        return new Response(
          JSON.stringify({
            box: {
              id: "bx_23456789",
              name: "Quibt Bot server",
              state: "ready",
              url: "https://quibt.on.ascii.dev",
            },
          }),
          { status: 200 },
        );
      }
      if (request.method === "POST" && url.pathname.endsWith("/commands")) {
        return new Response(JSON.stringify({ success: true, processId: 11 }), { status: 200 });
      }
      if (request.method === "GET" && url.pathname.endsWith("/commands/11")) {
        return new Response(
          JSON.stringify({
            running: false,
            exitCode: 0,
            stdout: "URL: https://quibt.on.ascii.dev\nCode: ZYXWV\n",
            stderr: "",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const transport = createBoxInstallTransport({
      loadApiKey: async () => "box_live_valid",
      fetch: fetchImpl as typeof fetch,
      release: releaseManifestFixture(),
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

  it("recovers the single recent two-hour Box instead of creating another machine", async () => {
    const now = Date.now();
    const requests: Array<{ method: string; path: string }> = [];
    const onBoxAllocated = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const request = { method: init?.method ?? "GET", path: url.pathname };
      requests.push(request);

      if (request.method === "GET" && url.pathname.endsWith("/boxes")) {
        return new Response(
          JSON.stringify({
            boxes: [
              {
                id: "bx_23456789",
                name: "Box 2026-08-28 11:03",
                state: "ready",
                url: "https://quibt.on.ascii.dev",
                createdAt: new Date(now - 2 * 60_000).toISOString(),
                archiveAfter: new Date(now - 2 * 60_000 + 2 * 60 * 60_000).toISOString(),
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (request.method === "PATCH" && url.pathname.endsWith("/boxes/bx_23456789")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (request.method === "GET" && url.pathname.endsWith("/boxes/bx_23456789")) {
        return new Response(
          JSON.stringify({
            box: {
              id: "bx_23456789",
              name: "Box 2026-08-28 11:03",
              state: "ready",
              url: "https://quibt.on.ascii.dev",
            },
          }),
          { status: 200 },
        );
      }
      if (request.method === "POST" && url.pathname.endsWith("/commands")) {
        return new Response(JSON.stringify({ processId: 12 }), { status: 200 });
      }
      if (request.method === "GET" && url.pathname.endsWith("/commands/12")) {
        return new Response(
          JSON.stringify({
            running: false,
            exitCode: 0,
            stdout: "URL: https://quibt.on.ascii.dev\nCode: ZYXWV\n",
            stderr: "",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const transport = createBoxInstallTransport({
      loadApiKey: async () => "box_live_valid",
      fetch: fetchImpl as typeof fetch,
      release: releaseManifestFixture(),
      onBoxAllocated,
    });
    const result = await runBoxRemoteInstall(transport, () => undefined);

    expect(result.ok).toBe(true);
    expect(onBoxAllocated).toHaveBeenCalledWith("bx_23456789");
    expect(
      requests.some((request) => request.method === "POST" && request.path.endsWith("/boxes")),
    ).toBe(false);
  });
});
