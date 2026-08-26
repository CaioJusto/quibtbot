export type ChatMarkdownProps = {
  children: string;
  streaming?: boolean;
};

const protocolPattern = /^([a-z][a-z\d+.-]*):/i;
const safeProtocols = new Set(["http", "https", "mailto", "tel"]);

export function sanitizeMarkdownUrl(url: string, allowRelative = false): string | undefined {
  const value = url.trim();
  const protocol = value.match(protocolPattern)?.[1]?.toLowerCase();

  if (protocol) return safeProtocols.has(protocol) ? value : undefined;
  if (
    allowRelative &&
    (value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.startsWith("#"))
  ) {
    return value;
  }
  return undefined;
}

export function closeUnterminatedFence(markdown: string): string {
  let openFence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of markdown.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match?.[1]) continue;

    const marker = match[1][0] as "`" | "~";
    if (!openFence) {
      openFence = { marker, length: match[1].length };
      continue;
    }

    if (
      marker === openFence.marker &&
      match[1].length >= openFence.length &&
      (match[2] ?? "").trim() === ""
    ) {
      openFence = undefined;
    }
  }

  return openFence ? `${markdown}\n${openFence.marker.repeat(openFence.length)}` : markdown;
}

/**
 * O bloco de código na tela: o rótulo da linguagem e o texto para copiar.
 *
 * O que chega aqui é o nó do `<code>` na árvore do documento que o react-markdown montou,
 * não o markdown cru. Ler dali evita percorrer o texto uma segunda vez com outra gramática —
 * e o que o botão copia é exatamente o que a caixa mostra.
 */

type CodeNode = {
  type?: string;
  value?: unknown;
  tagName?: string;
  properties?: { className?: unknown } | null;
  children?: readonly unknown[] | null;
};

/** Todo o texto dentro do nó, na ordem, sem os acentos graves da cerca. */
export function codeBlockText(node: unknown): string {
  const current = node as CodeNode | null | undefined;
  if (!current) return "";
  if (typeof current.value === "string") return current.value;
  return (current.children ?? []).map((child) => codeBlockText(child)).join("");
}

/** A linguagem escrita depois da cerca (```ts), que vira a classe `language-ts`. */
export function languageOfCodeNode(node: unknown): string | undefined {
  const classes = (node as CodeNode | null | undefined)?.properties?.className;
  const list = Array.isArray(classes) ? classes : typeof classes === "string" ? [classes] : [];
  for (const entry of list) {
    if (typeof entry !== "string" || !entry.startsWith("language-")) continue;
    const name = entry.slice("language-".length).trim().toLowerCase();
    if (name) return name;
  }
  return undefined;
}

/** Nomes que a pessoa reconhece; o resto vale como está escrito, em minúsculas. */
const LANGUAGE_NAMES: Record<string, string> = {
  bash: "bash",
  sh: "shell",
  shell: "shell",
  zsh: "shell",
  js: "JavaScript",
  jsx: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  typescript: "TypeScript",
  py: "Python",
  python: "Python",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  md: "Markdown",
  markdown: "Markdown",
  diff: "diff",
};

/** Bloco sem linguagem declarada continua sendo um bloco: o rótulo diz "texto". */
export function languageLabel(language: string | undefined): string {
  if (!language) return "texto";
  return LANGUAGE_NAMES[language] ?? language;
}
