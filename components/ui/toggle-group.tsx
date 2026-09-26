"use client";

import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils/cn";

function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      className={cn("inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5", className)}
      {...props}
    />
  );
}

function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        "inline-flex h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-[4px] px-2 text-xs font-medium text-muted transition-colors hover:text-foreground data-[state=on]:bg-panel-3 data-[state=on]:text-foreground [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
