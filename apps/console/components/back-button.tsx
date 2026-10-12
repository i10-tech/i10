"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { Kbd } from "@repo/ui/components/i10/kbd"
import { Tooltip } from "@repo/ui/components/tooltip/tooltip"

/**
 * The arrow before a detail page's title: back to the list it came from, with
 * the arrow leaning the way it goes on hover. Esc does the same, unless
 * something on the page has a use for it - a field, a dialog, a menu, a
 * selection.
 */
export function BackButton({ href, label }: { href: string; label: string }) {
  const router = useRouter()
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          "input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]",
        )
      )
        return
      if (
        document.querySelector(
          "[role=dialog], [role=menu], [role=listbox], [role=toolbar][aria-label^=Selected]",
        )
      )
        return
      router.push(href)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [href, router])

  return (
    <Tooltip
      content={
        <>
          {label} <Kbd className="ml-1">Esc</Kbd>
        </>
      }
    >
      <ButtonLink
        href={href}
        variant="ghost"
        size="sm"
        aria-label={label}
        className="group/back shrink-0"
      >
        <ArrowLeft className="transition-transform duration-200 ease-out group-hover/back:-translate-x-0.5" />
      </ButtonLink>
    </Tooltip>
  )
}
