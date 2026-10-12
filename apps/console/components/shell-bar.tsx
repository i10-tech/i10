"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { Search } from "lucide-react"
import { Breadcrumb } from "@repo/ui/components/breadcrumb/breadcrumb"
import { Tooltip } from "@repo/ui/components/tooltip/tooltip"
import { Kbd } from "@repo/ui/components/i10/kbd"
import { ThemeSwitch } from "@repo/ui/components/theme-switch/theme-switch"
import { useTheme } from "next-themes"
import { useMounted } from "@/lib/react"
import { OPEN_COMMAND_MENU } from "@/components/command-menu"
import { NAV, SETTINGS_NAV } from "@/lib/nav"
import { useWorkspaceName } from "@/lib/workspace-name"

/**
 * The bar across the top of the content surface, as in Arc's app shell:
 * where you are (Arc's Breadcrumb, whose new crumbs slide in) and search.
 *
 * The path is workspace, then the section from the navigation, then the
 * record when the page is one (a domain, an email). The record's name is the
 * page's own title, read from `document.title` ("Your receipt · i10"), so a
 * detail page never has to pass it down.
 */
const SUFFIX = " · i10"

const SECTIONS = [...NAV, ...SETTINGS_NAV]
  .flatMap((group) => group.items)
  .filter((item) => item.href !== "/")
  // Longest first, so /settings/billing wins over /settings.
  .sort((a, b) => b.href.length - a.href.length)

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
  const pathname = usePathname()
  // Follows a rename at once. Arc's breadcrumb keys a crumb by its label, so
  // the new name runs its own crumb change: the old one leaves, the new one
  // arrives, and the crumbs after it glide to their new place.
  const workspace = useWorkspaceName(fromServer)
  const title = useDocumentTitle()

  const items = React.useMemo(() => {
    // ⚠ EVERY CRUMB HAS AN HREF, THE CURRENT ONE INCLUDED. A crumb that gains
    // or loses its link becomes a different element, and its label can then
    // only appear, not morph (see the note in breadcrumb.tsx).
    const crumbs: { label: string; href: string }[] = [{ label: workspace, href: "/" }]
    if (pathname === "/") {
      crumbs.push({ label: "Overview", href: "/" })
      return crumbs
    }
    const section = SECTIONS.find(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
    if (!section) return crumbs
    crumbs.push({ label: section.label, href: section.href })
    if (pathname !== section.href) {
      const record = title.endsWith(SUFFIX) ? title.slice(0, -SUFFIX.length) : ""
      if (record && record !== section.label)
        crumbs.push({ label: record, href: pathname })
    }
    return crumbs
  }, [pathname, title, workspace])

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
 * through a view transition (skipped under reduced motion, and where the
 * browser has none). Light and dark only; System lives on the appearance page.
 */
function AppearanceSwitch() {
  const { resolvedTheme, setTheme } = useTheme()
  const mounted = useMounted()
  if (!mounted) return <span className="size-[38px]" aria-hidden />
  return (
    <ThemeSwitch
      iconOnly
      variant="reveal"
      theme={resolvedTheme === "light" ? "light" : "dark"}
      onThemeChange={(next) => {
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        if (still || !document.startViewTransition) return setTheme(next)
        document.startViewTransition(() => setTheme(next))
      }}
    />
  )
}
