"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ExternalLink, Moon, Plus, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import {
  CommandPalette,
  type CommandItem,
} from "@repo/ui/components/command-palette/command-palette"
import { allDestinations } from "@/lib/nav"

/**
 * ⌘K.
 *
 * ⚠ IT IS NAVIGATION AND ACTIONS, NOT SEARCH, AND THE DISTINCTION KEEPS IT
 * FAST. A palette that queries the API on every keystroke is a palette with a
 * spinner in it, and the thing people actually use it for - getting to Domains
 * in under a second - is the thing the spinner ruins. Searching a customer's
 * mail is what the Emails page's own search field is for, where the results have
 * room to be useful.
 *
 * ⚠ AND THE LISTENER IS BOUND ONCE, AT THE SHELL. Mounting this per page would
 * stack a keydown handler on every client-side navigation and open several
 * dialogs on one press.
 */
/**
 * Opens the menu from anywhere without a shared store: the rail's Search row
 * dispatches it on `window`, and the menu is mounted once per shell.
 */
export const OPEN_COMMAND_MENU = "i10:open-command-menu"

export function CommandMenu() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()
  const { setTheme, resolvedTheme } = useTheme()

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      /*
       * ⚠ `metaKey || ctrlKey`, BECAUSE THE SAME SHORTCUT IS ⌘K ON A MAC AND
       * Ctrl+K EVERYWHERE ELSE. Binding only the meta key makes the feature
       * invisible to every Windows and Linux customer, and they are the half
       * that reads the hint in the sidebar and tries it.
       *
       * ⚠ AND `event.key.toLowerCase()` BECAUSE A CAPS-LOCKED KEYBOARD SENDS
       * "K". Comparing against the lowercase literal alone silently breaks the
       * shortcut for anybody with caps lock on, which is a bug report nobody
       * ever files and everybody blames on themselves.
       */
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((prev) => !prev)
      }
    }

    const onOpen = () => setOpen(true)

    document.addEventListener("keydown", onKeyDown)
    window.addEventListener(OPEN_COMMAND_MENU, onOpen)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener(OPEN_COMMAND_MENU, onOpen)
    }
  }, [])

  const go = React.useCallback(
    (href: string) => {
      // ⚠ CLOSED FIRST, THEN NAVIGATED. Navigating while the dialog is open
      // leaves Radix mid-transition on a tree that is being replaced, and the
      // focus trap occasionally survives it - the new page renders and the
      // keyboard still belongs to a dialog that is no longer visible.
      setOpen(false)
      router.push(href)
    },
    [router],
  )

  const destinations = React.useMemo(() => allDestinations(), [])

  const dark = resolvedTheme === "dark"
  const items = React.useMemo<CommandItem[]>(
    () => [
      {
        id: "/domains/new",
        label: "Add a domain",
        group: "Create",
        icon: <Plus />,
        keywords: ["new", "sending"],
      },
      {
        id: "/api-keys?new=1",
        label: "Create an API key",
        group: "Create",
        icon: <Plus />,
        keywords: ["new", "token"],
      },
      {
        id: "/webhooks?new=1",
        label: "Add a webhook endpoint",
        group: "Create",
        icon: <Plus />,
        keywords: ["new"],
      },
      {
        id: "/broadcasts/new",
        label: "Write a broadcast",
        group: "Create",
        icon: <Plus />,
        keywords: ["new", "campaign"],
      },
      ...destinations.map((item) => ({
        id: item.href,
        label: item.label,
        group: "Go to",
        icon: <item.icon />,
        keywords: item.keywords ?? [],
      })),
      {
        id: "theme",
        label: `Switch to ${dark ? "light" : "dark"} theme`,
        group: "Preferences",
        icon: dark ? <Sun /> : <Moon />,
        keywords: ["appearance", "dark", "light"],
      },
      {
        id: "docs",
        label: "Documentation",
        description: "docs.i10.tech",
        group: "Preferences",
        icon: <ExternalLink />,
        keywords: ["api", "reference", "help"],
      },
    ],
    [destinations, dark],
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        title="Command menu"
        description="Jump to a page or start something new."
        style={{ width: "min(calc(100vw - 2rem), 560px)" }}
      >
        <CommandPalette
          items={items}
          autoFocus
          placeholder="Jump to, or create"
          onClose={() => setOpen(false)}
          onSelect={(item) => {
            if (item.id === "theme") {
              setTheme(dark ? "light" : "dark")
              setOpen(false)
            } else if (item.id === "docs") {
              window.open("https://docs.i10.tech", "_blank", "noopener,noreferrer")
              setOpen(false)
            } else go(item.id)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
