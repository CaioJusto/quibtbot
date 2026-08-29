import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(path.join(root, "Shell.tsx"), "utf8");
const inbox = readFileSync(path.join(root, "Inbox.tsx"), "utf8");
const preview = readFileSync(path.join(root, "ComputerPreview.tsx"), "utf8");
const styles = readFileSync(path.join(root, "../styles.css"), "utf8");

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

  it("opens a takeover request from the conversation inside the Quibt overlay", () => {
    expect(shell).toContain('snapshot?.run?.status === "waiting_takeover"');
    expect(shell).toContain("onTakeOverComputer=");
    expect(shell).toContain("!activeGroup && active ? () => void takeOverComputer() : undefined");
    expect(shell).toContain('panel === "computer" || computerOpen || takeoverRequested');
    expect(shell).not.toContain("window.open(screenUrl");
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
    // O laço (backoff, descarte em voo) é o de preview-poll.ts, testado lá com relógio falso.
    expect(shell).toContain("createPreviewPoller({");
    expect(shell).toContain("previewAgeMs(preview, previewNow)");
    expect(shell).toContain("previewIsStale(previewAge)");
    expect(shell.match(/className="qb-live-badge/g)?.length).toBeGreaterThanOrEqual(3);
    expect(shell).toContain('className="qb-screen-still"');
    expect(shell).toContain("sem prévia · tentando de novo");
    // A pílula de assumir continua sobre o retrato em tela cheia.
    expect(shell.match(/className="qb-screen-claim"/g)).toHaveLength(2);
  });

  it("keeps the last still when a poll fails, and only drops it after a minute", () => {
    // Uma falha não apaga o retrato: o sub-rótulo avisa por cima dele.
    expect(shell).toContain("qb-live-badge--sub");
    // A falha só acende o aviso; apagar o retrato é coisa da saída do efeito, não do poll.
    expect(shell).toContain("onFailure: () => setPreviewFailed(true)");
    expect(shell).not.toMatch(/onFailure:[^\n]*setPreview\(null\)/);
    expect(shell).toContain("previewShown && !screenLost");
  });

  it("tells 'mine' from 'someone else holds the lease' by the screen URL, not controlHolder", () => {
    // controlHolder é o campo do banco e vale "user" para a workspace inteira; só quem tem
    // o lease recebe a URL. Sem ela, é outra pessoa: o retrato continua e o painel avisa.
    expect(shell).toContain("holdsComputerControl({");
    expect(shell).toContain("const othersControl = othersHoldControl({");
    // Nenhum destes três lugares volta a perguntar ao campo do banco de quem é o lease.
    expect(shell.match(/Outra pessoa está no controle/g)?.length).toBeGreaterThanOrEqual(3);
    expect(shell).toMatch(/shouldPollPreview\(\{[^}]*screenLost,/s);
    // Sem o lease não há stream para ter caído: o aviso "a tela caiu" é zerado.
    expect(shell).toMatch(
      /if \(holdsControl\) return;\s+screenRetries\.current = 0;\s+setScreenLost\(false\);/,
    );
  });

  it("o heartbeat do computador só bate com a aba à vista e escreve o prazo novo na tela", () => {
    // Aba escondida batendo a cada minuto segurava o teclado de um bot parado esperando
    // a pessoa — o navegador só desacelera o timer, não o desliga.
    expect(shell).toContain('if (document.visibilityState !== "visible") return;');
    expect(shell).toContain(".heartbeat({ botId, atScreen })");
    // O que se digita dentro do quadro do noVNC não passa pela API: o foco no quadro é a
    // única prova de uso que a web tem para oferecer.
    expect(shell).toContain("document.activeElement === screenFrame.current");
    expect(shell).toContain("withControlLease(current, answer.controlLeaseExpiresAt)");
  });

  it("keeps the monitor toggle on the side panel, not a jump to fullscreen", () => {
    expect(shell).toContain('setPanel((current) => (current === "computer" ? null : "computer"))');
    expect(shell).toContain("ComputerPreview");
    expect(preview).toContain("qb-dash__desktop");
    expect(preview).toContain("qb-dash__window");
  });

  it("renders the routine switch without depending on workspace Tailwind discovery", () => {
    expect(shell).toContain('thumbClassName="qb-grok-switch__thumb"');
    expect(styles).toMatch(/\.qb-grok-switch\s*\{[^}]*border-radius:\s*999px/s);
    expect(styles).toMatch(
      /\.qb-grok-switch__thumb\s*\{[^}]*background:\s*#fff[^}]*translateX\(2px\)/s,
    );
    expect(styles).toMatch(
      /\.qb-grok-switch__thumb\[data-state="checked"\]\s*\{[^}]*translateX\(18px\)/s,
    );
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

  it("guarda um rascunho por conversa, e não um para o app inteiro", () => {
    // O bug era um `useState` só: escrever para a Cubee, pular no grupo e achar a frase lá.
    expect(shell).not.toContain('const [draft, setDraft] = useState("")');
    expect(shell).not.toContain("useState<Attachment[]>([])");
    expect(shell).toContain("const chatKey = conversationKey({ botId, groupId })");
    expect(shell).toContain("const currentDraft = draftAt(drafts, chatKey)");
    expect(shell).toContain("const draft = currentDraft.text");
    expect(shell).toContain("const attachments = currentDraft.attachments");
    expect(shell).toContain("const replyToId = currentDraft.replyToId");
    // Toda escrita diz em qual conversa ela cai; enviar limpa só a entrada daquela.
    expect(shell).toContain("editDraft(chatKey,");
    expect(shell).toContain("writeStoredDrafts(drafts)");
    expect(shell).toContain("readStoredDrafts()");
  });

  it("anexa o arquivo arrastado ou colado sem deixar o navegador abri-lo", () => {
    expect(shell).toContain("onDragEnter=");
    expect(shell).toContain("onDragOver=");
    expect(shell).toContain("onDragLeave=");
    expect(shell).toContain("onDrop=");
    expect(shell).toContain("onPaste=");
    expect(shell).toContain("filesFromTransfer(event.dataTransfer)");
    expect(shell).toContain("filesFromTransfer(e.clipboardData)");
    expect(shell).toContain('dragging ? " is-dragging" : ""');
    // O guarda da janela inteira: soltar fora do campo não pode trocar a página pelo arquivo.
    expect(shell).toContain('window.addEventListener("drop", swallow)');
  });

  it("acha na conversa aberta com ⌘F, sem rota nova", () => {
    expect(shell).toContain("opensThreadSearch(event) && threadOpen");
    expect(shell).toContain("threadMatches(threadMessages, findQuery)");
    expect(shell).toContain("stepMatch(findAt, findHits.length, delta)");
    expect(shell).toContain("data-message-id={message.id}");
    expect(shell).toContain('hit.scrollIntoView({ block: "center", behavior: "smooth" })');
    expect(shell).toContain('aria-label="Achar nesta conversa"');
    expect(shell).toContain('aria-label="Próxima ocorrência"');
    expect(shell).toContain("qb-find-hit");
    // A busca é do lado de cá: o fio já está na memória, não há chamada nova ao servidor.
    expect(shell).not.toContain("rpc.threads.search");
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
