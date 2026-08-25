import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--qb-r-sm)] text-[var(--qb-t-md)] font-medium transition-all disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-[var(--qb-ink-strong)] text-[var(--qb-canvas)] hover:bg-[var(--qb-ink)]",
        cream: "bg-[var(--qb-surface-2)] text-[var(--qb-ink)] hover:bg-[var(--qb-inset)]",
        outline:
          "border border-[var(--qb-hairline)] text-[var(--qb-ink)] hover:bg-[var(--qb-surface-2)]",
        ghost: "text-[var(--qb-muted)] hover:bg-[var(--qb-surface-2)]",
        danger: "bg-[var(--qb-danger)] text-[var(--qb-canvas)] hover:opacity-90",
        pill: "rounded-full bg-[var(--qb-surface-2)] text-[var(--qb-ink)] hover:bg-[var(--qb-inset)]",
      },
      size: {
        /* Alturas medidas no Grok Bot: 32 na régua, 26 no botão de linha. */
        default: "h-8 px-3.5",
        sm: "h-[26px] px-3 text-[var(--qb-t-sm)]",
        lg: "h-11 px-6 text-[var(--qb-t-lg)]",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
