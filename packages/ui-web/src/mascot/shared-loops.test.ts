import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));

function source(relative: string) {
  return readFileSync(path.join(dir, relative), "utf8");
}

/**
 * A screen full of bots used to mount one or two rAF loops and one unthrottled
 * `pointermove` listener per avatar. These are the wiring facts that keep it at one of
 * each for the whole page; the behaviour of the primitives is covered by
 * frame-loop / pointer-tracker / visibility tests.
 */
describe("mascot animation is shared, not per avatar", () => {
  it("draws faces from the shared loop and stops while the avatar is off screen", () => {
    const engine = source("./faceEngine.tsx");
    expect(engine).toContain("onAnimationFrame");
    expect(engine).toContain("onVisibilityChange");
    expect(engine).not.toContain("requestAnimationFrame(");
    expect(engine).not.toContain("cancelAnimationFrame(");
    expect(engine).toContain("if (!onScreen || paused) return");
  });

  it("wanders from the shared loop instead of its own rAF", () => {
    const wander = source("./wander-look.ts");
    expect(wander).toContain("onAnimationFrame");
    expect(wander).not.toContain("requestAnimationFrame(");
    expect(wander).not.toContain("cancelAnimationFrame(");
  });

  it("follows the pointer through the shared, throttled listener", () => {
    const look = source("./use-pointer-look.ts");
    expect(look).toContain("onPointerMove");
    expect(look).toContain("onVisibilityChange");
    expect(look).not.toContain('addEventListener("pointermove"');
    expect(look).not.toContain("removeEventListener");
  });

  it("does not mount a pointer or rAF loop on each raster avatar", () => {
    const mark = source("./agent-mark.tsx");
    expect(mark).toContain("rasterMascotSrc");
    expect(mark).toContain("quibt-mascot-idle");
    expect(mark).not.toContain("requestAnimationFrame(");
    expect(mark).not.toContain("usePointerLook");
    expect(mark).not.toContain("faceEngine");
  });
});
