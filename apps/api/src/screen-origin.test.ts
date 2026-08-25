import { describe, expect, it } from "vitest";
import { reachableFromClient, screenProxyOrigin } from "./screen-origin.js";

describe("screenProxyOrigin", () => {
  const fallback = "http://127.0.0.1:5173";

  it("serves the screen from the host the client reached, on the web port", () => {
    // O celular chegou à API pela LAN; o proxy da tela mora no web, na 5173.
    expect(
      screenProxyOrigin({
        requestUrl: "http://192.168.1.20:3100/rpc/computer/screenUrl",
        fallback,
      }),
    ).toBe("http://192.168.1.20:5173");
  });

  it("keeps the tailnet name so the screen also works away from home", () => {
    expect(screenProxyOrigin({ requestUrl: "https://mac.tail1234.ts.net/rpc/x", fallback })).toBe(
      "https://mac.tail1234.ts.net:5173",
    );
  });

  it("honours a reverse proxy in front of the stack", () => {
    expect(
      screenProxyOrigin({
        requestUrl: "http://api:3100/rpc/x",
        forwardedProto: "https",
        forwardedHost: "quibt.example.com",
        fallback,
      }),
    ).toBe("https://quibt.example.com");
  });

  it("falls back when the request carries nothing usable", () => {
    expect(screenProxyOrigin({ requestUrl: "not a url", fallback })).toBe(fallback);
    expect(screenProxyOrigin({ requestUrl: "ftp://x/y", fallback })).toBe(fallback);
  });
});

describe("hosts que o cliente não alcança", () => {
  const fallback = "http://127.0.0.1:5173";

  it("nunca assina a tela com um nome de serviço interno do Docker", () => {
    // Sem `x-forwarded-host`, o host que chega à API é o nome do serviço: assinar isso
    // devolvia `http://api:5173/novnc/…` para o navegador — tela preta garantida.
    expect(screenProxyOrigin({ requestUrl: "http://api:3100/rpc/x", fallback })).toBe(fallback);
    expect(screenProxyOrigin({ requestUrl: "http://web:3100/rpc/x", fallback })).toBe(fallback);
  });

  it("ignora um x-forwarded-host interno e volta ao fallback", () => {
    expect(
      screenProxyOrigin({ requestUrl: "http://api:3100/rpc/x", forwardedHost: "api", fallback }),
    ).toBe(fallback);
  });

  it("continua aceitando IP, localhost e nomes com ponto", () => {
    expect(reachableFromClient("192.168.1.20")).toBe(true);
    expect(reachableFromClient("localhost")).toBe(true);
    expect(reachableFromClient("mac.tail1234.ts.net")).toBe(true);
    expect(reachableFromClient("api")).toBe(false);
  });
});
