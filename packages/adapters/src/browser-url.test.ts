import { describe, expect, it } from "vitest";
import { browserOpenCommand, normalizeBrowserUrl } from "./browser-url.js";

describe("browser URL navigation", () => {
  it("normalizes ordinary pages and keeps query parameters inside one argv value", () => {
    expect(normalizeBrowserUrl("quibt.com/novidades")).toBe("https://quibt.com/novidades");
    expect(browserOpenCommand("https://example.com/search?q=quibt&tab=apps")).toEqual([
      "xdg-open",
      "https://example.com/search?q=quibt&tab=apps",
    ]);
  });

  it.each([
    "",
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///home/quibt/.env",
    "https://user:password@example.com",
    "https://example.com/\nnext",
  ])("rejects non-page or credential-bearing input: %s", (url) => {
    expect(normalizeBrowserUrl(url)).toBeNull();
    expect(browserOpenCommand(url)).toBeNull();
  });
});
