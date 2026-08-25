import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  currentSourceLabel,
  deviceSignInOptions,
  modelSourceBody,
  planSwitchDone,
  planSwitchLabel,
  usingOwnCredential,
} from "./model-source-core";

const dir = path.dirname(fileURLToPath(import.meta.url));

describe("model source helpers", () => {
  it("keeps one sign-in option per device-code provider", () => {
    const options = deviceSignInOptions([
      {
        provider: "openai-codex",
        id: "gpt-5",
        oauthLabel: "Entrar com ChatGPT Plus/Pro",
        signIn: "device-code",
      },
      {
        provider: "openai-codex",
        id: "gpt-5-mini",
        oauthLabel: "Entrar com ChatGPT Plus/Pro",
        signIn: "device-code",
      },
      {
        provider: "github-copilot",
        id: "gpt-5",
        providerName: "GitHub Copilot",
        signIn: "device-code",
      },
      { provider: "openrouter", id: "deepseek/deepseek-v4" },
    ]);
    expect(options.map((option) => option.provider)).toEqual(["openai-codex", "github-copilot"]);
    expect(options[0]?.label).toBe("Entrar com ChatGPT Plus/Pro");
    expect(options[1]?.label).toBe("GitHub Copilot");
  });

  it("labels the plan as the source until a credential is default", () => {
    expect(currentSourceLabel([])).toBe("Nenhuma chave ainda");
    expect(currentSourceLabel([], "cloud")).toBe("Tokens do plano Quibt");
    expect(usingOwnCredential([])).toBe(false);
    const creds = [
      { id: "c1", provider: "openai-codex", label: "ChatGPT Plus/Pro", isDefault: true },
    ];
    expect(currentSourceLabel(creds)).toBe("ChatGPT Plus/Pro");
    expect(usingOwnCredential(creds)).toBe(true);
  });
});

describe("mobile model source section", () => {
  const section = readFileSync(path.join(dir, "model-source.tsx"), "utf8");

  it("talks to the same models.* RPCs the web account uses", () => {
    expect(section).toContain('"models/credentials"');
    expect(section).toContain('"models/list"');
    expect(section).toContain('"models/beginOAuth"');
    expect(section).toContain('"models/completeOAuth"');
    expect(section).toContain('"models/usePlan"');
  });

  it("shows the device code and opens the verification link natively", () => {
    expect(section).toContain("Linking.openURL");
    expect(section).toContain("userCode");
    expect(section).toContain("verificationUri");
  });

  it("is reached from the account screen and has its own screen", () => {
    const account = readFileSync(path.join(dir, "../app/account.tsx"), "utf8");
    const screen = readFileSync(path.join(dir, "../app/model.tsx"), "utf8");
    expect(account).toContain('router.push("/model")');
    expect(account).toContain("currentModelSummary");
    expect(screen).toContain("ModelSourceSection");
  });
});

describe("model source copy follows the edition", () => {
  const section = readFileSync(path.join(dir, "model-source.tsx"), "utf8");

  it("passes the edition the label asks for instead of always defaulting to oss", () => {
    // The card used to call currentSourceLabel(credentials) with no edition, so a Cloud
    // account paying with plan tokens read "Nenhuma chave ainda".
    expect(section).toContain("currentSourceLabel(credentials, edition)");
    expect(section).toContain('rpc<{ edition?: "oss" | "cloud" }>("health")');
  });

  it("never promises Quibt tokens on a self-host deploy", () => {
    expect(modelSourceBody(false, "oss")).toContain(".env");
    expect(modelSourceBody(false, "oss")).not.toContain("plano Quibt");
    expect(modelSourceBody(false, "cloud")).toContain("plano Quibt");
    expect(modelSourceBody(true, "oss")).not.toContain("tokens do plano");
    expect(section).toContain("modelSourceBody(own, edition)");
  });

  it("names what the switch really goes back to", () => {
    expect(planSwitchLabel("cloud")).toBe("Voltar aos tokens do plano");
    expect(planSwitchLabel("oss")).toBe("Voltar à chave do deploy");
    expect(planSwitchDone("oss")).toContain(".env");
    expect(section).toContain("planSwitchDone(edition)");
    expect(section).toContain("planSwitchLabel(edition)");
  });
});
