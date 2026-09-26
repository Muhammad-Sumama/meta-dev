"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";
import { cn } from "@/lib/utils/cn";

function Slider({ className, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const values = props.value ?? props.defaultValue ?? [0];
  return (
    <SliderPrimitive.Root
      className={cn("relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-border-strong">
        <SliderPrimitive.Range className="absolute h-full bg-accent/80" />
      </SliderPrimitive.Track>
      {values.map((_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          aria-label={props["aria-label"]}
          className="block size-3.5 rounded-full border-2 border-accent bg-panel shadow transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
