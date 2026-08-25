import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "Account.tsx"),
  "utf8",
);

describe("account model source card", () => {
  it("asks the server which edition this deploy is", () => {
    expect(src).toContain("resolveClientEdition({ health, me, billing: snap })");
  });

  it("never hardcodes plan-token copy on a deploy that sells no tokens", () => {
    expect(src).toContain("defaultSourceLabel(credentials, edition)");
    expect(src).toContain("modelSourceBody(");
    expect(src).toContain("planSwitchLabel(edition)");
    expect(src).toContain("planSwitchDone(edition)");
    expect(src).not.toContain("Seus bots usam a cota mensal de tokens do plano Quibt.");
    expect(src).not.toContain('"Voltar aos tokens do plano"');
  });
});

describe("changing the AI provider from Conta", () => {
  it("offers the three sources, a provider, a model and a key — not only the sign-in buttons", () => {
    // Antes disso, trocar de provedor só existia no onboarding: quem já tinha passado por
    // ele ficava preso ao modelo daquele dia, sem lugar no app para colar outra chave.
    expect(src).toContain("pickTokenSource(mode)");
    expect(src).toContain("Chave OpenRouter");
    expect(src).toContain("Modelo local");
    expect(src).toContain("Minha assinatura");
    expect(src).toContain("pickProvider(e.target.value)");
    expect(src).toContain("setModelId(e.target.value)");
    expect(src).toContain("rpc.models.connect(");
  });

  it("points the bots at what was just connected, instead of only storing the key", () => {
    expect(src).toContain("rpc.models.setDefault({ provider, modelId: selectedModel.id })");
  });

  it("reuses the shared choice helpers, so Conta and o onboarding não divergem", () => {
    expect(src).toContain("providersForMode(");
    expect(src).toContain("chooseProvider(");
    expect(src).toContain("chooseMode(");
    expect(src).toContain("localModelUrl(provider)");
  });

  it("segue a ordem do onboarding: assinatura, chave OpenRouter, modelo local", () => {
    const subscription = src.indexOf('["subscription", "Minha assinatura"]');
    const key = src.indexOf('["key", "Chave OpenRouter"]');
    const local = src.indexOf('["local", "Modelo local"]');
    expect(subscription).toBeGreaterThan(-1);
    expect(subscription).toBeLessThan(key);
    expect(key).toBeLessThan(local);
    expect(src).not.toContain("Claude");
  });

  it("confirma a chave que o servidor conferiu e aponta onde ela nasce", () => {
    expect(src).toContain("Chave confirmada ✓");
    expect(src).toContain('href="https://openrouter.ai/keys"');
    expect(src).toContain("Você paga por uso na sua conta OpenRouter");
  });
});

describe("conta sem e-mail e sem senha", () => {
  it("não mostra campos de credenciais que nenhuma tela do produto pede", () => {
    // A entrada é pelo teclado do computador (primeira conta) ou pelo código aprovado.
    // Um formulário de e-mail/senha aqui prometia credenciais que não existem mais.
    expect(src).not.toContain("saveEmail");
    expect(src).not.toContain("savePassword");
    expect(src).not.toContain("Senha atual");
    expect(src).not.toContain("Reenviar verificação");
    // Sair e apagar a conta continuam na aba Segurança.
    expect(src).toContain("Sair desta conta");
    expect(src).toContain("Apagar minha conta");
  });
});
