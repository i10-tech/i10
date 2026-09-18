"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * ⚠ THE TONE IS CARRIED BY THE BORDER AND THE ICON, NOT BY THE BACKGROUND, AND
 * THE RESTRAINT IS THE POINT. A solid green toast and a solid red one are the
 * house style of products that shout; this console is monochrome by decision —
 * see the state-colour note in styles/tokens.css — and its five colours are
 * spent on meaning rather than emphasis. A tinted surface at 7%, a border at
 * 45% and a full-strength icon give a toast an unmistakable colour at a glance
 * while leaving the text on the popover's own foreground, which is the only
 * value guaranteed to stay legible in both themes.
 *
 * ⚠ AND THE TINT IS `color-mix` AGAINST `--popover` RATHER THAN AN OPACITY ON
 * THE TOAST. Sonner stacks toasts with a real overlap; a translucent background
 * would let the toast underneath show through the one in front, which reads as
 * a rendering fault rather than as depth.
 *
 * ⚠ EVERY CLASS BELOW IS SPELLED OUT IN FULL, AND BUILDING THEM WITH A HELPER
 * IS THE ONE THING THAT MUST NOT HAPPEN HERE. Tailwind finds classes by
 * scanning source text for literal strings; a `tone(token)` that returned
 * `` `text-${token}` `` is unreadable to that scanner, so the utility is never
 * generated and the toast renders with no tint, no coloured border and no
 * coloured icon — with nothing in any build log to say so. The repetition is
 * the price of the classes existing at all.
 */
const TONES = {
  success: [
    "[--normal-bg:color-mix(in_oklch,var(--success)_7%,var(--popover))]",
    "[--normal-border:color-mix(in_oklch,var(--success)_45%,var(--border))]",
    "[&_[data-icon]]:text-success",
  ].join(" "),
  error: [
    "[--normal-bg:color-mix(in_oklch,var(--danger)_7%,var(--popover))]",
    "[--normal-border:color-mix(in_oklch,var(--danger)_45%,var(--border))]",
    "[&_[data-icon]]:text-danger",
  ].join(" "),
  warning: [
    "[--normal-bg:color-mix(in_oklch,var(--warning)_7%,var(--popover))]",
    "[--normal-border:color-mix(in_oklch,var(--warning)_45%,var(--border))]",
    "[&_[data-icon]]:text-warning",
  ].join(" "),
  info: [
    "[--normal-bg:color-mix(in_oklch,var(--info)_7%,var(--popover))]",
    "[--normal-border:color-mix(in_oklch,var(--info)_45%,var(--border))]",
    "[&_[data-icon]]:text-info",
  ].join(" "),
} as const

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      // ⚠ SET EXPLICITLY EVEN THOUGH IT IS SONNER'S DEFAULT. Bottom-right is a
      // decision here, not an inherited accident: a default is free to change
      // in a minor release, and a toast that silently relocates to the top of
      // the screen would cover the sign-in heading.
      position="bottom-right"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          /*
           * ⚠ THE DESCRIPTION IS FORCED TO THE MUTED FOREGROUND. Sonner's own
           * default inherits the toast's text colour, so on a tinted surface
           * the second line renders at full strength and competes with the
           * title — the opposite of the hierarchy a two-line toast exists for.
           */
          description: "text-muted-foreground",
          success: TONES.success,
          error: TONES.error,
          warning: TONES.warning,
          info: TONES.info,
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
