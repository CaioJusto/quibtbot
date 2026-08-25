import { useEffect, useRef, useState } from "react";
import { onAnimationFrame } from "./frame-loop.js";
import { RESTING_GAZE } from "./use-pointer-look.js";

export type Gaze = { x: number; y: number };
export type GlanceKind = "rest" | "left" | "right" | "up" | "down" | "think";

export type Glance = {
  kind: GlanceKind;
  gaze: Gaze;
  holdMs: number;
  moveMs: number;
};

type WanderBias = {
  restBias: number;
  thinkBias: number;
  reach: number;
  tempo: number;
};

/**
 * How each face tends to look around. Reach is how far the pupils travel;
 * tempo stretches or shortens holds. The eye *shape* never changes — only gaze.
 */
const PERSONA: Record<string, WanderBias> = {
  strobi: { restBias: 1, thinkBias: 1, reach: 0.96, tempo: 1 },
  grok: { restBias: 1.15, thinkBias: 1.55, reach: 0.9, tempo: 0.86 },
  freddy: { restBias: 0.95, thinkBias: 1.1, reach: 0.94, tempo: 0.95 },
  citrus: { restBias: 0.8, thinkBias: 0.95, reach: 1, tempo: 1.04 },
  nova: { restBias: 0.75, thinkBias: 1.35, reach: 1, tempo: 1.08 },
  sunee: { restBias: 0.85, thinkBias: 1, reach: 0.95, tempo: 1.06 },
  kirby: { restBias: 0.72, thinkBias: 0.85, reach: 0.94, tempo: 1.1 },
  cloudee: { restBias: 1.4, thinkBias: 1.25, reach: 0.86, tempo: 0.8 },
  cubee: { restBias: 1.3, thinkBias: 1.4, reach: 0.88, tempo: 0.82 },
  onee: { restBias: 0.7, thinkBias: 1.2, reach: 1, tempo: 1.05 },
  pip: { restBias: 0.76, thinkBias: 0.88, reach: 0.96, tempo: 1.08 },
  loom: { restBias: 1.5, thinkBias: 1.5, reach: 0.88, tempo: 0.78 },
};

const DEFAULT_BIAS: WanderBias = { restBias: 1, thinkBias: 1, reach: 0.85, tempo: 1 };

function mulberry(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand: () => number, min: number, max: number) {
  return min + (max - min) * rand();
}

function easeInOut(t: number) {
  return t * t * (3 - 2 * t);
}

function lerpGaze(from: Gaze, to: Gaze, t: number): Gaze {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function clampGaze(gaze: Gaze): Gaze {
  return {
    x: Math.max(-1, Math.min(1, gaze.x)),
    y: Math.max(-1, Math.min(1, gaze.y)),
  };
}

function shuffle<T>(items: T[], rand: () => number) {
  const next = items.slice();
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const swap = next[i]!;
    next[i] = next[j]!;
    next[j] = swap;
  }
  return next;
}

/** Named looks. Negative Y is up in the face engine. */
function targetFor(kind: GlanceKind, rand: () => number, reach: number): Gaze {
  switch (kind) {
    case "rest":
      return { x: pick(rand, -0.1, 0.14) * reach, y: pick(rand, -0.2, -0.04) };
    case "left":
      return { x: pick(rand, -0.98, -0.78) * reach, y: pick(rand, -0.16, 0.12) };
    case "right":
      return { x: pick(rand, 0.78, 0.98) * reach, y: pick(rand, -0.16, 0.12) };
    case "up":
      return { x: pick(rand, -0.16, 0.16) * reach, y: pick(rand, -0.96, -0.72) };
    case "down":
      return { x: pick(rand, -0.16, 0.16) * reach, y: pick(rand, 0.52, 0.82) };
    case "think": {
      const side = rand() < 0.5 ? -1 : 1;
      return { x: side * pick(rand, 0.52, 0.82) * reach, y: pick(rand, -0.92, -0.68) };
    }
  }
}

function holdRange(kind: GlanceKind): [number, number] {
  if (kind === "rest") return [3200, 5600];
  if (kind === "think") return [4400, 7000];
  return [2400, 4200];
}

/**
 * One loop of natural idle looking: rest, glance aside, look up/down, stop, think.
 * Seed + style keep the landing row from blinking in chorus.
 */
export function buildWanderPlaylist(seed: number, style?: string): Glance[] {
  const rand = mulberry(seed);
  const persona = (style && PERSONA[style]) || DEFAULT_BIAS;
  const glances = shuffle(["left", "right", "up", "down"] as GlanceKind[], rand);
  const order: GlanceKind[] = [
    "rest",
    glances[0]!,
    "rest",
    glances[1]!,
    "think",
    glances[2]!,
    "rest",
    glances[3]!,
  ];
  if (persona.thinkBias >= 1.3) order.push("think");
  if (persona.restBias >= 1.3) order.splice(2, 0, "rest");

  return order.map((kind, index) => {
    const [minHold, maxHold] = holdRange(kind);
    const openingRest = index === 0 && kind === "rest";
    return {
      kind,
      gaze: clampGaze(targetFor(kind, rand, persona.reach)),
      holdMs: (openingRest ? pick(rand, 800, 1500) : pick(rand, minHold, maxHold)) / persona.tempo,
      moveMs: pick(rand, 380, 640),
    };
  });
}

export function playlistDuration(playlist: readonly Glance[]) {
  return playlist.reduce((sum, step) => sum + step.moveMs + step.holdMs, 0);
}

/** Sample the playlist at t milliseconds. Loops. No shape morph — gaze only. */
export function wanderGazeAt(playlist: readonly Glance[], tMs: number): Gaze {
  if (!playlist.length) return RESTING_GAZE;
  const loop = playlistDuration(playlist);
  if (loop <= 0) return playlist[0]!.gaze;
  let t = ((tMs % loop) + loop) % loop;
  let previous = playlist[playlist.length - 1]!;
  for (const step of playlist) {
    if (t < step.moveMs) {
      const u = easeInOut(step.moveMs <= 0 ? 1 : t / step.moveMs);
      return lerpGaze(previous.gaze, step.gaze, u);
    }
    t -= step.moveMs;
    if (t < step.holdMs) return step.gaze;
    t -= step.holdMs;
    previous = step;
  }
  return playlist[0]!.gaze;
}

/** Tiny flicks while holding a look, like the Lab's micro-saccades. */
export function microSaccade(seed: number, tMs: number): Gaze {
  const interval = 1400;
  const duration = 160;
  const step = Math.floor(Math.max(0, tMs) / interval);
  const blend = easeInOut(Math.min(1, Math.max(0, (tMs - step * interval) / duration)));
  const hash = (n: number) => {
    const raw = Math.sin(n * 127.1 + seed * 0.0009 + 311.7) * 43758.5453;
    return (raw - Math.floor(raw)) * 2 - 1;
  };
  const prevX = step === 0 ? 0 : hash(step - 1) * 0.04;
  const nextX = hash(step) * 0.04;
  const prevY = step === 0 ? 0 : hash(step + 17) * 0.024;
  const nextY = hash(step + 18) * 0.024;
  return {
    x: prevX + (nextX - prevX) * blend,
    y: prevY + (nextY - prevY) * blend,
  };
}

export function wanderGazeWithSaccades(
  playlist: readonly Glance[],
  tMs: number,
  seed: number,
): Gaze {
  const base = wanderGazeAt(playlist, tMs);
  const flick = microSaccade(seed, tMs);
  return clampGaze({ x: base.x + flick.x, y: base.y + flick.y });
}

/**
 * Idle eyes: look left, right, up, down, rest, think. Off when the pointer is driving.
 */
export function useWanderLook(enabled: boolean, seed: number, style?: string) {
  const [gaze, setGaze] = useState(RESTING_GAZE);
  const last = useRef(RESTING_GAZE);

  useEffect(() => {
    if (!enabled) {
      last.current = RESTING_GAZE;
      setGaze(RESTING_GAZE);
      return;
    }

    const playlist = buildWanderPlaylist(seed, style);
    // The clock starts on the first frame so the playlist reads the same timeline the
    // shared loop hands out.
    let started: number | null = null;

    // One rAF loop drives every wandering mascot on the page.
    return onAnimationFrame((now) => {
      started ??= now;
      const next = wanderGazeWithSaccades(playlist, now - started, seed);
      const prev = last.current;
      if (Math.abs(next.x - prev.x) > 0.004 || Math.abs(next.y - prev.y) > 0.004) {
        last.current = next;
        setGaze(next);
      }
    });
  }, [enabled, seed, style]);

  return gaze;
}
