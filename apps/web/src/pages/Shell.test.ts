import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(path.join(root, "Shell.tsx"), "utf8");
const inbox = readFileSync(path.join(root, "Inbox.tsx"), "utf8");
const preview = readFileSync(path.join(root, "ComputerPreview.tsx"), "utf8");

describe("dashboard copies the landing product demo", () => {
  it("uses the landing three-column chrome", () => {
    expect(shell).toContain("qb-dash");
    expect(shell).toContain("qb-dash__topbar");
    expect(shell).toContain("qb-dash__panel-toggle");
    expect(shell).toContain("qb-dash__input-shell");
    // 316px é a largura da lista medida no Grok Bot.
    expect(shell).toContain("md:w-[316px]");
    expect(shell).toContain("md:w-[320px]");
    expect(shell).toContain("qb-dash--panel-open");
    expect(shell).toContain("computador de");
    expect(shell).toContain("Mensagem para");
    expect(shell).toContain("Assumir controle");
  });

  it("keeps a single Ajustes do bot control in the chat header", () => {
    expect(shell.match(/aria-label="Ajustes do bot"/g)).toHaveLength(1);
    expect(shell).toContain("function closeComputerOverlay()");
    expect(shell).toContain('aria-label="Abrir ajustes"');
  });

  it("the labeled Assumir controle action takes the keyboard, not just opens the overlay", () => {
    expect(shell).toContain("async function takeOverComputer()");
    expect(shell).toContain("onClick={() => void takeOverComputer()}");
    expect(shell).not.toContain(
      "onClick={() => void openComputer()}\n                    >\n                      Assumir controle",
    );
  });

  it("does not keep a screen URL or heartbeat after the lease is gone", () => {
    expect(shell).not.toContain("Assuma o controle para ver a tela");
    expect(shell).toContain('if (computer?.controlHolder !== "user") return;');
  });

  it("shows the bot's screen as polled stills while the user does not hold control", () => {
    // Sem o controle não há stream, mas há retrato: o painel e a tela cheia mostram o
    // último `computer.preview` com a idade em cima, nunca só a ilustração de mesa.
    expect(shell).toContain("rpc.computer.preview({ botId: previewBotId })");
    expect(shell).toContain("shouldPollPreview({");
    expect(shell).toContain("streaming: pinnedScreenUrl !== null");
    expect(shell).toContain("previewPollDelayMs(failures)");
    expect(shell).toContain("previewAgeLabel(previewAgeMs(preview, previewNow))");
    expect(shell.match(/className="qb-live-badge/g)?.length).toBeGreaterThanOrEqual(3);
    expect(shell).toContain('className="qb-screen-still"');
    expect(shell).toContain("sem prévia · tentando de novo");
    // A pílula de assumir continua sobre o retrato em tela cheia.
    expect(shell.match(/className="qb-screen-claim"/g)).toHaveLength(2);
  });

  it("keeps the monitor toggle on the side panel, not a jump to fullscreen", () => {
    expect(shell).toContain('setPanel((current) => (current === "computer" ? null : "computer"))');
    expect(shell).toContain("ComputerPreview");
    expect(preview).toContain("qb-dash__desktop");
    expect(preview).toContain("qb-dash__window");
  });

  it("does not keep the old featured-mascot inbox", () => {
    expect(inbox).toContain("qb-dash__search");
    expect(inbox).toContain("qb-dash__user");
    expect(inbox).not.toContain("featured");
    expect(inbox).not.toContain("size={96}");
  });

  it("creates additional bots with the same appearance fields as onboarding", () => {
    expect(shell).toContain("color: input.color");
    expect(shell).toContain("shape: input.shape");
    expect(shell).toContain("<CreateBotForm");
  });

  it("gives the desktop chat OpenMaus-style composer and shortcuts", () => {
    expect(shell).toContain("<textarea");
    expect(shell).toContain("setQueued");
    expect(shell).toContain("shortcutFromKey");
    expect(shell).toContain("starterPrompts");
    expect(shell).toContain("Ir ao mais recente");
    expect(shell).toContain("qb-dash__name-pill");
  });

  it("waits for run cancellation and clears the working composer state", () => {
    expect(shell).toContain("async function stopWorkingRuns()");
    expect(shell).toContain(
      "await Promise.all(botIds.map((id) => rpc.threads.stop({ botId: id })))",
    );
    expect(shell).toContain("run: null");
    expect(shell).toContain("aria-busy={stopping}");
    expect(shell).toContain('aria-label={stopping ? "Parando agente" : "Parar agente"}');
  });

  it("clears inbox search after creating a group and lands on it", () => {
    expect(shell).toContain("async function createGroup");
    expect(shell).toContain('setQuery("")');
    // Em duas metades de propósito: a interpolação inteira dentro de uma string comum é
    // o padrão que o lint proíbe, e aqui ela é o texto do Shell.tsx que estamos procurando.
    expect(shell).toContain("navigate(`/app/g/");
    expect(shell).toContain("group.id}`)");
    expect(shell).toContain('event.type === "run.failed"');
  });
});
