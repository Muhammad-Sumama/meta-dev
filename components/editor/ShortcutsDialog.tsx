"use client";

import { SHORTCUTS } from "@/hooks/useShortcuts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts work whenever you&apos;re not typing in a text field.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[70vh] gap-6 overflow-y-auto px-5 py-4 sm:grid-cols-2">
          {SHORTCUTS.map((g) => (
            <section key={g.group}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{g.group}</h3>
              <ul className="flex flex-col gap-1.5">
                {g.items.map((it) => (
                  <li key={it.label} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-muted">{it.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {it.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
