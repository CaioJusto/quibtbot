import { resolveAppearance } from "@quibt/ui-tokens";
import type { CSSProperties } from "react";
import { cn } from "../lib/utils.js";
import { rasterMascotSrc } from "./raster-assets.js";

export type MascotState = "idle" | "thinking" | "working" | "sending" | "receiving" | "notifying";

/**
 * Raster Quibt mark — the same generated blob / cube / drop / orb family the
 * mobile app ships. Color picks the nearest painted body; shape picks the
 * silhouette family.
 */
export function AgentMark({
  color,
  shape,
  size = 38,
  state = "idle",
  online = false,
  presence,
  title,
  className,
  compact,
  followPointer: _followPointer,
  showcase = false,
}: {
  color: string;
  shape?: string | null;
  size?: number;
  state?: MascotState;
  online?: boolean;
  /**
   * A bolinha ao pé do mascote: verde enquanto o bot trabalha, azul quando terminou e
   * está esperando a pessoa (resposta nova, aprovação pedida). `online` sozinho ainda
   * vale como verde, para quem só sabe dizer "ligado".
   */
  presence?: "working" | "attention" | null;
  title?: string | null;
  className?: string;
  compact?: boolean;
  followPointer?: boolean;
  showcase?: boolean;
}) {
  const tiny = compact ?? size < 28;
  const appearance = resolveAppearance(color, shape);
  const src = rasterMascotSrc(appearance.shape, appearance.color);
  const animate = !tiny && (showcase || size >= 100 || state === "working" || state === "thinking");
  const label = title ?? undefined;

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-visible",
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden={label ? undefined : true}
    >
      <img
        src={src}
        alt={label ?? ""}
        draggable={false}
        className={animate ? "quibt-mascot-idle" : undefined}
        style={{
          width: "124%",
          height: "124%",
          maxWidth: "none",
          objectFit: "contain",
          filter: "drop-shadow(0 3px 6px rgba(0, 0, 0, 0.28))",
        }}
      />
      {presence || online ? (
        <span
          aria-hidden
          className={`absolute rounded-full border-2 border-black ${
            presence === "attention" ? "bg-[#3C82F6]" : "bg-[#30D158]"
          }`}
          style={
            {
              width: Math.max(10, size * 0.19),
              height: Math.max(10, size * 0.19),
              right: Math.max(1, size * 0.03),
              bottom: Math.max(0, size * 0.01),
            } as CSSProperties
          }
        />
      ) : null}
    </span>
  );
}
