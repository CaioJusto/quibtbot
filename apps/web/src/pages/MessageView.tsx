import { ChatMarkdown } from "@quibt/chat-ui/web";
import type { ThreadMessage } from "@quibt/contracts";
import { fileViewerKind, TEXT_VIEWER_MAX_BYTES } from "@quibt/core";
import { BotAvatar } from "@quibt/ui-web";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Icon } from "../components/desktop-ui";
import type { MessageAuthor } from "../lib/thread-authors";
import { isTurnStartMarker } from "../lib/turn-start";

/** O arquivo é servido pela API, na mesma origem, com o cookie da sessão. */
export function fileUrl(artifactId: string): string {
  return `/files/${encodeURIComponent(artifactId)}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

const BUBBLE =
  "qb-msg-bubble w-fit max-w-[520px] rounded-[var(--qb-r-lg)] bg-[var(--qb-surface)] px-4 py-[10px] text-[15px] leading-[1.48] text-[var(--qb-ink)]";
const USER_COLLAPSE_CHARS = 600;

function stripPeerCue(text: string): string {
  return text.replace(/^\[peer\][^\n:]*:\s*/i, "");
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copiar mensagem"
      title="Copiar"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      className="rounded-md p-1.5 text-[var(--qb-muted-2)] opacity-0 transition-opacity hover:bg-[var(--qb-surface)] hover:text-[var(--qb-ink)] group-hover:opacity-100 group-focus-within:opacity-100"
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

/** Os seis do Grok, mais o botão de abrir o teclado completo do sistema. */
const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"];

function MessageActions({
  text,
  onReply,
  onReact,
}: {
  text: string;
  onReply?: () => void;
  onReact?: (emoji: string) => void;
}) {
  const [picker, setPicker] = useState(false);
  return (
    <div className="relative flex items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      {onReact ? (
        <button
          type="button"
          aria-label="Reagir"
          title="Reagir"
          onClick={() => setPicker((open) => !open)}
          className="rounded-md p-1.5 text-[var(--qb-muted-2)] hover:bg-[var(--qb-surface)] hover:text-[var(--qb-ink)]"
        >
          <Icon name="smile" size={14} />
        </button>
      ) : null}
      {onReply ? (
        <button
          type="button"
          aria-label="Responder"
          title="Responder"
          onClick={onReply}
          className="rounded-md p-1.5 text-[var(--qb-muted-2)] hover:bg-[var(--qb-surface)] hover:text-[var(--qb-ink)]"
        >
          <Icon name="reply" size={14} />
        </button>
      ) : null}
      <CopyButton text={text} />
      {picker && onReact ? (
        <>
          <button
            type="button"
            aria-label="Fechar reações"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setPicker(false)}
          />
          <div className="qb-menu absolute bottom-full left-1/2 z-50 mb-1 flex -translate-x-1/2 gap-0.5 p-1">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`Reagir com ${emoji}`}
                onClick={() => {
                  onReact(emoji);
                  setPicker(false);
                }}
                className="rounded-lg px-1.5 py-1 text-[18px] leading-none hover:bg-[var(--qb-surface)]"
              >
                {emoji}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Quoted({ text, mine }: { text: string; mine?: boolean }) {
  return (
    <div className={`qb-quoted${mine ? " is-mine" : ""}`}>
      <Icon name="reply" size={12} />
      <span className="truncate">{text}</span>
    </div>
  );
}

/**
 * "Sempre permitir" só aparece quando o servidor vai honrar: o card traz em `actions`
 * o que vale para ele (um pedido destrutivo vem sem). Cards antigos não traziam `actions`;
 * neles o botão valia sempre que havia `allowKey`.
 */
function offersAlways(block: { allowKey?: string; actions?: Array<{ id: string }> }): boolean {
  if (block.actions) return block.actions.some((action) => action.id === "always");
  return Boolean(block.allowKey);
}

function Reactions({
  reactions,
  onReact,
}: {
  reactions?: Record<string, string[]>;
  onReact?: (emoji: string) => void;
}) {
  const entries = Object.entries(reactions ?? {}).filter(([, who]) => who.length > 0);
  if (!entries.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map(([emoji, who]) => (
        <button
          key={emoji}
          type="button"
          disabled={!onReact}
          onClick={() => onReact?.(emoji)}
          className="qb-reaction"
        >
          <span>{emoji}</span>
          {who.length > 1 ? <span className="qb-reaction__count">{who.length}</span> : null}
        </button>
      ))}
    </div>
  );
}

type ViewerFile = { artifactId: string; name: string; mimeType?: string; size?: number };

function ComputerHandoffCard({
  state,
  text,
  active,
  preview,
  previewLabel,
  busy,
  onOpen,
  onTakeOver,
}: {
  state: string;
  text: string;
  active: boolean;
  preview?: string | null;
  previewLabel?: string | null;
  busy?: boolean;
  onOpen?: () => void;
  onTakeOver?: () => void;
}) {
  const action = active ? onTakeOver : onOpen;
  const actionLabel = active ? "Assumir controle" : "Abrir computador";
  const titleId = useId();
  const descriptionId = useId();

  return (
    <article
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="w-[min(420px,100%)] overflow-hidden rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)]"
    >
      <div className="flex items-center justify-between gap-3 px-[18px] pt-4 pb-3">
        <span id={titleId} className="text-[16px] font-semibold text-[var(--qb-ink)]">
          Computador
        </span>
        <span
          className={`rounded-full px-3 py-1 text-[13px] font-medium ${
            active
              ? "bg-[rgba(255,159,10,.15)] text-[#C56D00]"
              : "bg-[rgba(52,199,89,.16)] text-[#268A44]"
          }`}
          role="status"
        >
          {active ? "Precisa de você" : state}
        </span>
      </div>

      {active ? (
        <button
          type="button"
          aria-label="Assumir controle e abrir o computador dentro do Quibt"
          className="group relative mx-[18px] block aspect-video w-[calc(100%_-_36px)] overflow-hidden rounded-[var(--qb-r-md)] bg-[var(--qb-rail)] text-[var(--qb-canvas)]"
          disabled={busy || !action}
          onClick={action}
        >
          {preview ? (
            <img
              src={preview}
              alt="Prévia da tela do computador"
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="flex h-full flex-col items-center justify-center gap-2 text-[14px] text-[var(--qb-muted)]">
              <Icon name="monitor" size={28} />
              Preparando a prévia…
            </span>
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-[rgba(4,4,5,.24)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <span className="flex items-center gap-2 rounded-full bg-[rgba(4,4,5,.82)] px-4 py-2 text-[14px] font-medium text-white">
              <Icon name="expand" size={14} />
              Abrir dentro do Quibt
            </span>
          </span>
          {preview && previewLabel ? (
            <span className="absolute top-2 right-2 rounded-full bg-[rgba(4,4,5,.72)] px-2.5 py-1 text-[11px] font-medium text-white">
              {previewLabel}
            </span>
          ) : null}
        </button>
      ) : null}

      <div className="px-[18px] py-4">
        <div id={descriptionId} className="text-[15px] leading-[1.45] text-[var(--qb-ink)]">
          <ChatMarkdown>{text}</ChatMarkdown>
        </div>
        {action ? (
          <button
            type="button"
            className="mt-3.5 flex min-h-11 items-center gap-2 rounded-full bg-[var(--qb-ink-strong)] px-4 py-2.5 text-[15px] font-medium text-[var(--qb-canvas)] disabled:cursor-wait disabled:opacity-60"
            disabled={busy}
            onClick={action}
          >
            <Icon name={active ? "monitor" : "expand"} size={15} />
            {busy ? "Abrindo…" : actionLabel}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** PDF não é um tipo que o `fileViewerKind` compartilhe com o celular: lá ele vai para a
 * folha do sistema, aqui o próprio navegador já sabe desenhá-lo. */
function isPdfFile(mimeType: string | undefined, name: string | undefined): boolean {
  return (
    (mimeType ?? "").toLowerCase() === "application/pdf" ||
    (name ?? "").toLowerCase().endsWith(".pdf")
  );
}

/**
 * O que abre dentro do app quando o cartão do arquivo é clicado: PDF, texto que caiba na
 * tela, e mídia que o navegador não reconheceu pelo tipo (um `.mov` que chegou como
 * `application/octet-stream` não vira player sozinho no fio, mas toca aqui).
 */
function opensInViewer(block: { mimeType: string; name: string; size: number }): boolean {
  if (isPdfFile(block.mimeType, block.name)) return true;
  const kind = fileViewerKind(block.mimeType, block.name);
  if (kind === "video" || kind === "audio") return true;
  return kind === "text" && block.size <= TEXT_VIEWER_MAX_BYTES;
}

/**
 * O visualizador de arquivos do app: imagem, vídeo, áudio, PDF e texto legível abrem aqui
 * dentro, num overlay escuro, em vez de virarem uma aba nova ou um download. Planilha e o
 * resto continuam baixando — fingir que abrem seria pior do que dizer que não abrem.
 *
 * A tela escura é do visualizador, como num app de fotos: não é cromo do produto, é o fundo
 * que tira o resto da tela do caminho. É a mesma escolha do celular.
 */
function FileOverlay({ file, onClose }: { file: ViewerFile; onClose: () => void }) {
  const kind = fileViewerKind(file.mimeType, file.name);
  // "other" ainda pode ser um PDF; o que não é nem isso não tem o que mostrar aqui.
  const mode = kind === "other" ? (isPdfFile(file.mimeType, file.name) ? "pdf" : "none") : kind;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (mode !== "text") return;
    let active = true;
    void fetch(fileUrl(file.artifactId), { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(`não deu para ler (${response.status})`);
        return response.text();
      })
      .then((body) => {
        if (active) setText(body);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "não deu para ler o arquivo");
      });
    return () => {
      active = false;
    };
  }, [mode, file.artifactId]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: somente um clique direto no fundo fecha; Esc também fecha.
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[rgba(10,10,11,0.92)]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          aria-label="Fechar arquivo"
          onClick={onClose}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[rgba(255,255,255,0.14)] text-white"
        >
          <Icon name="x" size={16} />
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold text-white">
          {file.name}
        </span>
        <a
          href={fileUrl(file.artifactId)}
          download={file.name}
          aria-label="Baixar arquivo"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[rgba(255,255,255,0.14)] text-white no-underline"
        >
          <Icon name="download" size={16} />
        </a>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {mode === "image" ? (
          <img
            src={fileUrl(file.artifactId)}
            alt={file.name}
            className="max-h-full max-w-full rounded-[var(--qb-r-md)] object-contain"
          />
        ) : mode === "video" ? (
          <video
            src={fileUrl(file.artifactId)}
            controls
            autoPlay
            className="max-h-full max-w-full rounded-[var(--qb-r-md)]"
          >
            {/* Anexo de tela ou de câmera não vem com trilha de legenda. */}
            <track kind="captions" />
          </video>
        ) : mode === "audio" ? (
          <audio src={fileUrl(file.artifactId)} controls autoPlay className="w-full max-w-[520px]">
            <track kind="captions" />
          </audio>
        ) : mode === "pdf" ? (
          // O leitor de PDF do próprio navegador, dentro do overlay: nada de biblioteca
          // extra no pacote para desenhar o que ele já desenha.
          <iframe
            title={file.name}
            src={fileUrl(file.artifactId)}
            className="h-full w-full max-w-[980px] rounded-[var(--qb-r-md)] bg-white"
          />
        ) : mode === "none" ? (
          <p className="text-[15px] text-white/70">
            Este arquivo não abre aqui dentro — use o botão de baixar.
          </p>
        ) : error ? (
          <p className="text-[15px] text-[#FF8A8E]">{error}</p>
        ) : text === null ? (
          <p className="text-[15px] text-white/70">Abrindo…</p>
        ) : (
          <pre className="max-h-full w-full max-w-[880px] overflow-auto rounded-[var(--qb-r-md)] bg-[#161618] p-5 font-mono text-[13px] leading-[1.7] whitespace-pre-wrap text-[#F2F2F4]">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}

export function MessageView({
  message,
  author,
  authorNote,
  groupLayout,
  onAnswer,
  onOpenBot,
  onEdit,
  onPrefill,
  onSwitchBranch,
  onReply,
  onReact,
  quoted,
  askActive,
  versionIndex,
  versionCount,
  canEdit,
  computerHandoffActive,
  computerPreview,
  computerPreviewLabel,
  computerBusy,
  onOpenComputer,
  onTakeOverComputer,
}: {
  message: ThreadMessage;
  author?: MessageAuthor | null;
  authorNote?: string;
  /** Grok-style group chat: author name above the bubble, small avatar beside it. */
  groupLayout?: boolean;
  onAnswer: (text: string) => void;
  onOpenBot?: (botId: string) => void;
  onEdit?: (text: string) => void;
  /** Loads text into the composer without entering edit-and-branch mode. */
  onPrefill?: (text: string) => void;
  onSwitchBranch?: (direction: -1 | 1) => void;
  /** Cita este recado no composer. */
  onReply?: () => void;
  onReact?: (emoji: string) => void;
  /** Trecho do recado que esta mensagem responde. */
  quoted?: string;
  /** O run ainda espera esta aprovação. Cards antigos viram histórico. */
  askActive?: boolean;
  versionIndex?: number;
  versionCount?: number;
  canEdit?: boolean;
  /** Este card pertence ao run que aguarda a pessoa assumir a tela. */
  computerHandoffActive?: boolean;
  /** Retrato seguro e não interativo enquanto a pessoa ainda não tomou o lease. */
  computerPreview?: string | null;
  computerPreviewLabel?: string | null;
  computerBusy?: boolean;
  /** Abre o viewer interno sem sair do Quibt. */
  onOpenComputer?: () => void;
  /** Toma o lease e abre o viewer interno; nunca navega para uma aba externa. */
  onTakeOverComputer?: () => void;
}) {
  const [viewer, setViewer] = useState<ViewerFile | null>(null);
  return (
    <>
      {viewer ? <FileOverlay file={viewer} onClose={() => setViewer(null)} /> : null}
      {message.blocks.map((block, i) => {
        if (block.kind === "meta") {
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13px] text-[var(--qb-muted-2)]"
            >
              <span className="text-[var(--qb-accent)]">◷</span>
              <span>{block.text}</span>
            </div>
          );
        }
        if (block.kind === "progress") {
          // O cabeçalho da conversa já mostra "trabalhando…". Repetir isso numa
          // bolha — e em inglês — era um recado duplicado.
          if (isTurnStartMarker(block.text)) return null;
          return (
            <div key={i} className="flex justify-start">
              <div className={BUBBLE}>
                <ChatMarkdown streaming>{block.text}</ChatMarkdown>
              </div>
            </div>
          );
        }
        if (block.kind === "text" && author && groupLayout) {
          return (
            <GroupReply key={i} author={author}>
              <div className={BUBBLE}>
                <ChatMarkdown>{stripPeerCue(block.text)}</ChatMarkdown>
              </div>
            </GroupReply>
          );
        }
        if (block.kind === "text" && author) {
          return (
            <div key={i}>
              <div className="mb-1.5 flex items-center justify-center gap-1.5 text-[13px] text-[var(--qb-muted-2)]">
                <span>Mensagem de</span>
                <BotAvatar color={author.color} shape={author.shape} size={16} />
                <span>{author.name}</span>
              </div>
              <div className="flex justify-start">
                <div className={BUBBLE}>
                  <ChatMarkdown>{stripPeerCue(block.text)}</ChatMarkdown>
                </div>
              </div>
              {authorNote ? (
                <div className="mt-1.5 flex items-center justify-center gap-1.5 text-[13px] text-[var(--qb-muted-2)]">
                  <span>Mensagem para</span>
                  <BotAvatar color={author.color} shape={author.shape} size={16} />
                  <span>{author.name}</span>
                </div>
              ) : null}
            </div>
          );
        }
        if (block.kind === "text" && message.role === "user") {
          const collapsed = block.text.length > USER_COLLAPSE_CHARS;
          return (
            <div key={i} className="qb-msg-in group flex justify-end">
              <div className="flex flex-col items-end gap-1">
                {quoted ? <Quoted text={quoted} mine /> : null}
                <div className="flex items-end gap-1.5">
                  <MessageActions text={block.text} onReply={onReply} onReact={onReact} />
                  <div className="qb-msg-bubble w-fit max-w-[520px] rounded-[var(--qb-r-lg)] bg-[var(--qb-ink-strong)] px-4 py-[10px] text-[15px] leading-[1.48] text-[var(--qb-canvas)]">
                    <div
                      className={
                        collapsed
                          ? "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"
                          : undefined
                      }
                    >
                      {block.text}
                    </div>
                  </div>
                </div>
                <Reactions reactions={message.reactions} onReact={onReact} />
                {canEdit || (versionCount && versionCount > 1) ? (
                  <div className="flex items-center gap-2 pr-1 text-[13px] text-[var(--qb-muted)]">
                    {versionCount && versionCount > 1 && onSwitchBranch ? (
                      <>
                        <button type="button" onClick={() => onSwitchBranch(-1)}>
                          ‹
                        </button>
                        <span>
                          {(versionIndex ?? 0) + 1}/{versionCount}
                        </span>
                        <button type="button" onClick={() => onSwitchBranch(1)}>
                          ›
                        </button>
                      </>
                    ) : null}
                    {canEdit && onEdit ? (
                      <button type="button" onClick={() => onEdit(block.text)}>
                        Editar
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          );
        }
        if (block.kind === "text") {
          return (
            <div key={i} className="qb-msg-in group flex items-start justify-start">
              <div className="min-w-0">
                {quoted ? <Quoted text={quoted} /> : null}
                <div className={BUBBLE}>
                  <ChatMarkdown>{block.text}</ChatMarkdown>
                </div>
                <Reactions reactions={message.reactions} onReact={onReact} />
              </div>
              <MessageActions text={block.text} onReply={onReply} onReact={onReact} />
            </div>
          );
        }
        if (block.kind === "file") {
          const mine = message.role === "user";
          return (
            <div key={i} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className="flex max-w-[min(78%,520px)] flex-col gap-1.5">
                {block.mimeType.startsWith("video/") ? (
                  // Vídeo toca no fio: mandar um vídeo é para ser visto, não baixado.
                  <video
                    src={fileUrl(block.artifactId)}
                    controls
                    preload="metadata"
                    className="block max-h-[420px] w-auto rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)]"
                  >
                    {/* Gravação de tela não tem falas nem trilha de legenda. */}
                    <track kind="captions" />
                  </video>
                ) : block.mimeType.startsWith("audio/") ? (
                  <audio src={fileUrl(block.artifactId)} controls className="w-[280px]">
                    <track kind="captions" />
                  </audio>
                ) : block.image ? (
                  // Abre no visualizador do app, não numa aba nova.
                  <button
                    type="button"
                    aria-label={`Abrir ${block.name}`}
                    onClick={() =>
                      setViewer({
                        artifactId: block.artifactId,
                        name: block.name,
                        mimeType: block.mimeType,
                        size: block.size,
                      })
                    }
                    className="cursor-zoom-in border-0 bg-transparent p-0 text-left"
                  >
                    <img
                      src={fileUrl(block.artifactId)}
                      alt={block.caption ?? block.name}
                      className="block max-h-[420px] w-auto rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)]"
                    />
                  </button>
                ) : opensInViewer(block) ? (
                  // Abre para ler ou tocar aqui dentro; o download fica no overlay.
                  <button
                    type="button"
                    aria-label={`Abrir ${block.name}`}
                    onClick={() =>
                      setViewer({
                        artifactId: block.artifactId,
                        name: block.name,
                        mimeType: block.mimeType,
                        size: block.size,
                      })
                    }
                    className="flex cursor-pointer items-center gap-3 rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-4 py-3 text-left"
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--qb-r-sm)] bg-[var(--qb-tile)] text-[var(--qb-muted)]">
                      <Icon name="paperclip" size={18} />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[15px] font-semibold text-[var(--qb-ink)]">
                        {block.name}
                      </span>
                      <span className="text-[13px] text-[var(--qb-muted)]">
                        {formatBytes(block.size)}
                      </span>
                    </span>
                  </button>
                ) : (
                  <a
                    href={fileUrl(block.artifactId)}
                    download={block.name}
                    className="flex items-center gap-3 rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-4 py-3 no-underline"
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--qb-r-sm)] bg-[var(--qb-tile)] text-[var(--qb-muted)]">
                      <Icon name="paperclip" size={18} />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[15px] font-semibold text-[var(--qb-ink)]">
                        {block.name}
                      </span>
                      <span className="text-[13px] text-[var(--qb-muted)]">
                        {formatBytes(block.size)}
                      </span>
                    </span>
                  </a>
                )}
                {block.caption ? (
                  <span className="text-[13px] text-[var(--qb-muted)]">{block.caption}</span>
                ) : null}
              </div>
            </div>
          );
        }
        if (block.kind === "card") {
          return (
            <div key={i} className="flex justify-start">
              <div className="flex flex-col gap-2 rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-5 py-4">
                {block.lines.map((line) => (
                  <div
                    key={line.k}
                    className="flex items-baseline gap-2.5 text-[15px] text-[var(--qb-ink)]"
                  >
                    <span className="text-[#34C759]">✓</span>
                    <span className="font-semibold">{line.k}</span>
                    <span className="text-[var(--qb-muted-2)]">→</span>
                    <span className="rk-mono text-[13px] text-[var(--qb-ink)]">{line.v}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        if (block.kind === "ask") {
          const settled = Boolean(block.answered);
          const toolAsk = Boolean(block.tool);
          const ask = (
            <div
              key={i}
              className="qb-msg-in max-w-[min(440px,90%)] rounded-[var(--qb-r-lg)] border border-[#D8E9FC] bg-[#F4F8FD] px-5 py-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-[16px] leading-[1.4] font-semibold text-[var(--qb-ink)]">
                  {toolAsk ? "Aprovação" : <ChatMarkdown>{block.text}</ChatMarkdown>}
                </div>
                {block.tool ? (
                  <span className="rk-mono rounded-full bg-[var(--qb-hairline)] px-2.5 py-1 text-[12px] text-[var(--qb-muted)]">
                    {block.tool}
                  </span>
                ) : null}
              </div>
              {toolAsk ? (
                <div className="mt-1.5 text-[15px] text-[var(--qb-muted)]">{block.text}</div>
              ) : null}
              {block.detail ? (
                <pre className="mt-3 overflow-x-auto rounded-[var(--qb-r-md)] bg-[var(--qb-surface-2)] px-3.5 py-3 text-[13px] leading-[1.7] text-[var(--qb-ink)]">
                  {block.detail}
                </pre>
              ) : null}
              {block.held ? (
                <div className="mt-2 text-[13px] text-[#FF9F0A]">{block.held}</div>
              ) : null}
              {settled ? (
                <div className="mt-3 text-[15px] text-[var(--qb-muted)]">
                  {block.answered === "deny" || block.answered === "denied"
                    ? "Recusado"
                    : block.answered === "always"
                      ? "Sempre permitido"
                      : "Permitido"}
                </div>
              ) : askActive === false ? (
                // Sem isso, clicar num card antigo devolvia "Run is not waiting
                // for an answer" — o pedido tinha ficado para trás.
                <div className="mt-3 text-[15px] text-[var(--qb-muted)]">
                  Este pedido não vale mais. O bot seguiu sem ele.
                </div>
              ) : (
                <div className="mt-3.5 flex flex-wrap gap-2">
                  {toolAsk ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onAnswer("deny")}
                        className="rounded-full bg-[var(--qb-hairline)] px-4 py-2.5 text-[15px] text-[var(--qb-ink)]"
                      >
                        Recusar
                      </button>
                      {offersAlways(block) ? (
                        <button
                          type="button"
                          onClick={() => onAnswer("always")}
                          className="rounded-full bg-[var(--qb-hairline)] px-4 py-2.5 text-[15px] text-[var(--qb-ink)]"
                        >
                          Sempre permitir
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => onAnswer("allow")}
                        className="flex items-center gap-1.5 rounded-full bg-[var(--qb-ink-strong)] px-4 py-2.5 text-[15px] font-medium text-[var(--qb-canvas)]"
                      >
                        Permitir
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onAnswer("approved")}
                        className="flex items-center gap-1.5 rounded-full bg-[var(--qb-ink-strong)] px-4 py-2.5 text-[15px] font-medium text-[var(--qb-canvas)]"
                      >
                        <span className="text-[#30D158]">✓</span>
                        Enviar
                      </button>
                      <button
                        type="button"
                        onClick={() => onPrefill?.(block.detail ?? block.text)}
                        className="rounded-full bg-[var(--qb-hairline)] px-4 py-2.5 text-[15px] text-[var(--qb-ink)]"
                      >
                        Editar primeiro
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
          return author && groupLayout ? (
            <GroupReply key={i} author={author}>
              {ask}
            </GroupReply>
          ) : (
            <div key={i}>{ask}</div>
          );
        }
        if (block.kind === "computer") {
          return (
            <ComputerHandoffCard
              key={i}
              state={block.state}
              text={block.text}
              active={Boolean(computerHandoffActive)}
              preview={computerPreview}
              previewLabel={computerPreviewLabel}
              busy={computerBusy}
              onOpen={onOpenComputer}
              onTakeOver={onTakeOverComputer}
            />
          );
        }
        if (block.kind === "subagent") {
          const running = block.status === "running";
          const failed = block.status === "failed";
          return (
            <div
              key={i}
              className="w-[min(420px,90%)] rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-[18px] py-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[16px] font-semibold text-[var(--qb-ink)]">{block.name}</span>
                <span
                  className="rounded-full px-3 py-1 text-[14px]"
                  style={{
                    background: failed
                      ? "rgba(255,69,58,.16)"
                      : running
                        ? "rgba(255,159,10,.16)"
                        : "rgba(52,199,89,.16)",
                    color: failed ? "#FF453A" : running ? "#FF9F0A" : "#34C759",
                  }}
                >
                  {failed ? "falhou" : running ? "subagente" : "concluído"}
                </span>
              </div>
              <div className="mt-1.5 text-[14px] text-[var(--qb-muted-2)]">{block.task}</div>
              {block.progress || block.result ? (
                <div className="mt-2.5 text-[15px] leading-[1.5] text-[var(--qb-ink)]">
                  <ChatMarkdown streaming={running}>
                    {block.result || block.progress || ""}
                  </ChatMarkdown>
                </div>
              ) : null}
            </div>
          );
        }
        if (block.kind === "child_bot") {
          const deleted = block.status === "deleted";
          return (
            <button
              key={i}
              type="button"
              disabled={deleted || !onOpenBot}
              onClick={() => onOpenBot?.(block.botId)}
              className="w-[min(340px,90%)] rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-[18px] py-4 text-left disabled:opacity-60"
            >
              <div className="flex items-center justify-between">
                <span className="text-[16px] font-semibold text-[var(--qb-ink)]">{block.name}</span>
                <span
                  className="rounded-full px-3 py-1 text-[14px]"
                  style={{
                    background: deleted ? "rgba(255,69,58,.16)" : "rgba(52,199,89,.16)",
                    color: deleted ? "#FF453A" : "#34C759",
                  }}
                >
                  {deleted ? "removido" : "bot"}
                </span>
              </div>
              <div className="mt-1.5 text-[15px] leading-[1.5] text-[var(--qb-muted-2)]">
                {deleted
                  ? "Bot removido, incluindo chat, computador e memória."
                  : block.title || "Tem o próprio chat. Toque para abrir."}
              </div>
            </button>
          );
        }
        return null;
      })}
    </>
  );
}

const GROUP_MARK = 32;

function GroupReply({ author, children }: { author: MessageAuthor; children: ReactNode }) {
  return (
    <div className="flex items-start justify-start gap-2.5">
      <div className="flex w-8 shrink-0 justify-start pt-0.5">
        <BotAvatar
          color={author.color}
          shape={author.shape}
          size={GROUP_MARK}
          className="shrink-0"
        />
      </div>
      <div className="min-w-0">
        <div className="mb-1 text-[15px] leading-none text-[var(--qb-muted)]">{author.name}</div>
        {children}
      </div>
    </div>
  );
}

/** Closes a run of replies when more than one agent spoke into the thread. */
export function BurstSummary({
  messages,
  authors,
}: {
  messages: number;
  authors: MessageAuthor[];
}) {
  return (
    <div className="flex items-center justify-center gap-2 py-1.5 text-[15px] text-[var(--qb-muted-2)]">
      <span>
        {messages} {messages === 1 ? "mensagem" : "mensagens"} com
      </span>
      <span className="flex items-center gap-1">
        {authors.map((author) => (
          <BotAvatar key={author.id} color={author.color} shape={author.shape} size={18} />
        ))}
      </span>
      <span>
        {authors.length} {authors.length === 1 ? "agente" : "agentes"}
      </span>
    </div>
  );
}
