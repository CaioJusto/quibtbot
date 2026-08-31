import { BOX_PUBLIC_PROXY_ENV } from "@quibt/core";
import { describe, expect, it } from "vitest";
import { reachableUrl } from "./orchestrator.js";
import { apiBaseUrl, apiReadyUrl } from "./orchestrator-helpers.js";

describe("apiBaseUrl / apiReadyUrl numa instalação pública", () => {
  it("o instalador sonda o loopback mesmo com API_URL apontando para o https público", () => {
    const env = {
      QUIBT_PUBLIC_HOST: "quibt-348dc227.46.224.84.18.sslip.io",
      API_URL: "https://quibt-348dc227.46.224.84.18.sslip.io",
    };
    // O Caddy (que serve o https) só sobe depois da migração; a sondagem de saúde
    // acontece antes. Apontar para o https aqui derrubava toda instalação pública.
    expect(apiBaseUrl(env, "http://127.0.0.1:5173")).toBe("http://127.0.0.1:3100");
    expect(apiReadyUrl(env, "http://127.0.0.1:5173")).toBe("http://127.0.0.1:3100/ready");
  });

  it("sem host público, API_URL continua mandando (compatível com o que já existia)", () => {
    expect(apiBaseUrl({ API_URL: "http://10.0.0.5:3100/" }, "http://127.0.0.1:5173")).toBe(
      "http://10.0.0.5:3100",
    );
    expect(apiReadyUrl({}, "http://127.0.0.1:5173")).toBe("http://127.0.0.1:3100/ready");
  });

  it("usa loopback internamente e a origem HTTPS externamente numa Box hospedada", () => {
    const publicUrl = "https://quibt-owner-5173.on.ascii.dev";
    const env = {
      [BOX_PUBLIC_PROXY_ENV]: publicUrl,
      API_URL: publicUrl,
    };

    expect(apiBaseUrl(env, "http://127.0.0.1:5173")).toBe("http://127.0.0.1:3100");
    expect(apiReadyUrl(env, "http://127.0.0.1:5173")).toBe("http://127.0.0.1:3100/ready");
    expect(reachableUrl(env, "http://127.0.0.1:5173")).toBe(publicUrl);
  });

  it("não aceita loopback ou domínio parecido como marcador público da Box", () => {
    expect(
      reachableUrl({ [BOX_PUBLIC_PROXY_ENV]: "http://127.0.0.1:5173" }, "http://127.0.0.1:5173"),
    ).toBe("http://127.0.0.1:5173");
    expect(
      reachableUrl(
        { [BOX_PUBLIC_PROXY_ENV]: "https://quibt-5173.on.ascii.dev.evil.test" },
        "http://127.0.0.1:5173",
      ),
    ).toBe("http://127.0.0.1:5173");
  });
});
