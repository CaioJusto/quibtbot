import type { ThreadMessage } from "@quibt/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { peerAuthor } from "../lib/thread-authors";
import { BurstSummary, MessageView } from "./MessageView";

const bots = [{ id: "bot_ada", name: "Ada", color: "#E65707" }];

function message(patch: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "msg_1",
    threadId: "thr_1",
    seq: 1,
    role: "user",
    blocks: [{ kind: "text", text: "ship the deck" }],
    createdAt: "2026-08-13T00:00:00.000Z",
    ...patch,
  };
}

describe("MessageView", () => {
  it("renders a peer message with its sender, not as the user's own bubble", () => {
    const peer = message({ fromBotId: "bot_ada" });
    const html = renderToStaticMarkup(
      <MessageView
        message={peer}
        author={peerAuthor(peer, "bot_chief", bots)}
        authorNote="teammate"
        onAnswer={() => undefined}
      />,
    );

    expect(html).toContain("Ada");
    expect(html).toContain("Mensagem de");
    expect(html).toContain("justify-start");
    expect(html).not.toContain("justify-end");
  });

  it("keeps the user's own messages on the right with no author", () => {
    const own = message();
    const html = renderToStaticMarkup(
      <MessageView
        message={own}
        author={peerAuthor(own, "bot_chief", bots)}
        onAnswer={() => undefined}
      />,
    );

    expect(html).toContain("justify-end");
    expect(html).not.toContain("Ada");
  });

  it("attributes a group message to the bot that wrote it, iMessage-style", () => {
    const html = renderToStaticMarkup(
      <MessageView
        message={message({ role: "bot", authorBotId: "bot_ada" })}
        author={{ id: "bot_ada", name: "Ada", color: "#E65707", shape: "triangle" }}
        groupLayout
        onAnswer={() => undefined}
      />,
    );

    expect(html).toContain("Ada");
    expect(html).toContain("ship the deck");
    // Name label sits above the bubble, not in a centered "Message from" chip.
    expect(html).not.toContain("Mensagem de");
    expect(html).toContain("items-start");
    expect(html).toContain("justify-start");
    expect(html).toContain("w-8");
  });

  it("keeps the user's group messages on the right without avatar or label", () => {
    const html = renderToStaticMarkup(
      <MessageView message={message()} author={null} groupLayout onAnswer={() => undefined} />,
    );

    expect(html).toContain("justify-end");
    expect(html).not.toContain("items-start");
  });

  it("attributes an interactive group question to the bot that is waiting", () => {
    const html = renderToStaticMarkup(
      <MessageView
        message={message({
          role: "bot",
          authorBotId: "bot_ada",
          runId: "run_1",
          blocks: [{ kind: "ask", text: "Can I send this?" }],
        })}
        author={{ id: "bot_ada", name: "Ada", color: "#E65707" }}
        groupLayout
        onAnswer={() => undefined}
      />,
    );

    expect(html).toContain("Ada");
    expect(html).toContain("Can I send this?");
    expect(html).toContain("Enviar");
    expect(html).toContain("items-start");
  });

  it("renders allow, deny and always-allow on a tool approval card", () => {
    const html = renderToStaticMarkup(
      <MessageView
        message={message({
          role: "bot",
          runId: "run_1",
          blocks: [
            {
              kind: "ask",
              text: "Preciso da sua aprovação",
              detail: "git status",
              tool: "shell",
              allowKey: "shell:git",
              requestId: "exec-1",
            },
          ],
        })}
        onAnswer={() => undefined}
      />,
    );
    expect(html).toContain("Aprovação");
    expect(html).toContain("Permitir");
    expect(html).toContain("Recusar");
    expect(html).toContain("Sempre permitir");
    expect(html).toContain("git status");
  });

  it("renders an active computer handoff with preview and an internal takeover action", () => {
    const html = renderToStaticMarkup(
      <MessageView
        message={message({
          role: "bot",
          runId: "run_1",
          blocks: [
            {
              kind: "computer",
              state: "Ready",
              text: "Preciso que você conclua o login.",
            },
          ],
        })}
        computerHandoffActive
        computerPreview="data:image/png;base64,cHJldmlldw=="
        computerPreviewLabel="ao vivo · agora"
        onOpenComputer={() => undefined}
        onTakeOverComputer={() => undefined}
        onAnswer={() => undefined}
      />,
    );

    expect(html).toContain("Precisa de você");
    expect(html).toContain("Prévia da tela do computador");
    expect(html).toContain("Assumir controle");
    expect(html).toContain("Abrir dentro do Quibt");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("target=");
  });

  it("keeps a settled computer card opening the internal viewer", () => {
    const html = renderToStaticMarkup(
      <MessageView
        message={message({
          role: "bot",
          blocks: [{ kind: "computer", state: "Concluído", text: "Login concluído." }],
        })}
        onOpenComputer={() => undefined}
        onAnswer={() => undefined}
      />,
    );

    expect(html).toContain("Abrir computador");
    expect(html).not.toContain("Assumir controle");
  });

  it("abre o PDF dentro do app e deixa a planilha baixar", () => {
    const pdf = renderToStaticMarkup(
      <MessageView
        message={message({
          blocks: [
            {
              kind: "file",
              artifactId: "art_1",
              name: "contrato.pdf",
              mimeType: "application/pdf",
              size: 400_000,
            },
          ],
        })}
        onAnswer={() => undefined}
      />,
    );
    expect(pdf).toContain('aria-label="Abrir contrato.pdf"');
    expect(pdf).not.toContain('download="contrato.pdf"');

    const sheet = renderToStaticMarkup(
      <MessageView
        message={message({
          blocks: [
            {
              kind: "file",
              artifactId: "art_2",
              name: "vendas.xlsx",
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              size: 20_000,
            },
          ],
        })}
        onAnswer={() => undefined}
      />,
    );
    expect(sheet).toContain('download="vendas.xlsx"');
  });

  it("toca no fio o vídeo e o áudio que chegam com o tipo certo", () => {
    const html = renderToStaticMarkup(
      <MessageView
        message={message({
          blocks: [
            {
              kind: "file",
              artifactId: "art_3",
              name: "tela.mp4",
              mimeType: "video/mp4",
              size: 900_000,
            },
          ],
        })}
        onAnswer={() => undefined}
      />,
    );
    expect(html).toContain("<video");
  });

  it("summarizes a multi-agent burst in Portuguese", () => {
    const html = renderToStaticMarkup(
      <BurstSummary
        messages={3}
        authors={[
          { id: "bot_ada", name: "Ada", color: "#E65707", shape: "triangle" },
          { id: "bot_scout", name: "Scout", color: "#0A84FF", shape: "circle" },
        ]}
      />,
    );
    expect(html).toContain("3 mensagens com");
    expect(html).toContain("2 agentes");
    expect(html).not.toContain("messages");
    expect(html).not.toContain("agents");
  });
});
