import { describe, expect, it, vi } from "vitest";
import { createServerBoxRequest } from "./box-api.js";
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
});
