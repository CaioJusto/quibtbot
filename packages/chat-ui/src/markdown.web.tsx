import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown.web.css";
import {
  type ChatMarkdownProps,
  closeUnterminatedFence,
  codeBlockText,
  languageLabel,
  languageOfCodeNode,
  sanitizeMarkdownUrl,
} from "./markdown";

/**
 * Copiar o bloco de código.
 *
 * Um bloco de código é para sair da conversa e entrar num terminal. Selecionar com o rato
 * dentro de uma caixa que rola de lado quase sempre leva junto meia linha a mais ou a menos,
 * então o botão manda o texto inteiro — o mesmo que o modelo escreveu, sem o rótulo da
 * linguagem e sem os acentos graves.
 *
 * O "Copiado" vem de um atributo no próprio botão, e não de um estado de React: este pacote
 * é montado tanto pelo app web quanto pelo do celular, e mantê-lo sem hooks é o que o deixa
 * indiferente a qual cópia do React o empacotador escolheu. Se a resposta for redesenhada no
 * meio do aviso, o botão volta a dizer "Copiar" — que é o certo depois de um segundo.
 */
function CopyCode({ text }: { text: string }) {
  return (
    <button
      type="button"
      className="rk-code__copy"
      aria-label="Copiar o código"
      onClick={(event) => {
        const button = event.currentTarget;
        void navigator.clipboard?.writeText(text);
        button.dataset.copied = "sim";
        window.setTimeout(() => {
          delete button.dataset.copied;
        }, 1400);
      }}
    >
      <span className="rk-code__copy-idle">Copiar</span>
      <span className="rk-code__copy-done">Copiado</span>
    </button>
  );
}

const components: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noreferrer noopener" />;
  },
  img({ node: _node, ...props }) {
    return <img {...props} alt={props.alt ?? ""} loading="lazy" />;
  },
  /**
   * A barra em cima do código diz em que linguagem ele está e traz o copiar. O `<pre>` em si
   * continua sendo desenhado pelo react-markdown: o rótulo e o botão saem da árvore do
   * documento (o `node`), e não de uma segunda leitura do markdown.
   */
  pre({ node, children }) {
    const code = node?.children?.find(
      (child) => child.type === "element" && child.tagName === "code",
    );
    const text = codeBlockText(code);
    return (
      <div className="rk-code">
        <div className="rk-code__bar">
          <span className="rk-code__lang">{languageLabel(languageOfCodeNode(code))}</span>
          <CopyCode text={text} />
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
};

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
}: ChatMarkdownProps) {
  const source = streaming ? closeUnterminatedFence(children) : children;

  return (
    <div className={streaming ? "rk-chat-markdown rk-chat-markdown-streaming" : "rk-chat-markdown"}>
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => sanitizeMarkdownUrl(url, true) ?? ""}
      >
        {source}
      </ReactMarkdown>
      {streaming ? <span aria-hidden="true" className="rk-chat-markdown-cursor" /> : null}
    </div>
  );
});

export type { ChatMarkdownProps } from "./markdown";
