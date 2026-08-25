import {
  DEFAULT_APPEARANCE,
  MARK_STYLE_LABELS,
  type MarkShape,
  PICKER_COLOR_SWATCHES,
  PICKER_SHAPES,
} from "@quibt/ui-tokens";
import { AgentMark } from "./agent-mark.js";

/**
 * Escolher o personagem é um detalhe da criação, não a etapa inteira: as formas ficam
 * numa fileira e as cores numa grade fixa de sete, para a última não cair sozinha na
 * linha de baixo. As medidas seguem a régua do produto.
 */
export function CharacterPicker(props: {
  color: string;
  shape: MarkShape;
  onChange: (next: { color: string; shape: MarkShape }) => void;
}) {
  const { color, shape, onChange } = props;

  return (
    <div className="overflow-hidden rounded-[var(--qb-r-md)] bg-[var(--qb-surface-2)]">
      <p className="px-4 pt-3.5 text-[var(--qb-t-xs)] font-semibold tracking-[0.06em] text-[var(--qb-muted-2)] uppercase">
        Formato
      </p>
      <div className="flex gap-1.5 px-3.5 pt-2 pb-3.5">
        {PICKER_SHAPES.map((id) => {
          const selected = shape === id;
          return (
            <button
              key={id}
              type="button"
              aria-label={`Formato ${MARK_STYLE_LABELS[id]}`}
              aria-pressed={selected}
              onClick={() => onChange({ color, shape: id })}
              style={{ display: "grid", placeItems: "center", width: 54, height: 54 }}
              className={`rounded-[var(--qb-r-md)] border p-0 transition-colors ${
                selected
                  ? "border-[var(--qb-accent)] bg-[rgba(60,130,246,0.10)]"
                  : "border-transparent bg-transparent hover:bg-[var(--qb-inset)]"
              }`}
            >
              <AgentMark color={color} shape={id} size={40} />
            </button>
          );
        })}
      </div>
      <div className="h-px bg-[var(--qb-hairline)]" />
      <p className="px-4 pt-3.5 text-[var(--qb-t-xs)] font-semibold tracking-[0.06em] text-[var(--qb-muted-2)] uppercase">
        Cor
      </p>
      <div
        className="gap-1.5 px-3.5 pt-2 pb-3.5"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          justifyItems: "center",
        }}
      >
        {PICKER_COLOR_SWATCHES.map((swatch) => {
          const selected = color.toLowerCase() === swatch.hex.toLowerCase();
          const isBlack = swatch.hex.toLowerCase() === "#111316";
          const isGrokBlack = color.toLowerCase() === "#000000" && isBlack;
          const on = selected || isGrokBlack;
          return (
            <button
              key={swatch.hex}
              type="button"
              aria-label={swatch.name}
              aria-pressed={on}
              onClick={() => onChange({ color: swatch.hex, shape })}
              className={`rounded-full border-2 bg-transparent p-0 ${
                on ? "border-[var(--qb-accent)]" : "border-transparent"
              }`}
              style={{ display: "grid", placeItems: "center", width: 34, height: 34 }}
            >
              <span
                className="block rounded-full"
                style={{
                  width: 24,
                  height: 24,
                  background: swatch.hex,
                  boxShadow:
                    swatch.hex.toLowerCase() === "#ffffff"
                      ? "inset 0 0 0 1px var(--qb-hairline)"
                      : undefined,
                }}
              />
            </button>
          );
        })}
      </div>
      <div className="h-px bg-[var(--qb-hairline)]" />
      <button
        type="button"
        className="flex min-h-10 items-center px-4 text-[var(--qb-t-sm)] font-semibold text-[var(--qb-accent)]"
        onClick={() => onChange({ ...DEFAULT_APPEARANCE })}
      >
        Voltar ao padrão
      </button>
    </div>
  );
}
