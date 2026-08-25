import { MARK_SHAPES } from "@quibt/ui-tokens";
import { describe, expect, it } from "vitest";
import { motionFromSeed, styleSeed } from "./motion-seed.js";

describe("motionFromSeed", () => {
  it("gives each lab style its own phase, tempo, and glance", () => {
    const clocks = MARK_SHAPES.map((id) => motionFromSeed(styleSeed(id), id));
    const phases = new Set(clocks.map((clock) => clock.phase));
    const rates = new Set(clocks.map((clock) => clock.rate.toFixed(2)));
    const bobs = new Set(clocks.map((clock) => clock.bob.toFixed(2)));
    const sways = new Set(clocks.map((clock) => clock.sway.toFixed(2)));
    expect(phases.size).toBeGreaterThan(6);
    expect(rates.size).toBeGreaterThan(6);
    expect(bobs.size).toBeGreaterThan(6);
    expect(sways.size).toBeGreaterThan(6);
    expect(clocks.every((clock) => clock.rate >= 0.45 && clock.rate <= 0.9)).toBe(true);
    expect(clocks.every((clock) => clock.bobPeriod >= 1.4)).toBe(true);
    expect(clocks.every((clock) => clock.swayPeriod >= 1.5)).toBe(true);
  });

  it("keeps the landing row calm and distinct — not a chorus, not a loading spinner", () => {
    const row = ["strobi", "freddy", "citrus", "kirby", "cloudee"].map((id) =>
      motionFromSeed(styleSeed(id), id),
    );
    const rates = row.map((clock) => clock.rate);
    const bobs = row.map((clock) => clock.bob);
    const sways = row.map((clock) => clock.sway);
    expect(new Set(rates.map((n) => n.toFixed(2))).size).toBe(5);
    expect(Math.max(...bobs) - Math.min(...bobs)).toBeGreaterThan(0.25);
    expect(Math.max(...sways) - Math.min(...sways)).toBeGreaterThan(0.25);
    expect(Math.max(...rates)).toBeLessThan(0.85);
    expect(row.every((clock) => clock.bob <= 0.55)).toBe(true);
  });
});
