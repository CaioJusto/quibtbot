import {
  MARK_STYLE_COLORS,
  MARK_STYLE_LABELS,
  type MarkShape,
  PICKER_SHAPES,
} from "@quibt/ui-tokens";
import { cn } from "../lib/utils.js";
import { AgentMark } from "./agent-mark.js";

export function CharacterGallery({
  size = 88,
  tone = "light",
  ids = PICKER_SHAPES,
  showLabels = true,
  className,
}: {
  size?: number;
  tone?: "light" | "dark";
  ids?: readonly MarkShape[];
  showLabels?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("character-gallery flex flex-wrap items-start justify-center", className)}
      style={{
        gap: "var(--gallery-gap, 22px 28px)",
        ["--gallery-desktop-size" as string]: `${size}px`,
      }}
    >
      {ids.map((id) => (
        <div
          key={id}
          className="character-gallery__item flex flex-col items-center"
          style={{ gap: showLabels ? 8 : 0, width: "var(--gallery-size)" }}
        >
          <AgentMark
            className="character-gallery__mark !h-[var(--gallery-size)] !w-[var(--gallery-size)]"
            color={MARK_STYLE_COLORS[id]}
            shape={id}
            size={size}
            showcase
          />
          {showLabels ? (
            <span
              style={{
                color: tone === "dark" ? "#8E8E93" : "var(--muted, #667085)",
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.2,
              }}
            >
              {MARK_STYLE_LABELS[id]}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
