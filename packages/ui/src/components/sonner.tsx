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
 * ⚠ THE TONE IS CARRIED BY THE ICON ALONE (2026-10-03). Every toast is the
 * same popover surface with the same border, and only the glyph says success,
 * warning or failure - Linear's and Clerk's restraint. A tinted surface and a
 * coloured border per tone made four different-looking cards out of one
 * component, which is the inconsistency this console is removing.
 *
 * ⚠ EVERY CLASS BELOW IS SPELLED OUT IN FULL, AND BUILDING THEM WITH A HELPER
 * IS THE ONE THING THAT MUST NOT HAPPEN HERE. Tailwind finds classes by
 * scanning source text for literal strings; a `tone(token)` that returned
 * `` `text-${token}` `` is unreadable to that scanner, so the utility is never
 * generated and the icon renders uncoloured with nothing in any build log to
 * say so.
 */
const TONES = {
  success: "[&_[data-icon]]:text-success",
  error: "[&_[data-icon]]:text-danger",
  warning: "[&_[data-icon]]:text-warning",
  info: "[&_[data-icon]]:text-muted-foreground",
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
          toast: "shadow-lg! gap-3!",
          title: "font-medium",
          /*
           * ⚠ THE DESCRIPTION IS FORCED TO THE MUTED FOREGROUND. Sonner's own
           * default inherits the toast's text colour, so
           * the second line renders at full strength and competes with the
           * title - the opposite of the hierarchy a two-line toast exists for.
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
