import * as React from "react";
import { cn } from "@/lib/utils/cn";

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border-strong bg-panel px-1 font-mono text-[10.5px] leading-none text-muted",
        className,
      )}
      {...props}
    />
  );
}
