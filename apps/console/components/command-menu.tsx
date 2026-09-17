"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ExternalLink, Moon, Plus, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@repo/ui/components/command"
import { allDestinations } from "@/lib/nav"

/**
 * ⌘K.
 *
 * ⚠ IT IS NAVIGATION AND ACTIONS, NOT SEARCH, AND THE DISTINCTION KEEPS IT
 * FAST. A palette that queries the API on every keystroke is a palette with a
 * spinner in it, and the thing people actually use it for — getting to Domains
 * in under a second — is the thing the spinner ruins. Searching a customer's
 * mail is what the Emails page's own search field is for, where the results have
 * room to be useful.
 *
 * ⚠ AND THE LISTENER IS BOUND ONCE, AT THE SHELL. Mounting this per page would
 * stack a keydown handler on every client-side navigation and open several
 * dialogs on one press.
 */
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

    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  const go = React.useCallback(
    (href: string) => {
      // ⚠ CLOSED FIRST, THEN NAVIGATED. Navigating while the dialog is open
      // leaves Radix mid-transition on a tree that is being replaced, and the
      // focus trap occasionally survives it — the new page renders and the
      // keyboard still belongs to a dialog that is no longer visible.
      setOpen(false)
      router.push(href)
    },
    [router],
  )

  const destinations = React.useMemo(() => allDestinations(), [])

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command menu"
      description="Jump to a page or start something new."
    >
      <CommandInput placeholder="Jump to, or create…" />
      <CommandList>
        <CommandEmpty>Nothing matches that.</CommandEmpty>

        <CommandGroup heading="Create">
          <CommandItem
            value="new domain add sending"
            onSelect={() => go("/domains/new")}
          >
            <Plus />
            Add a domain
          </CommandItem>
          <CommandItem value="new api key token" onSelect={() => go("/api-keys?new=1")}>
            <Plus />
            Create an API key
          </CommandItem>
          <CommandItem
            value="new webhook endpoint"
            onSelect={() => go("/webhooks?new=1")}
          >
            <Plus />
            Add a webhook endpoint
          </CommandItem>
          <CommandItem
            value="new broadcast campaign"
            onSelect={() => go("/broadcasts/new")}
          >
            <Plus />
            Write a broadcast
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Go to">
          {destinations.map((item) => (
            <CommandItem
              key={item.href}
              /*
               * ⚠ THE KEYWORDS ARE IN `value`, WHICH IS WHAT cmdk MATCHES ON.
               * Putting them in a hidden span would make them visible to the
               * matcher only by accident of text extraction, and invisible to
               * it entirely once the label is wrapped in another element. This
               * is why "dkim" finds Domains and "token" finds API keys.
               */
              value={`${item.label} ${(item.keywords ?? []).join(" ")}`}
              onSelect={() => go(item.href)}
            >
              <item.icon />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Preferences">
          <CommandItem
            value="theme dark light appearance toggle"
            onSelect={() => {
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
              setOpen(false)
            }}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            Switch to {resolvedTheme === "dark" ? "light" : "dark"} theme
          </CommandItem>
          <CommandItem
            value="documentation docs api reference help"
            onSelect={() => {
              // ⚠ A FULL NAVIGATION, NOT `router.push`. The docs are a separate
              // origin; the Next router would try to resolve it as a route and
              // 404 in the client.
              window.open("https://docs.i10.tech", "_blank", "noopener,noreferrer")
              setOpen(false)
            }}
          >
            <ExternalLink />
            Documentation
            <CommandShortcut>↗</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
