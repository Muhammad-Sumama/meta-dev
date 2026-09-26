"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/utils/cn";
import { Kbd } from "./kbd";

function TooltipProvider({ delayDuration = 350, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={200} {...props} />;
}

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({ className, sideOffset = 6, children, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 flex max-w-72 items-center gap-2 rounded-md border border-border-strong bg-panel-3 px-2.5 py-1.5 text-xs text-foreground shadow-lg shadow-black/40 animate-fade-in",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/** Convenience wrapper: tooltip with optional keyboard shortcut hint. */
function Hint({
  label,
  shortcut,
  side = "top",
  children,
}: {
  label: React.ReactNode;
  shortcut?: string | string[];
  side?: "top" | "right" | "bottom" | "left";
  children: React.ReactNode;
}) {
  const keys = shortcut ? (Array.isArray(shortcut) ? shortcut : [shortcut]) : [];
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <span>{label}</span>
        {keys.length > 0 && (
          <span className="flex items-center gap-0.5">
            {keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, Hint };
