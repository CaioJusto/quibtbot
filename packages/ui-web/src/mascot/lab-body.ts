/**
 * Procedural 2.5D bodies for the Avatar Lab styles (Strobi, Freddy, …).
 * Built independently as SVG primitives + a highlight, then worn by the face engine.
 */

export type LabPrimitive = "sphere" | "cube" | "cone" | "capsule";

export type LabNode = {
  type: LabPrimitive;
  w: number;
  h: number;
  x?: number;
  y?: number;
  round?: number;
  rot?: number;
};

export type LabStyle = {
  id: string;
  name: string;
  primary: LabNode;
  nodes?: LabNode[];
  /** Scale the whole silhouette down so ears / rays stay inside the face box. */
  fit?: number;
};

const CX = 100;
const CY = 100;

function n(value: number) {
  return Number(value.toFixed(2));
}

function roundedRect(cx: number, cy: number, w: number, h: number, round: number) {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const r = Math.min(round, w / 2, h / 2);
  return (
    `M${n(x + r)} ${n(y)}H${n(x + w - r)}Q${n(x + w)} ${n(y)} ${n(x + w)} ${n(y + r)}` +
    `V${n(y + h - r)}Q${n(x + w)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)}` +
    `H${n(x + r)}Q${n(x)} ${n(y + h)} ${n(x)} ${n(y + h - r)}` +
    `V${n(y + r)}Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}Z`
  );
}

function conePath(cx: number, cy: number, w: number, h: number) {
  const hw = w / 2;
  const hh = h / 2;
  const tip = hw * 0.18;
  return (
    `M${n(cx)} ${n(cy - hh)}` +
    `C${n(cx + tip)} ${n(cy - hh + hh * 0.22)} ${n(cx + hw)} ${n(cy - hh * 0.08)} ${n(cx + hw * 0.94)} ${n(cy + hh * 0.38)}` +
    `Q${n(cx + hw)} ${n(cy + hh)} ${n(cx)} ${n(cy + hh)}` +
    `Q${n(cx - hw)} ${n(cy + hh)} ${n(cx - hw * 0.94)} ${n(cy + hh * 0.38)}` +
    `C${n(cx - hw)} ${n(cy - hh * 0.08)} ${n(cx - tip)} ${n(cy - hh + hh * 0.22)} ${n(cx)} ${n(cy - hh)}Z`
  );
}

function primitivePath(node: LabNode, cx: number, cy: number): string {
  if (node.type === "sphere") {
    const rx = node.w / 2;
    const ry = node.h / 2;
    return `M${n(cx - rx)} ${n(cy)}A${n(rx)} ${n(ry)} 0 0 1 ${n(cx + rx)} ${n(cy)}A${n(rx)} ${n(ry)} 0 0 1 ${n(cx - rx)} ${n(cy)}Z`;
  }
  if (node.type === "capsule") {
    return roundedRect(cx, cy, node.w, node.h, Math.min(node.w, node.h) / 2);
  }
  if (node.type === "cone") {
    return conePath(cx, cy, node.w, node.h);
  }
  return roundedRect(cx, cy, node.w, node.h, Math.min(node.w, node.h) * (node.round ?? 0.72) * 0.5);
}

function highlight(node: LabNode, cx: number, cy: number): string {
  const rx = node.w * 0.22;
  const ry = node.h * 0.15;
  const hx = cx - node.w * 0.2;
  const hy = cy - node.h * 0.24;
  return (
    `<ellipse cx="${n(hx)}" cy="${n(hy)}" rx="${n(rx)}" ry="${n(ry)}" fill="#ffffff" opacity="0.5"/>` +
    `<ellipse cx="${n(hx + rx * 0.35)}" cy="${n(hy + ry * 0.15)}" rx="${n(rx * 0.38)}" ry="${n(ry * 0.4)}" fill="#ffffff" opacity="0.35"/>`
  );
}

function paintNode(node: LabNode): { body: string; clip: string } {
  const cx = CX + (node.x ?? 0);
  const cy = CY + (node.y ?? 0);
  const rot = node.rot ?? 0;
  const wrap = (inner: string) =>
    rot ? `<g transform="rotate(${n(rot)} ${n(cx)} ${n(cy)})">${inner}</g>` : inner;
  const d = primitivePath(node, cx, cy);
  const fill = wrap(`<path fill="{{GRADIENT}}" d="${d}"/>`);
  const shine = wrap(highlight(node, cx, cy));
  const clip = wrap(`<path d="${d}"/>`);
  return { body: fill + shine, clip };
}

export function buildLabBody(style: LabStyle): { body: string; clip: string } {
  const parts = [style.primary, ...(style.nodes ?? [])].map(paintNode);
  return {
    body: parts.map((part) => part.body).join(""),
    clip: parts.map((part) => part.clip).join(""),
  };
}

export const LAB_STYLES: Record<string, LabStyle> = {
  strobi: {
    id: "strobi",
    name: "Strobi",
    primary: { type: "sphere", w: 192, h: 192 },
  },
  grok: {
    id: "grok",
    name: "Grok",
    primary: { type: "sphere", w: 192, h: 192 },
  },
  freddy: {
    id: "freddy",
    name: "Freddy",
    fit: 0.9,
    primary: { type: "cube", w: 152, h: 134, round: 0.9 },
    nodes: [
      { type: "sphere", w: 50, h: 50, x: -50, y: -70 },
      { type: "sphere", w: 50, h: 50, x: 50, y: -70 },
    ],
  },
  citrus: {
    id: "citrus",
    name: "Citrus",
    primary: { type: "cone", w: 168, h: 196 },
  },
  nova: {
    id: "nova",
    name: "Nova",
    primary: { type: "capsule", w: 128, h: 192 },
  },
  sunee: {
    id: "sunee",
    name: "Sunee",
    fit: 0.9,
    primary: { type: "sphere", w: 118, h: 118 },
    nodes: Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const r = 82;
      const s = i % 2 === 0 ? 44 : 36;
      return {
        type: "sphere" as const,
        w: s,
        h: s,
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
      };
    }),
  },
  kirby: {
    id: "kirby",
    name: "Kirby",
    fit: 0.92,
    primary: { type: "sphere", w: 168, h: 158 },
    nodes: [
      { type: "sphere", w: 62, h: 46, x: -84, y: 46, rot: -28 },
      { type: "sphere", w: 62, h: 46, x: 82, y: 48, rot: 28 },
    ],
  },
  cloudee: {
    id: "cloudee",
    name: "Cloudee",
    fit: 0.9,
    primary: { type: "sphere", w: 100, h: 100, y: 10 },
    nodes: [
      { type: "sphere", w: 86, h: 78, x: -58, y: 6 },
      { type: "sphere", w: 94, h: 80, x: 56, y: 10 },
      { type: "sphere", w: 78, h: 70, x: -28, y: -28 },
      { type: "sphere", w: 72, h: 66, x: 30, y: -24 },
      { type: "sphere", w: 88, h: 72, x: 0, y: 28 },
    ],
  },
  cubee: {
    id: "cubee",
    name: "Cubee",
    primary: { type: "cube", w: 168, h: 168, round: 0.42 },
  },
  onee: {
    id: "onee",
    name: "Onee",
    primary: { type: "sphere", w: 192, h: 118 },
  },
  pip: {
    id: "pip",
    name: "Pip",
    primary: { type: "sphere", w: 168, h: 176 },
  },
  loom: {
    id: "loom",
    name: "Loom",
    primary: { type: "sphere", w: 204, h: 168 },
  },
};
