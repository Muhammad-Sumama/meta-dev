"use client";

import { useRef } from "react";
import { updateComposite } from "@/lib/client/actions";
import type { EffectType } from "@/lib/schemas/command";
import type { Composite } from "@/lib/schemas/project";
import { useEditor } from "@/stores/editor";
import { Label } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

export const EFFECT_OPTIONS: Array<{ value: EffectType; label: string; hint: string }> = [
  { value: "none", label: "Mask only", hint: "Show the mask overlay; export tints the subject." },
  { value: "remove_background", label: "Remove background", hint: "Transparent background (WebM/ProRes/PNG keep alpha)." },
  { value: "blur_background", label: "Blur background", hint: "Portrait-style background blur." },
  { value: "blur_object", label: "Blur object", hint: "Blur the subject, e.g. to anonymize." },
  { value: "highlight", label: "Highlight", hint: "Dim and desaturate everything else." },
  { value: "replace_background", label: "Replace background", hint: "Solid color or green screen." },
  { value: "remove_object", label: "Remove object", hint: "Fill the subject from a clean plate (static camera)." },
];

/**
 * Sliders update the document live while dragging and commit a single undo
 * entry when released.
 */
function useLiveComposite() {
  const startRef = useRef<Composite | null>(null);
  return {
    begin() {
      startRef.current ??= useEditor.getState().doc.composite;
    },
    live(patch: Partial<Composite>) {
      const s = useEditor.getState();
      if (!startRef.current) startRef.current = s.doc.composite;
      useEditor.setState({ doc: { ...s.doc, composite: { ...s.doc.composite, ...patch } } });
    },
    end(label: string) {
      const start = startRef.current;
      startRef.current = null;
      if (!start) return;
      const s = useEditor.getState();
      const final = s.doc.composite;
      useEditor.setState({ doc: { ...s.doc, composite: start } });
      updateComposite(label, final);
    },
  };
}

export function OutputPanel() {
  const composite = useEditor((s) => s.doc.composite);
  const order = useEditor((s) => s.doc.order);
  const tracks = useEditor((s) => s.doc.tracks);
  const previewEffect = useEditor((s) => s.previewEffect);
  const set = useEditor((s) => s.set);
  const live = useLiveComposite();

  const selectedOpt = EFFECT_OPTIONS.find((o) => o.value === composite.effect)!;
  const subjectAll = composite.subjectTrackIds.length === 0;

  return (
    <section aria-labelledby="output-title" className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <h2 id="output-title" className="text-[13px] font-semibold">
          Output
        </h2>
        <label className="flex items-center gap-2 text-[12px] text-muted">
          Preview
          <Switch checked={previewEffect} onCheckedChange={(v) => set("previewEffect", v)} aria-label="Preview output effect" />
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="effect-select">Effect</Label>
        <Select
          value={composite.effect}
          onValueChange={(v) => {
            updateComposite("Change effect", { effect: v as EffectType });
            set("previewEffect", true);
          }}
        >
          <SelectTrigger id="effect-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EFFECT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11.5px] leading-snug text-faint">{selectedOpt.hint}</p>
      </div>

      {composite.effect === "replace_background" && (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="bg-color">Background color</Label>
          <div className="flex items-center gap-2">
            {["#00b140", "#0047bb", "#ffffff", "#000000"].map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Use ${c}`}
                className="size-5 rounded-sm ring-1 ring-border-strong transition-transform hover:scale-110"
                style={{ background: c }}
                onClick={() => updateComposite("Background color", { backgroundColor: c })}
              />
            ))}
            <input
              id="bg-color"
              type="color"
              value={composite.backgroundColor}
              onChange={(e) => live.live({ backgroundColor: e.target.value })}
              onBlur={() => live.end("Background color")}
              className="size-6 cursor-pointer rounded-sm border border-border-strong bg-transparent"
            />
          </div>
        </div>
      )}

      {(composite.effect === "blur_background" || composite.effect === "blur_object") && (
        <SliderRow
          label="Blur strength"
          value={composite.blurStrength}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => live.live({ blurStrength: v })}
          onCommit={() => live.end("Blur strength")}
        />
      )}
      {composite.effect === "highlight" && (
        <SliderRow
          label="Dim background"
          value={composite.dim}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => live.live({ dim: v })}
          onCommit={() => live.end("Dim background")}
        />
      )}

      <SliderRow
        label="Feather"
        value={composite.feather}
        min={0}
        max={20}
        step={0.5}
        format={(v) => `${v.toFixed(1)} px`}
        onChange={(v) => live.live({ feather: v })}
        onCommit={() => live.end("Feather")}
      />
      <label className="flex items-center justify-between gap-2 text-[12.5px]" title="Moves mask edges onto the image's own edges (hair, fur, outlines). Applied to exports and to the preview when paused.">
        <span>Refine edges</span>
        <Switch
          checked={composite.refineEdges}
          onCheckedChange={(v) => updateComposite(v ? "Refine edges" : "Don't refine edges", { refineEdges: v })}
          aria-label="Refine edges"
        />
      </label>
      <SliderRow
        label="Grow / shrink edge"
        value={composite.expand}
        min={-10}
        max={10}
        step={0.5}
        format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} px`}
        onChange={(v) => live.live({ expand: v })}
        onCommit={() => live.end("Grow / shrink edge")}
      />

      {order.length > 0 && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[12px] font-medium text-muted">Subject</legend>
          <label className="flex items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              checked={subjectAll}
              onChange={(e) => updateComposite("Subject", { subjectTrackIds: e.target.checked ? [] : order.slice(0, 1) })}
            />
            All visible objects
          </label>
          {!subjectAll &&
            order.map((id) => (
              <label key={id} className="flex items-center gap-2 pl-4 text-[12.5px] text-muted">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={composite.subjectTrackIds.includes(id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...composite.subjectTrackIds, id]
                      : composite.subjectTrackIds.filter((t) => t !== id);
                    updateComposite("Subject", { subjectTrackIds: next });
                  }}
                />
                <span className="size-2.5 rounded-[3px]" style={{ background: tracks[id]?.color }} />
                {tracks[id]?.name}
              </label>
            ))}
        </fieldset>
      )}
    </section>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format(v: number): string;
  onChange(v: number): void;
  onCommit(): void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="font-mono text-[11px] text-faint tabular">{format(value)}</span>
      </div>
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        onValueCommit={() => onCommit()}
      />
    </div>
  );
}
