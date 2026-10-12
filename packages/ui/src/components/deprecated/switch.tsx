"use client"

import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"

/**
 * ⚠ GREEN WHEN ON, GREY WHEN OFF, IN BOTH THEMES (2026-10-03). It was the
 * primary colour on and the input grey off, which in the dark theme is white
 * against near-white - a toggle you had to study to read. Every switch in the
 * console is this one, so on and off read the same everywhere, as Resend's do.
 *
 * ⚠ THE TRACK IS BIGGER THAN THE THUMB ON EVERY SIDE. The thumb used to fill
 * the track's height, so the colour was a sliver behind a white disc and the
 * switch read as a button with a stripe. A 2px inset all round frames the thumb
 * in the track's colour, which is what makes it look like a switch - iOS and
 * Resend both draw it that way.
 *
 * ⚠ THE NUMBERS AGREE BY CONSTRUCTION: track = thumb + 2 x 2px inset, and the
 * travel is track width - thumb - 2 x inset. Default 40x24 with a 20px thumb
 * travels 16px; small 28x16 with a 12px thumb travels 12px. Change one and
 * the thumb stops short of the end or overshoots it.
 */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full p-0.5 outline-none",
        "data-[size=default]:h-6 data-[size=default]:w-10 data-[size=sm]:h-4 data-[size=sm]:w-7",
        // A colour change, so a linear ramp; the thumb's slide is eased below.
        "transition-colors duration-200 ease-out",
        // The track sits slightly below the surface: an inner shadow, not a border.
        "shadow-[inset_0_1px_2px_rgb(0_0_0/0.18)]",
        "data-[state=unchecked]:bg-black/12 dark:data-[state=unchecked]:bg-white/14",
        "data-[state=unchecked]:hover:bg-black/16 dark:data-[state=unchecked]:hover:bg-white/18",
        "data-[state=checked]:bg-emerald-500 data-[state=checked]:hover:bg-emerald-500/90",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-white",
          "group-data-[size=default]/switch:size-5 group-data-[size=sm]/switch:size-3",
          // Lifted off the track: a soft drop and a hairline so it holds its
          // edge against the pale off-track in the light theme.
          "shadow-[0_1px_3px_rgb(0_0_0/0.25),0_0_0_0.5px_rgb(0_0_0/0.06)]",
          // ⚠ AN EASE-OUT SLIDE, NOT THE DEFAULT LINEAR ONE. It leaves fast and
          // settles into the end, which is the difference between a thumb that
          // moves and one that snaps across.
          "transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
          "data-[state=unchecked]:translate-x-0",
          "group-data-[size=default]/switch:data-[state=checked]:translate-x-4",
          "group-data-[size=sm]/switch:data-[state=checked]:translate-x-3",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
