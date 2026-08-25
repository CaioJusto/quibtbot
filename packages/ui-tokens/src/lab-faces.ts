/**
 * Receitas de cara do mascote Quibt.
 *
 * O face engine nasce com soquetes altos. Para o olho ler como bola,
 * a gente alarga e achata — [1, 1] ainda sai cápsula. Sem boca.
 */

export type LabEyeScale = readonly [width: number, height: number];

export type LabFaceRecipe = {
  eyeScale: { left: LabEyeScale; right: LabEyeScale };
  roll: number;
  faceScale: number;
};

/** Contra o soquete alto: vira bola. */
const BALL: LabEyeScale = [1.28, 0.54];
/** Bola maior (um olho só, ou os dois no Grok). */
const BIG: LabEyeScale = [1.62, 0.7];
/** Pontinho redondo. */
const DOT: LabEyeScale = [0.82, 0.36];
/** Bola achatada — sonolento, ainda redondo, não palito. */
const SQUINT: LabEyeScale = [1.42, 0.4];

export const LAB_FACES = {
  strobi: {
    eyeScale: { left: BALL, right: BALL },
    roll: 0,
    faceScale: 1,
  },
  freddy: {
    eyeScale: { left: BALL, right: BALL },
    roll: -10,
    faceScale: 1.08,
  },
  citrus: {
    eyeScale: { left: BALL, right: BALL },
    roll: 0,
    faceScale: 0.92,
  },
  nova: {
    eyeScale: { left: BALL, right: [1.12, 0.48] },
    roll: 8,
    faceScale: 0.96,
  },
  grok: {
    eyeScale: { left: BIG, right: DOT },
    roll: 6,
    faceScale: 1.1,
  },
  sunee: {
    eyeScale: { left: DOT, right: DOT },
    roll: 0,
    faceScale: 0.84,
  },
  kirby: {
    eyeScale: { left: BALL, right: BALL },
    roll: 0,
    faceScale: 1.14,
  },
  cloudee: {
    eyeScale: { left: SQUINT, right: SQUINT },
    roll: 4,
    faceScale: 0.9,
  },
  cubee: {
    eyeScale: { left: [1.02, 0.46], right: [1.02, 0.46] },
    roll: 0,
    faceScale: 0.86,
  },
  onee: {
    eyeScale: { left: BALL, right: BALL },
    roll: -6,
    faceScale: 0.88,
  },
  pip: {
    eyeScale: { left: BALL, right: BALL },
    roll: 0,
    faceScale: 1.02,
  },
  loom: {
    eyeScale: { left: BALL, right: BALL },
    roll: -20,
    faceScale: 0.98,
  },
} as const satisfies Record<string, LabFaceRecipe>;

export type LabFaceId = keyof typeof LAB_FACES;

export function labFaceFor(shape: string): LabFaceRecipe {
  if (shape in LAB_FACES) return LAB_FACES[shape as LabFaceId];
  return LAB_FACES.strobi;
}

export function labFaceIds(): LabFaceId[] {
  return Object.keys(LAB_FACES) as LabFaceId[];
}

function recipeKey(recipe: LabFaceRecipe): string {
  return JSON.stringify({
    eyeScale: recipe.eyeScale,
    roll: recipe.roll,
    faceScale: recipe.faceScale,
  });
}

export function labFacesAreUnique(): boolean {
  const keys = labFaceIds().map((id) => recipeKey(LAB_FACES[id]));
  return new Set(keys).size === keys.length;
}

/** Altura do soquete achatada o bastante pra ler como bola, não palito. */
export function labEyeReadsAsBall(pair: LabEyeScale): boolean {
  return pair[1] <= 0.72 && pair[0] >= pair[1];
}
