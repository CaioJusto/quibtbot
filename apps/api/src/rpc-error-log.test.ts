import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { logRpcError, rpcErrorLine } from "./router.js";

/**
 * Um erro em qualquer handler do /rpc não deixava rastro nenhum no servidor: o dono da
 * instalação via a tela quebrar e não tinha onde olhar. Agora deixa — e sem segredo.
 */
describe("rastro de erro do /rpc", () => {
  it("diz qual procedimento quebrou e de que tipo foi o erro", () => {
    const line = rpcErrorLine(["threads", "get"], new TypeError("bot.thread is undefined"));
    expect(line).toBe("[rpc] threads.get falhou: TypeError: bot.thread is undefined");
  });

  it("registra também o que não é Error", () => {
    expect(rpcErrorLine(["bots", "create"], "deu ruim")).toBe(
      "[rpc] bots.create falhou: string: deu ruim",
    );
  });

  it("cala a resposta esperada ao cliente e conta a falha do servidor", () => {
    expect(rpcErrorLine(["bots", "get"], new ORPCError("NOT_FOUND"))).toBeNull();
    expect(rpcErrorLine(["bots", "get"], new ORPCError("UNAUTHORIZED"))).toBeNull();
    expect(rpcErrorLine(["bots", "get"], new ORPCError("INTERNAL_SERVER_ERROR"))).toContain(
      "bots.get falhou",
    );
  });

  it("não deixa segredo, cabeçalho nem corpo entrarem na linha", () => {
    const secrets = [
      "fetch falhou: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrst.sig",
      "chave sk-or-v1-0123456789abcdef0123456789abcdef recusada",
      "COMPOSIO_API_KEY=ak_012345678901234567890123456789", // gitleaks:allow -- redaction fixture
      'body: {"password":"trocar-agora"}',
      "imagem data:image/png;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    ];
    for (const raw of secrets) {
      const line = rpcErrorLine(["computer", "preview"], new Error(raw))!;
      expect(line).toContain("computer.preview falhou");
      for (const leak of [
        "eyJhbGciOiJIUzI1NiJ9",
        "sk-or-v1-0123456789abcdef0123456789abcdef",
        "ak_012345678901234567890123456789",
        "trocar-agora",
        "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo",
      ]) {
        expect(line).not.toContain(leak);
      }
    }
  });

  it("corta a mensagem gigante em vez de despejar a resposta inteira no log", () => {
    const line = rpcErrorLine(["computer", "preview"], new Error("x".repeat(5_000)))!;
    expect(line.length).toBeLessThan(400);
  });

  it("escreve a linha só quando há o que contar", () => {
    const lines: string[] = [];
    logRpcError(["threads", "get"], new Error("quebrou"), (line) => lines.push(line));
    logRpcError(["threads", "get"], new ORPCError("NOT_FOUND"), (line) => lines.push(line));
    expect(lines).toEqual(["[rpc] threads.get falhou: Error: quebrou"]);
  });
});
