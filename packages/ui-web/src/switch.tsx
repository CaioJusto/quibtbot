import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "./lib/utils.js";

export type SwitchProps = SwitchPrimitive.SwitchProps & {
  /** Replaces the default thumb utilities when a product surface owns its geometry. */
  thumbClassName?: string;
};

/** iOS-style toggle: grey when off, system green when on. */
export function Switch({
  checked,
  onCheckedChange,
  className,
  thumbClassName,
  ...props
}: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={cn(
        "relative inline-flex h-[31px] w-[51px] shrink-0 appearance-none items-center overflow-hidden rounded-full border-0 bg-[#39393D] p-0 align-middle transition-colors outline-none data-[state=checked]:bg-[#34C759]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={
          thumbClassName ??
          "block h-[27px] w-[27px] translate-x-[2px] rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,.35)] transition-transform data-[state=checked]:translate-x-[22px]"
        }
      />
    </SwitchPrimitive.Root>
  );
}
