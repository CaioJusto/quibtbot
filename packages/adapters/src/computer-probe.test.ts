import { describe, expect, it } from "vitest";
import { probeComputer } from "./computer-probe.js";

describe("probeComputer", () => {
  it("refuses unknown kinds and missing remote URL", async () => {
    expect(await probeComputer({ kind: "desktop" })).toEqual({
      ok: false,
      message: "Máquina desconhecida: desktop",
    });
    expect(await probeComputer({ kind: "remote-supervisor" })).toMatchObject({ ok: false });
  });

  it("accepts cloud keys without calling the vendor", async () => {
    expect(await probeComputer({ kind: "e2b", apiKey: "e2b_live" })).toMatchObject({ ok: true });
    expect(await probeComputer({ kind: "box" })).toMatchObject({ ok: false });
  });

  it("hits the supervisor health endpoint", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const result = await probeComputer(
      { kind: "docker", supervisorUrl: "http://127.0.0.1:7091" },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["http://127.0.0.1:7091/health"]);
  });
});
