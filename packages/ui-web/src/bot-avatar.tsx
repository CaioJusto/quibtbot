import { resolveAppearance } from "@quibt/ui-tokens";
import { cn } from "./lib/utils.js";
import { AgentMark } from "./mascot/agent-mark.js";

export { AgentMark };

/**
 * The agent's character mark. `color` accepts the encoded `#RRGGBB:shape` form
 * stored on the bot; that encoded shape wins over a stale `shape` column. Pass a
 * bare colour plus `shape` while someone is picking a new mark.
 */
export function BotAvatar({
  color,
  shape,
  size = 38,
  className,
  online,
  presence,
  state,
  title,
}: {
  color: string;
  shape?: string | null;
  size?: number;
  className?: string;
  online?: boolean;
  presence?: "working" | "attention" | null;
  state?: "idle" | "thinking" | "working" | "sending" | "receiving" | "notifying";
  title?: string | null;
}) {
  const appearance = resolveAppearance(color, shape);
  return (
    <AgentMark
      color={appearance.color}
      shape={appearance.shape}
      size={size}
      className={className}
      online={online}
      presence={presence}
      state={state}
      title={title}
    />
  );
}

export function BrandMark({ size = 44, className }: { size?: number; className?: string }) {
  return (
    <div
      className={cn("flex items-center justify-center", className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        background: "#0B3A78",
        flex: "none",
      }}
      aria-hidden="true"
    >
      <span
        className="font-semibold text-white"
        style={{ fontSize: size * 0.52, letterSpacing: "-0.06em", lineHeight: 1 }}
      >
        Q
      </span>
    </div>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <BrandMark size={44} />
      <span className="text-[28px] font-semibold tracking-tight text-white">Quibt Bot</span>
    </div>
  );
}
