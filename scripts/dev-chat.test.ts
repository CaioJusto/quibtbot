import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  commandFor,
  createRpc,
  helpText,
  isLoopbackBase,
  login,
  normalizeBase,
  parseArgs,
  pickBot,
  renderMessage,
  runIsOver,
} from "./dev-chat.mjs";

/**
 * O chat de terminal é ferramenta de DEV e não pode afrouxar a guarda de
 * `POST /api/local/session` (ver .agent-reports/fix-01-sec-session.md): sem loopback e
 * sem token, ele para e pede a credencial.
 */

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("dev:chat — argumentos e ajuda", () => {
  it("a ajuda diz que é ferramenta de desenvolvimento", () => {
    const help = helpText();
    expect(help).toContain("FERRAMENTA DE DEV");
    expect(help).toContain("NÃO é o produto");
    expect(help).toContain("QUIBT_TOKEN");
  });

  it("sem argumentos usa a API local padrão", () => {
    expect(parseArgs([], {})).toEqual({ help: false, bot: null, base: "http://127.0.0.1:3100" });
  });

  it("aceita o nome do bot, --url e API_URL", () => {
    expect(parseArgs(["ana"], {}).bot).toBe("ana");
    expect(parseArgs(["--url", "http://127.0.0.1:9999"], {}).base).toBe("http://127.0.0.1:9999");
    expect(parseArgs([], { API_URL: "http://127.0.0.1:4000" }).base).toBe("http://127.0.0.1:4000");
  });

  it("recusa opção desconhecida e --url vazio", () => {
    expect(parseArgs(["--nope"], {}).error).toContain("opção desconhecida");
    expect(parseArgs(["--url"], {}).error).toContain("--url");
  });

  it("tira a barra final da base", () => {
    expect(normalizeBase("http://127.0.0.1:3100/")).toBe("http://127.0.0.1:3100");
  });
});

describe("dev:chat — só entra sozinho no loopback", () => {
  it("reconhece 127.0.0.0/8, localhost e ::1", () => {
    expect(isLoopbackBase("http://127.0.0.1:3100")).toBe(true);
    expect(isLoopbackBase("http://127.0.0.5:3100")).toBe(true);
    expect(isLoopbackBase("http://localhost:3100")).toBe(true);
    expect(isLoopbackBase("http://[::1]:3100")).toBe(true);
  });

  it("recusa LAN, bridge do docker e endereço público", () => {
    expect(isLoopbackBase("http://192.168.1.10:3100")).toBe(false);
    expect(isLoopbackBase("http://172.17.0.1:3100")).toBe(false);
    expect(isLoopbackBase("https://quibt.example.com")).toBe(false);
    expect(isLoopbackBase("http://127.0.0.1.evil.com")).toBe(false);
  });

  it("fora do loopback nem chega a pedir sessão: pede o token", async () => {
    let called = false;
    await expect(
      login({
        base: "https://quibt.example.com",
        token: "",
        fetch: async () => {
          called = true;
          return jsonResponse({ ok: true, token: "nao-devia" });
        },
      }),
    ).rejects.toThrow(/QUIBT_TOKEN/);
    expect(called).toBe(false);
  });

  it("um 404 do servidor é aceito como resposta, não contornado", async () => {
    const seen = [];
    await expect(
      login({
        base: "http://127.0.0.1:3100",
        token: "",
        fetch: async (_url, options) => {
          seen.push(options ?? {});
          return jsonResponse({ error: "Not found" }, 404);
        },
      }),
    ).rejects.toThrow(/QUIBT_TOKEN/);
    // Nada de x-forwarded-*, nada de capacidade de desktop, nada de prova de proxy:
    // o pedido leva só o método.
    expect(seen).toEqual([{ method: "POST" }]);
  });

  it("usa o token do ambiente sem tocar em /api/local/session", async () => {
    const session = await login({
      base: "https://quibt.example.com",
      token: "tok-123",
      fetch: async () => {
        throw new Error("não devia chamar a API");
      },
    });
    expect(session.token).toBe("tok-123");
  });

  it("entrega o token quando o loopback abre a sessão", async () => {
    const urls = [];
    const session = await login({
      base: "http://127.0.0.1:3100/",
      token: "",
      fetch: async (url, options) => {
        urls.push(`${options?.method} ${url}`);
        return jsonResponse({ ok: true, token: "tok-local", name: "Caio" });
      },
    });
    expect(urls).toEqual(["POST http://127.0.0.1:3100/api/local/session"]);
    expect(session).toMatchObject({ token: "tok-local", name: "Caio" });
  });

  it("sessão por cookie sem token vira instrução, não travamento", async () => {
    await expect(
      login({
        base: "http://127.0.0.1:3100",
        token: "",
        fetch: async () => jsonResponse({ ok: true, name: "Caio" }),
      }),
    ).rejects.toThrow(/QUIBT_TOKEN/);
  });
});

describe("dev:chat — o fio /rpc", () => {
  it("manda POST /rpc/<proc> com {json} e Bearer, e devolve .json", async () => {
    const calls = [];
    const rpc = createRpc({
      base: "http://127.0.0.1:3100",
      token: "tok",
      fetch: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ json: [{ id: "b1", name: "ana" }] });
      },
    });
    const bots = await rpc("bots/list");
    expect(bots).toEqual([{ id: "b1", name: "ana" }]);
    expect(calls[0].url).toBe("http://127.0.0.1:3100/rpc/bots/list");
    expect(calls[0].options.method).toBe("POST");
    expect(calls[0].options.headers.authorization).toBe("Bearer tok");
    expect(calls[0].options.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].options.body)).toEqual({ json: {} });
  });

  it("embrulha a entrada em {json:…}", async () => {
    let body = "";
    const rpc = createRpc({
      base: "http://127.0.0.1:3100",
      token: "tok",
      fetch: async (_url, options) => {
        body = options.body;
        return jsonResponse({ json: { taskId: "t", runId: "r", seq: 3 } });
      },
    });
    await rpc("threads/send", { botId: "b1", text: "oi" });
    expect(JSON.parse(body)).toEqual({ json: { botId: "b1", text: "oi" } });
  });

  it("401 vira uma frase sobre a sessão", async () => {
    const rpc = createRpc({
      base: "http://127.0.0.1:3100",
      fetch: async () => jsonResponse({ message: "Entre primeiro." }, 401),
    });
    await expect(rpc("me")).rejects.toThrow(/sessão não vale/i);
  });

  it("erro do oRPC no corpo vira a mensagem do servidor", async () => {
    const rpc = createRpc({
      base: "http://127.0.0.1:3100",
      fetch: async () => jsonResponse({ error: { message: "Muitas tentativas." } }, 429),
    });
    await expect(rpc("threads/send")).rejects.toThrow("Muitas tentativas.");
  });

  it("resposta que não é JSON não derruba o script", async () => {
    const rpc = createRpc({
      base: "http://127.0.0.1:3100",
      fetch: async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("Unexpected token <");
        },
      }),
    });
    await expect(rpc("threads/get")).rejects.toThrow(/HTTP 502/);
  });
});

describe("dev:chat — escolha do bot e desenho do recado", () => {
  const bots = [
    { id: "b1", name: "ana" },
    { id: "b2", name: "bia" },
  ];

  it("sem nome usa o primeiro; com nome ou id acha o certo", () => {
    expect(pickBot(bots, null).id).toBe("b1");
    expect(pickBot(bots, "bia").id).toBe("b2");
    expect(pickBot(bots, "b2").id).toBe("b2");
  });

  it("lista vazia e nome errado explicam o que fazer", () => {
    expect(() => pickBot([], null)).toThrow(/Nenhum bot/);
    expect(() => pickBot(bots, "zoe")).toThrow(/ana, bia/);
  });

  it("desenha os blocos que o contrato define", () => {
    expect(renderMessage({ role: "user", blocks: [{ kind: "text", text: "oi" }] })).toBe(
      "você › oi",
    );
    expect(
      renderMessage({
        role: "bot",
        blocks: [
          { kind: "text", text: "pronto" },
          { kind: "file", name: "nota.pdf", mimeType: "application/pdf", size: 12 },
        ],
      }),
    ).toBe("bot › pronto\n[arquivo] nota.pdf (application/pdf, 12 bytes)");
    expect(
      renderMessage({
        role: "bot",
        blocks: [
          {
            kind: "choice",
            question: "Qual?",
            options: [{ id: "a", letter: "A", label: "Esta" }],
          },
        ],
      }),
    ).toBe("bot › [escolha] Qual?\n  A) Esta");
    expect(renderMessage({ role: "bot", blocks: [] })).toBe("bot › (sem texto)");
    expect(renderMessage({ role: "bot", blocks: [{ kind: "inventado" }] })).toBe(
      "bot › [inventado]",
    );
  });
});

describe("dev:chat — quando parar de esperar", () => {
  it("segue esperando enquanto o run está de pé", () => {
    for (const status of ["queued", "leased", "running"]) {
      expect(runIsOver({ status })).toBe(false);
    }
  });

  it("para quando o run acabou, foi cancelado ou espera a pessoa", () => {
    for (const status of ["completed", "failed", "cancelled", "waiting_input"]) {
      expect(runIsOver({ status })).toBe(true);
    }
    expect(runIsOver(null)).toBe(true);
  });

  it("texto vira resposta quando o bot está parado numa pergunta", () => {
    expect(commandFor("sim", { id: "r1", status: "waiting_input" }, "b1")).toEqual({
      proc: "threads/answer",
      input: { botId: "b1", runId: "r1", answer: "sim" },
    });
    expect(commandFor("oi", { id: "r1", status: "completed" }, "b1")).toEqual({
      proc: "threads/send",
      input: { botId: "b1", text: "oi" },
    });
    expect(commandFor("/parar", null, "b1")).toEqual({
      proc: "threads/stop",
      input: { botId: "b1" },
    });
  });
});

describe("dev:chat — ligado no package.json", () => {
  it("o script dev:chat da raiz aponta para este arquivo", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.scripts["dev:chat"]).toContain("scripts/dev-chat.mjs");
  });
});

describe("dev:chat — conversa de ponta a ponta contra uma API falsa (local)", () => {
  it("entra pelo loopback, manda o recado e imprime a resposta do bot", async () => {
    const seen = { auth: [], sent: [], localSessionHeaders: null };
    let afterSend = false;

    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const url = req.url ?? "";
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const reply = (payload) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (url === "/health") return reply({ ok: true, worker: { alive: true } });
        if (url === "/api/local/session") {
          seen.localSessionHeaders = req.headers;
          return reply({ ok: true, token: "tok-local", name: "Caio" });
        }
        seen.auth.push(req.headers.authorization);
        if (url === "/rpc/bots/list") return reply({ json: [{ id: "b1", name: "ana" }] });
        if (url === "/rpc/threads/send") {
          seen.sent.push(body.json);
          afterSend = true;
          return reply({ json: { taskId: "t1", runId: "r1", seq: 1 } });
        }
        if (url === "/rpc/threads/get") {
          return reply({
            json: {
              botId: "b1",
              threadId: "th1",
              cursor: afterSend ? 2 : 0,
              messages: afterSend
                ? [{ id: "m2", role: "bot", blocks: [{ kind: "text", text: "tudo certo" }] }]
                : [],
              run: afterSend ? { id: "r1", status: "completed" } : null,
              computer: {},
            },
          });
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "rota falsa não existe" }));
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const output = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.resolve(scriptsDir, "dev-chat.mjs"), "--url", `http://127.0.0.1:${port}`],
          { env: { ...process.env, QUIBT_TOKEN: "" }, stdio: ["pipe", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
        child.stdin.write("oi\n");
        child.stdin.write("/sair\n");
        child.stdin.end();
      });

      expect(output.stderr).not.toContain("readline");
      expect(output.code).toBe(0);
      expect(output.stdout).toContain("Quibt dev chat — Caio → ana (b1)");
      expect(output.stdout).toContain("bot › tudo certo");
      expect(seen.sent).toEqual([{ botId: "b1", text: "oi" }]);
      expect(new Set(seen.auth)).toEqual(new Set(["Bearer tok-local"]));
      // A entrada sem senha vai crua: nada de cabeçalho encaminhado ou de capacidade.
      expect(seen.localSessionHeaders?.["x-forwarded-for"]).toBeUndefined();
      expect(seen.localSessionHeaders?.["x-quibt-desktop-session"]).toBeUndefined();
      expect(seen.localSessionHeaders?.["x-quibt-internal-proxy"]).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 20_000);
});
