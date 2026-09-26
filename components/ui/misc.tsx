"use client";

import * as React from "react";
import { Label as LabelPrimitive, Progress as ProgressPrimitive, Separator as SeparatorPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

export function Separator({ className, orientation = "horizontal", ...props }: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
      {...props}
    />
  );
}

export function Progress({
  className,
  value,
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <ProgressPrimitive.Root
      value={v}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-border-strong", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn("h-full bg-accent transition-[width] duration-300 ease-out", indicatorClassName)}
        style={{ width: `${v}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-[12px] font-medium text-muted", className)} {...props} />;
}

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-8 w-full rounded-md border border-border-strong bg-panel-2 px-2.5 text-[13px] text-foreground placeholder:text-faint transition-colors hover:border-[#3a3f49] focus-visible:border-accent/60 focus-visible:outline-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

const badgeVariants = cva("inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[11px] font-medium leading-none", {
  variants: {
    variant: {
      default: "bg-panel-3 text-muted",
      accent: "bg-accent/12 text-accent",
      warning: "bg-warning/12 text-warning",
      danger: "bg-danger/12 text-danger",
      success: "bg-success/12 text-success",
      info: "bg-info/12 text-info",
      outline: "border border-border-strong text-muted",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("size-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
