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
