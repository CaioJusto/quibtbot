import { describe, expect, it } from "vitest";
import {
  closeUnterminatedFence,
  codeBlockText,
  languageLabel,
  languageOfCodeNode,
  sanitizeMarkdownUrl,
} from "./markdown";

describe("sanitizeMarkdownUrl", () => {
  it("allows normal external links and optionally allows local links", () => {
    expect(sanitizeMarkdownUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(sanitizeMarkdownUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(sanitizeMarkdownUrl("/docs", true)).toBe("/docs");
    expect(sanitizeMarkdownUrl("#section", true)).toBe("#section");
  });

  it("rejects executable and embedded-data URLs", () => {
    expect(sanitizeMarkdownUrl("javascript:alert(1)", true)).toBeUndefined();
    expect(sanitizeMarkdownUrl("data:text/html,<script>alert(1)</script>", true)).toBeUndefined();
    expect(sanitizeMarkdownUrl("/docs")).toBeUndefined();
  });
});

describe("closeUnterminatedFence", () => {
  it("temporarily closes a partial streaming code fence", () => {
    expect(closeUnterminatedFence("Before\n```ts\nconst value = 1;")).toBe(
      "Before\n```ts\nconst value = 1;\n```",
    );
  });

  it("leaves complete markdown unchanged", () => {
    const markdown = "```ts\nconst value = 1;\n```\n\nDone";
    expect(closeUnterminatedFence(markdown)).toBe(markdown);
  });
});

describe("bloco de código", () => {
  const node = {
    type: "element",
    tagName: "code",
    properties: { className: ["language-ts"] },
    children: [
      { type: "text", value: "const bot = " },
      { type: "element", tagName: "span", children: [{ type: "text", value: '"Cubee";' }] },
    ],
  };

  it("copia o texto inteiro do bloco, sem os acentos graves da cerca", () => {
    expect(codeBlockText(node)).toBe('const bot = "Cubee";');
    expect(codeBlockText(undefined)).toBe("");
  });

  it("lê a linguagem que veio depois da cerca", () => {
    expect(languageOfCodeNode(node)).toBe("ts");
    expect(languageOfCodeNode({ properties: { className: "language-Python" } })).toBe("python");
    expect(
      languageOfCodeNode({ properties: { className: ["contains-task-list"] } }),
    ).toBeUndefined();
    expect(languageOfCodeNode({})).toBeUndefined();
  });

  it("mostra um nome que a pessoa reconhece, e 'texto' quando não foi declarada", () => {
    expect(languageLabel("ts")).toBe("TypeScript");
    expect(languageLabel("sh")).toBe("shell");
    expect(languageLabel("rust")).toBe("rust");
    expect(languageLabel(undefined)).toBe("texto");
  });
});
