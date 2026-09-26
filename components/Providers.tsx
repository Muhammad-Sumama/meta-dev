"use client";

import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      {children}
      <Toaster
        theme="dark"
        position="bottom-right"
        offset={16}
        toastOptions={{
          classNames: {
            toast: "!bg-panel-2 !border !border-border-strong !text-foreground !shadow-xl !shadow-black/50 !rounded-lg",
            description: "!text-muted",
          },
        }}
      />
    </TooltipProvider>
  );
}
