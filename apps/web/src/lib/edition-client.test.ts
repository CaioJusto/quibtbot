import { describe, expect, it } from "vitest";
import {
  defaultSourceLabel,
  modelSourceBody,
  planSwitchDone,
  planSwitchLabel,
  resolveClientEdition,
} from "./edition-client.js";

describe("resolveClientEdition", () => {
  it("obeys health, then me, then billing", () => {
    expect(resolveClientEdition({ health: { edition: "oss" }, billing: { enabled: true } })).toBe(
      "oss",
    );
    expect(resolveClientEdition({ me: { edition: "cloud" }, billing: { enabled: false } })).toBe(
      "cloud",
    );
    expect(resolveClientEdition({ billing: { enabled: true } })).toBe("cloud");
    expect(resolveClientEdition({})).toBe("oss");
  });
});

describe("model source copy", () => {
  const creds = [{ label: "ChatGPT Plus/Pro", isDefault: true }];

  it("names the credential that is actually paying", () => {
    expect(defaultSourceLabel(creds, "oss")).toBe("ChatGPT Plus/Pro");
    expect(defaultSourceLabel(creds, "cloud")).toBe("ChatGPT Plus/Pro");
  });

  it("never offers Quibt tokens on a deploy that sells none", () => {
    // Open Source has no plan quota: saying so would be a lie on every self-host.
    expect(defaultSourceLabel([], "oss")).toBe("Nenhuma chave sua");
    expect(defaultSourceLabel([], "cloud")).toBe("Tokens do plano Quibt");
    expect(modelSourceBody(false, "oss")).toContain(".env");
    expect(modelSourceBody(false, "oss")).not.toContain("plano Quibt");
    expect(modelSourceBody(false, "cloud")).toContain("plano Quibt");
  });

  it("keeps the credential wording free of plan talk on Open Source", () => {
    expect(modelSourceBody(true, "oss")).not.toContain("tokens do plano");
    expect(modelSourceBody(true, "cloud")).toContain("tokens do plano");
  });

  it("names what the switch really goes back to", () => {
    expect(planSwitchLabel("cloud")).toBe("Voltar aos tokens do plano");
    expect(planSwitchLabel("oss")).toBe("Voltar à chave do deploy");
    expect(planSwitchDone("oss")).toContain(".env");
    expect(planSwitchDone("cloud")).toContain("plano Quibt");
  });
});
