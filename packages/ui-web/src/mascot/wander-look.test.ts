import { MARK_SHAPES } from "@quibt/ui-tokens";
import { describe, expect, it } from "vitest";
import { styleSeed } from "./motion-seed.js";
import { buildWanderPlaylist, type Glance, playlistDuration, wanderGazeAt } from "./wander-look.js";

const KINDS = ["rest", "left", "right", "up", "down", "think"] as const;

describe("wander look", () => {
  it("plays rest, side, up, down and think — not a single stare", () => {
    for (const id of MARK_SHAPES) {
      const kinds = new Set(buildWanderPlaylist(styleSeed(id), id).map((step) => step.kind));
      for (const kind of KINDS) expect(kinds.has(kind)).toBe(true);
    }
  });

  it("holds long enough to read as looking, then eases — not a twitch", () => {
    const playlist = buildWanderPlaylist(styleSeed("loom"), "loom");
    const [opening, ...rest] = playlist;
    expect(opening?.kind).toBe("rest");
    expect(opening!.holdMs).toBeGreaterThanOrEqual(700);
    expect(opening!.holdMs).toBeLessThan(2200);
    expect(rest.every((step) => step.holdMs >= 2000)).toBe(true);
    expect(playlist.every((step) => step.moveMs >= 350 && step.moveMs <= 800)).toBe(true);
    const think = playlist.find((step) => step.kind === "think");
    expect(think?.holdMs).toBeGreaterThan(4000);
  });

  it("keeps every glance on the face", () => {
    for (const id of MARK_SHAPES) {
      for (const step of buildWanderPlaylist(styleSeed(id), id)) {
        expect(Math.abs(step.gaze.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(step.gaze.y)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("thinks up and to the side", () => {
    const think = buildWanderPlaylist(styleSeed("grok"), "grok").find(
      (step) => step.kind === "think",
    );
    expect(think).toBeTruthy();
    expect(think!.gaze.y).toBeLessThan(-0.55);
    expect(Math.abs(think!.gaze.x)).toBeGreaterThan(0.4);
  });

  it("looks down as its own beat, not a rest", () => {
    const down = buildWanderPlaylist(styleSeed("citrus"), "citrus").find(
      (step) => step.kind === "down",
    );
    expect(down).toBeTruthy();
    expect(down!.gaze.y).toBeGreaterThan(0.45);
  });

  it("desyncs characters so the landing row is not a chorus", () => {
    const row = ["loom", "citrus", "grok", "kirby", "pip"] as const;
    const playlists = row.map((id) => buildWanderPlaylist(styleSeed(id), id));
    const orders = new Set(playlists.map((list) => list.map((step) => step.kind).join(",")));
    const durations = new Set(playlists.map((list) => Math.round(playlistDuration(list) / 80)));
    const atEight = new Set(playlists.map((list) => wanderGazeAt(list, 8000).x.toFixed(1)));
    expect(orders.size).toBeGreaterThan(2);
    expect(durations.size).toBeGreaterThan(2);
    expect(atEight.size).toBeGreaterThan(2);
  });

  it("holds a target, then eases to the next", () => {
    const playlist: Glance[] = [
      { kind: "rest", gaze: { x: 0, y: -0.2 }, holdMs: 1000, moveMs: 0 },
      { kind: "left", gaze: { x: -0.6, y: 0 }, holdMs: 1000, moveMs: 400 },
    ];
    const held = wanderGazeAt(playlist, 200);
    expect(held.x).toBeCloseTo(0, 5);
    expect(held.y).toBeCloseTo(-0.2, 5);

    const mid = wanderGazeAt(playlist, 1200);
    expect(mid.x).toBeLessThan(0);
    expect(mid.x).toBeGreaterThan(-0.6);

    const arrived = wanderGazeAt(playlist, 1450);
    expect(arrived.x).toBeCloseTo(-0.6, 5);
  });

  it("sends glances far enough from rest to read as looking", () => {
    const playlist = buildWanderPlaylist(styleSeed("citrus"), "citrus");
    const rest = playlist.find((step) => step.kind === "rest")!;
    const left = playlist.find((step) => step.kind === "left")!;
    const up = playlist.find((step) => step.kind === "up")!;
    expect(Math.abs(left.gaze.x - rest.gaze.x)).toBeGreaterThan(0.55);
    expect(Math.abs(up.gaze.y - rest.gaze.y)).toBeGreaterThan(0.45);
  });

  it("loops the playlist", () => {
    const playlist = buildWanderPlaylist(42, "nova");
    const loop = playlistDuration(playlist);
    const a = wanderGazeAt(playlist, 120);
    const b = wanderGazeAt(playlist, loop + 120);
    expect(a.x).toBeCloseTo(b.x, 5);
    expect(a.y).toBeCloseTo(b.y, 5);
  });
});
