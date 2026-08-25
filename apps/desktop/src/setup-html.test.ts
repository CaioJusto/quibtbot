import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const setupHtml = readFileSync(path.resolve(import.meta.dirname, "../setup.html"), "utf8");

describe("desktop setup navigation", () => {
  it("opens the local installation flow from the primary choice", () => {
    expect(setupHtml).toContain(
      'document.getElementById("choose-local")?.addEventListener("click"',
    );
    expect(setupHtml).toContain('show("local")');
  });

  it("uses the Quibt visual system and keeps form controls accessible", () => {
    expect(setupHtml).toContain('src="./quibt-team.png"');
    expect(setupHtml).toContain("mode-card--primary");
    expect(setupHtml).toContain('input:not([type="checkbox"])');
    expect(setupHtml).toContain(":focus-visible");
    expect(setupHtml).toContain('ok === true ? "ok" : ok === false ? "bad" : "working"');
    expect(setupHtml).toContain("startButton.disabled = true");
    expect(setupHtml).toContain("startButton.disabled = false");
    expect(setupHtml).toContain('id="local-pairing"');
    expect(setupHtml).toContain('id="open-after-install"');
    expect(setupHtml).toContain("desktop.completeLocalPairing?.()");
    expect(setupHtml).toContain(
      "A instalação remota será liberada quando o manifesto deste release estiver pronto.",
    );
  });
});
