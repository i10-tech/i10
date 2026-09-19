"use client"

import * as React from "react"
import { Check, Copy } from "lucide-react"
import { cn } from "cn"
import { Button } from "./button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

/*
 * Copying a value, which this product asks people to do more than most.
 *
 * API keys, message ids, DKIM public keys, DNS record values, webhook signing
 * secrets, verification tokens. Every one of them is a long opaque string that
 * is useless if it is one character wrong, and every one of them is the reason
 * somebody opens the console at all.
 *
 * ⚠ THE CLIPBOARD API IS NOT AVAILABLE ON HTTP, AND A DEV BUILD ON A LAN
 * ADDRESS IS HTTP. `navigator.clipboard` is gated on a secure context, so it is
 * simply `undefined` at http://192.168.x.x:3000 — the exact URL somebody uses
 * to check the console on their phone. The fallback below is the deprecated
 * `document.execCommand("copy")` against an off-screen textarea, which still
 * works everywhere and is the only thing that does in that context. Without it
 * the button silently does nothing on the one device where a person cannot
 * select the text by hand either.
 */

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied, or a context that lied about having the API. Fall
    // through — the legacy path below often still works.
  }

  try {
    const area = document.createElement("textarea")
    area.value = text
    // ⚠ OFF-SCREEN RATHER THAN `display: none`. A hidden element cannot hold a
    // selection, so `execCommand("copy")` copies nothing and reports success.
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.top = "-9999px"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/**
 * ⚠ THE CONFIRMATION IS THE ICON, NOT A TOAST. This button appears up to a
 * dozen times on a domain detail page; a toast per press would stack a column
 * of identical notifications over the records the person is copying. The
 * swap to a tick for two seconds is local, silent, and impossible to miss
 * because the cursor is already on it.
 */
export function useCopy(timeout = 2000) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // ⚠ CLEARED ON UNMOUNT. Copying and immediately navigating away otherwise
  // sets state on a component that is gone — React 19 no longer warns about it,
  // which makes it quieter rather than less wrong.
  React.useEffect(() => () => clearTimeout(timer.current), [])

  const copy = React.useCallback(
    async (value: string) => {
      const ok = await writeToClipboard(value)
      if (!ok) return false
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), timeout)
      return true
    },
    [timeout],
  )

  return { copied, copy }
}

/**
 * A copy icon with a tooltip.
 *
 * ⚠ IT REQUIRES A `TooltipProvider` ABOVE IT AND THERE IS NO TYPE THAT SAYS SO.
 * Radix's tooltip parts read their provider through a context whose consumer
 * THROWS when nothing provided it — so dropping this component into an app that
 * never mounted one does not degrade, it takes the page down. That is not
 * hypothetical: it is what replaced the two-factor step of the sign-up flow with
 * Next's built-in "This page couldn't load" screen, because apps/auth had no
 * provider and this is the only component in that app that contains a tooltip.
 *
 * ⚠ AND THE FIX IS AT THE ROOT RATHER THAN HERE, DELIBERATELY. Wrapping every
 * `Tooltip` in its own provider is what shadcn does upstream and it would make
 * this component self-sufficient — but Radix resolves to the NEAREST provider,
 * so it would also silently override the console's tuned `delayDuration={300}`
 * on every tooltip in the product. One provider per app, mounted in the root
 * layout, is the arrangement the console already had; apps/auth was simply
 * missing it.
 */
export function CopyButton({
  value,
  label = "Copy",
  className,
  size = "icon-sm",
  variant = "ghost",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "value" | "onClick"> & {
  value: string
  label?: string
}) {
  const { copied, copy } = useCopy()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size={size}
          variant={variant}
          className={cn("text-muted-foreground hover:text-foreground", className)}
          onClick={() => void copy(value)}
          /*
           * ⚠ THE ACCESSIBLE NAME CHANGES WITH THE STATE, WHICH IS HOW A SCREEN
           * READER GETS THE CONFIRMATION SIGHTED USERS GET FROM THE TICK. A
           * static "Copy" label means the only feedback is visual.
           */
          aria-label={copied ? "Copied" : label}
          {...props}
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A value and the button that copies it, as one unit.
 *
 * Used for anything a person is meant to take away rather than read: record
 * values, ids, secrets. The value is `select-all` so a click also selects the
 * whole thing, for people who copy with the keyboard.
 */
export function CopyField({
  value,
  display,
  className,
  mono = true,
  truncate = true,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  value: string
  /** Shown instead of `value`. For masked secrets and shortened ids. */
  display?: React.ReactNode
  mono?: boolean
  truncate?: boolean
}) {
  return (
    <div
      data-slot="copy-field"
      className={cn(
        "group flex min-w-0 items-center gap-1 rounded-md border bg-muted/40 py-1 pr-1 pl-2",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "min-w-0 flex-1 select-all text-sm",
          mono && "font-mono text-xs",
          truncate && "truncate",
        )}
        title={typeof display === "string" || display === undefined ? value : undefined}
      >
        {display ?? value}
      </span>
      <CopyButton value={value} size="icon-xs" />
    </div>
  )
}
