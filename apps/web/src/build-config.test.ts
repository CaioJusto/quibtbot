import { describe, expect, it } from "vitest";
import { previewAllowedHosts, screenProxySecretFor } from "./build-config.js";

describe("screenProxySecretFor", () => {
  it("allows a static build without runtime secrets", () => {
    expect(screenProxySecretFor("build", { NODE_ENV: "production" })).toMatch(/build/);
  });

  it("keeps production dev and preview servers fail-closed", () => {
    expect(() => screenProxySecretFor("serve", { NODE_ENV: "production" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});

describe("previewAllowedHosts", () => {
  it("libera o host público que o instalador gravou em WEB_ORIGIN", () => {
    expect(
      previewAllowedHosts({ WEB_ORIGIN: "https://quibt-348dc227.46.224.84.18.sslip.io" }),
    ).toEqual(["quibt-348dc227.46.224.84.18.sslip.io"]);
  });

  it("junta WEB_ORIGIN e BETTER_AUTH_URL sem repetir, e ignora lixo", () => {
    expect(
      previewAllowedHosts({
        WEB_ORIGIN: "https://app.example.com/",
        BETTER_AUTH_URL: "https://app.example.com",
        OUTRA: "ignorada",
      }),
    ).toEqual(["app.example.com"]);
    expect(previewAllowedHosts({ WEB_ORIGIN: "isso não é url" })).toEqual([]);
  });

  it("sem variáveis, não libera nada: o preview continua estrito fora do Docker", () => {
    expect(previewAllowedHosts({})).toEqual([]);
  });
});
