import { describe, expect, it, vi } from "vitest";
import {
  BOX_INSTALL_MISSING_EXIT_CODE,
  BOX_PUBLIC_PROXY_ENV,
  buildBoxHostCommand,
  buildBoxHostingPreparationShell,
  buildBoxPublicConfigurationShell,
  normalizeBoxHostedUrl,
  parseBoxHostedUrl,
  probeBoxHostedUrl,
} from "./box-server-hosting.js";

const PUBLIC_URL = "https://quibt-owner-5173.on.ascii.dev";

describe("Box public hosting", () => {
  it("accepts only the Box HTTPS origin for Quibt's web port", () => {
    expect(normalizeBoxHostedUrl(`${PUBLIC_URL}/`)).toBe(PUBLIC_URL);
    expect(normalizeBoxHostedUrl("http://quibt-owner-5173.on.ascii.dev")).toBeNull();
    expect(normalizeBoxHostedUrl("https://quibt-owner-3100.on.ascii.dev")).toBeNull();
    expect(normalizeBoxHostedUrl("https://quibt-owner-5173.on.ascii.dev.evil.test")).toBeNull();
    expect(normalizeBoxHostedUrl(`${PUBLIC_URL}/claim`)).toBeNull();
    expect(normalizeBoxHostedUrl(`${PUBLIC_URL}?token=secret`)).toBeNull();
    expect(normalizeBoxHostedUrl("http://127.0.0.1:5173")).toBeNull();
  });

  it("extracts the hosted origin from human or JSON Box command output", () => {
    expect(parseBoxHostedUrl(`Hosted publicly at ${PUBLIC_URL}\n`)).toBe(PUBLIC_URL);
    expect(parseBoxHostedUrl(JSON.stringify({ url: `${PUBLIC_URL}/` }))).toBe(PUBLIC_URL);
    expect(parseBoxHostedUrl("URL: http://127.0.0.1:5173")).toBeNull();
  });

  it("builds recovery commands that distinguish an empty Box and persist the proxy origin", () => {
    const preparation = buildBoxHostingPreparationShell();
    expect(preparation).toContain(`exit ${BOX_INSTALL_MISSING_EXIT_CODE}`);
    expect(preparation).toContain('set_env "QUIBT_WEB_BIND_HOST" "0.0.0.0"');
    expect(preparation).toContain("up -d web");
    expect(buildBoxHostCommand()).toBe('host 5173 --title "Quibt Bot" --public');

    const configuration = buildBoxPublicConfigurationShell(PUBLIC_URL);
    expect(configuration).toContain(`set_env "${BOX_PUBLIC_PROXY_ENV}" "$origin"`);
    expect(configuration).toContain('remove_env "QUIBT_PUBLIC_HOST"');
    expect(configuration).toContain(`const publicUrl = "${PUBLIC_URL}";`);
    expect(configuration).toContain("/api/bootstrap/invites");
    expect(() => buildBoxPublicConfigurationShell("http://127.0.0.1:5173")).toThrow(
      "Invalid Box hosted URL",
    );
  });

  it("proves the public RPC before reporting success", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
          status: 200,
        }),
      );

    await expect(
      probeBoxHostedUrl(PUBLIC_URL, fetchImpl, { attempts: 2, delayMs: 0, timeoutMs: 100 }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`${PUBLIC_URL}/rpc/health`);
  });

  it("never probes loopback as a Box public URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(probeBoxHostedUrl("http://127.0.0.1:5173", fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
