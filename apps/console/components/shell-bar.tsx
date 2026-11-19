"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { Search } from "lucide-react"
import { Breadcrumb } from "@repo/ui/components/breadcrumb/breadcrumb"
import { Tooltip } from "@repo/ui/components/tooltip/tooltip"
import { Kbd } from "@repo/ui/components/i10/kbd"
import { ThemeSwitch } from "@repo/ui/components/theme-switch/theme-switch"
import { switchTheme } from "@/lib/switch-theme"
import { useTheme } from "next-themes"
import { useMounted } from "@/lib/react"
import { OPEN_COMMAND_MENU } from "@/components/command-menu"
import { useWorkspaceName } from "@/lib/workspace-name"
import { useWorkspaceSwitch } from "@/lib/workspace-switch"
import { buildBreadcrumbs } from "@/lib/breadcrumbs"
import { useDestinationPathname } from "@/lib/pending-navigation"

/**
 * The bar across the top of the content surface, as in Arc's app shell:
 * where you are (Arc's Breadcrumb, whose new crumbs slide in) and search.
 *
 * The path is workspace, then the section from the navigation, then the
 * record when the page is one (a domain, an email). The record's name is the
 * page's own title, read from `document.title` ("Your receipt · i10"), so a
 * detail page never has to pass it down.
 */
function useDocumentTitle(): string {
  const [title, setTitle] = React.useState("")
  React.useEffect(() => {
    const read = () => setTitle(document.title)
    read()
    const head = document.querySelector("head")
    if (!head) return
    const observer = new MutationObserver(read)
    observer.observe(head, { subtree: true, childList: true, characterData: true })
    return () => observer.disconnect()
  }, [])
  return title
}

export function ShellBar({ workspace: fromServer }: { workspace: string }) {
  const committed = usePathname()
  // The click's destination, so the crumbs change with the skeleton. Its title
  // is not known yet: the document's is still the page being left.
  const pathname = useDestinationPathname()
  const going = pathname !== committed
  const { pending } = useWorkspaceSwitch()
  // Follows a rename at once. Arc's breadcrumb keys a crumb by its label, so
  // the new name runs its own crumb change: the old one leaves, the new one
  // arrives, and the crumbs after it glide to their new place.
  const workspaceName = useWorkspaceName(fromServer)
  const workspace = pending?.name ?? workspaceName
  const title = useDocumentTitle()

  const items = React.useMemo(
    () => buildBreadcrumbs({ workspace, pathname, title: going ? "" : title }),
    [pathname, title, workspace, going],
  )

  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--border-subtle)] px-4 sm:px-6">
      <div className="min-w-0 truncate">
        <Breadcrumb items={items} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Tooltip content="Search and commands">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_MENU))}
            className="flex h-[38px] shrink-0 items-center gap-2 rounded-[12px] border border-[var(--border)] px-3 text-sm text-muted-foreground transition-colors duration-(--duration-fast) hover:border-[var(--border-strong)] hover:text-foreground"
            aria-label="Search and commands"
          >
            <Search className="size-4" />
            <span className="hidden sm:inline">Search</span>
            <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
          </button>
        </Tooltip>
        <AppearanceSwitch />
      </div>
    </div>
  )
}

/**
 * Arc's theme switch: the sun and moon trade places, and the page crossfades
 * through a view transition (skipped under reduced motion and where the
 * browser has none), via lib/switch-theme.ts. Light and dark only; System
 * lives on the appearance page.
 *
 * ⚠ SAFARI SWITCHES INSTANTLY (the user's call, 2026-11-19). Its view
 * transition pictures leave out `backdrop-filter`, so the templates page's
 * frosted folders could not survive a crossfade; pre-blurred stand-ins and
 * lifting the folders out of the fade were both tried, and Safari draws a
 * named element's new picture blank. switch-theme.ts still keeps the instant
 * switch to one restyle.
 */
const WEBKIT_ONLY =
  typeof navigator !== "undefined" &&
  /AppleWebKit/.test(navigator.userAgent) &&
  !/\b(Chrome|Chromium)\//.test(navigator.userAgent)

function AppearanceSwitch() {
  const { resolvedTheme, setTheme } = useTheme()
  const mounted = useMounted()
  if (!mounted) return <span className="size-[38px]" aria-hidden />
  return (
    <ThemeSwitch
      iconOnly
      variant="reveal"
      theme={resolvedTheme === "light" ? "light" : "dark"}
      onThemeChange={(next) => switchTheme(next, setTheme, { crossfade: !WEBKIT_ONLY })}
    />
  )
}
