export type MotionClock = {
  phase: number;
  rate: number;
  lookAround: number;
  gaze: { x: number; y: number };
  bob: number;
  sway: number;
  bobPeriod: number;
  swayPeriod: number;
};

/**
 * Idle calmo, tipo respiração. O engine de idle já é 2.4s de pulo e 3.6s
 * de balanço — period < 1 e rate > 1 viram pulga. Aqui o ciclo fica
 * longo e a amplitude baixa. O jeito de cada um continua diferente.
 */
const PERSONA: Record<string, Partial<MotionClock>> = {
  strobi: { rate: 0.72, bob: 0.42, sway: 0.1, bobPeriod: 1.55, swayPeriod: 1.8, lookAround: 0.14 },
  grok: { rate: 0.52, bob: 0.12, sway: 0.32, bobPeriod: 1.85, swayPeriod: 2.1, lookAround: 0.06 },
  freddy: { rate: 0.58, bob: 0.16, sway: 0.48, bobPeriod: 1.7, swayPeriod: 1.9, lookAround: 0.08 },
  citrus: { rate: 0.7, bob: 0.34, sway: 0.18, bobPeriod: 1.5, swayPeriod: 1.75, lookAround: 0.12 },
  nova: { rate: 0.62, bob: 0.2, sway: 0.3, bobPeriod: 1.65, swayPeriod: 1.85, lookAround: 0.18 },
  sunee: { rate: 0.76, bob: 0.28, sway: 0.36, bobPeriod: 1.45, swayPeriod: 1.55, lookAround: 0.1 },
  kirby: { rate: 0.74, bob: 0.5, sway: 0.1, bobPeriod: 1.6, swayPeriod: 1.9, lookAround: 0.08 },
  cloudee: { rate: 0.5, bob: 0.1, sway: 0.42, bobPeriod: 1.9, swayPeriod: 2.2, lookAround: 0.05 },
  cubee: { rate: 0.55, bob: 0.12, sway: 0.1, bobPeriod: 1.8, swayPeriod: 2.0, lookAround: 0.04 },
  onee: { rate: 0.66, bob: 0.22, sway: 0.34, bobPeriod: 1.55, swayPeriod: 1.7, lookAround: 0.2 },
  pip: { rate: 0.75, bob: 0.44, sway: 0.16, bobPeriod: 1.5, swayPeriod: 1.8, lookAround: 0.12 },
  loom: { rate: 0.5, bob: 0.12, sway: 0.46, bobPeriod: 1.85, swayPeriod: 2.15, lookAround: 0.04 },
};

export function styleSeed(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function motionFromSeed(seed: number, style?: string): MotionClock {
  const clock: MotionClock = {
    phase: seed % 5200,
    rate: 0.55 + ((seed >>> 2) % 30) / 100,
    lookAround: 0.05 + ((seed >>> 5) % 14) / 100,
    gaze: {
      x: (((seed >>> 8) % 19) - 9) / 28,
      y: -0.18 + (((seed >>> 11) % 13) - 6) / 32,
    },
    bob: 0.12 + ((seed >>> 14) % 40) / 100,
    sway: 0.1 + ((seed >>> 17) % 40) / 100,
    bobPeriod: 1.4 + ((seed >>> 20) % 50) / 100,
    swayPeriod: 1.5 + ((seed >>> 23) % 60) / 100,
  };
  return style && PERSONA[style] ? { ...clock, ...PERSONA[style] } : clock;
}
