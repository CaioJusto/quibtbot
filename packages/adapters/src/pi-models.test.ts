import { describe, expect, it } from "vitest";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";

describe("Pi model catalog", () => {
  it("lists real Pi providers instead of a two-option dropdown", () => {
    const catalog = listPiCatalog();
    const providers = new Set(catalog.map((entry) => entry.provider));
    expect(catalog.length).toBeGreaterThan(20);
    expect(providers.has("openrouter")).toBe(true);
    expect(providers.size).toBeGreaterThan(5);
    expect(
      catalog.some(
        (entry) => entry.auth === "oauth" || entry.auth === "both" || entry.subscription,
      ),
    ).toBe(true);
    expect(scriptedCatalogEntry.provider).toBe("scripted");
  });
});

describe("defaultModelForProvider", () => {
  it("answers with a model of that provider, never the global env default", async () => {
    const { defaultModelForProvider, listPiCatalog } = await import("./pi-models.js");
    const xai = defaultModelForProvider("xai");
    expect(xai).toBeTruthy();
    expect(listPiCatalog().some((e) => e.provider === "xai" && e.id === xai)).toBe(true);
    expect(defaultModelForProvider("nao-existe")).toBeUndefined();
  });
});
