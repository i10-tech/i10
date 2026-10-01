"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Kbd } from "@repo/ui/components/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"

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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          asChild
          aria-label={label}
          className="group/back shrink-0"
        >
          <Link href={href}>
            <ArrowLeft className="transition-transform duration-200 ease-out group-hover/back:-translate-x-0.5" />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd className="ml-1">Esc</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
