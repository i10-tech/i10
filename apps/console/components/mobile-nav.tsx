"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu, Search } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@repo/ui/components/sheet"
import { Separator } from "@repo/ui/components/separator"
import { SidebarNav } from "@/components/sidebar-nav"
import { AccountBar } from "@/components/account-bar"
import { WorkspaceBar } from "@/components/workspace-bar"
import { Wordmark } from "@/components/wordmark"
import type { PlanSummary, TenantProfile } from "@/lib/types"
import { useResetWhen } from "@/lib/react"

/**
 * The top bar below the large breakpoint, and the drawer behind it.
 *
 * ⚠ IT CLOSES ON NAVIGATION, AND THAT HAS TO BE WIRED BY HAND. A client-side
 * route change does not unmount the sheet — Next swaps the page beneath it and
 * the drawer stays open over the thing you just asked for, which reads as the
 * tap not having registered. Watching `usePathname` is the only signal
 * available, because the links are plain `<Link>`s and closing in each one's
 * `onClick` would fire before the navigation and miss any that are triggered
 * some other way.
 *
 * ⚠ AND IT IS `lg:hidden` RATHER THAN A SEPARATE MOBILE TREE. One navigation
 * definition, rendered twice — see lib/nav.ts. A second hand-written list is
 * how a page ends up reachable on a laptop and invisible on a phone.
 */
export function MobileNav({
  tenant,
  plan,
  clerkEnabled,
}: {
  tenant: TenantProfile | null
  plan: PlanSummary | null
  clerkEnabled: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const pathname = usePathname()

  // See the block comment: a client-side route change does not unmount the
  // sheet, so it has to be closed by hand. Adjusted during render rather than
  // in an effect — an effect would paint the open drawer over the new page for
  // one frame before closing it.
  useResetWhen(pathname, () => setOpen(false))

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background px-3 lg:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Open navigation">
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="flex w-72 flex-col bg-sidebar p-0">
          <SheetHeader className="h-14 justify-center border-b px-4">
            <SheetTitle className="text-left">
              <Wordmark />
            </SheetTitle>
            {/*
             * ⚠ PRESENT BUT VISUALLY HIDDEN. Radix warns in the console when a
             * Dialog has no description, and more importantly a screen reader
             * announces the drawer with no context at all without one.
             */}
            <SheetDescription className="sr-only">
              Navigate the i10 console.
            </SheetDescription>
          </SheetHeader>

          <div className="px-2 py-2">
            <WorkspaceBar tenant={tenant} plan={plan} clerkEnabled={clerkEnabled} />
          </div>
          <Separator />
          {/*
           * ⚠ `flex-1` AND `min-h-0` SO THE ACCOUNT ROW CAN BE PINNED BELOW IT.
           * Without `min-h-0` a flex child with overflow refuses to shrink past
           * its content, so a long navigation pushes the account row off the
           * bottom of the drawer rather than scrolling inside it.
           */}
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            <SidebarNav />
          </div>

          {/* The same reading order as the desktop rail: workspace, then where
              to go, then who I am. */}
          {clerkEnabled && (
            <div className="border-t p-2">
              <AccountBar />
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Link href="/" className="flex items-center">
        <Wordmark />
      </Link>

      <div className="ml-auto">
        {/*
         * ⚠ IT DISPATCHES THE KEYBOARD EVENT RATHER THAN HOLDING THE DIALOG'S
         * STATE. The command menu owns its own open state and is mounted once
         * at the shell; lifting that state into a context so a button could
         * set it would re-render the whole shell on every keystroke inside the
         * palette. Synthesising the shortcut is one line and keeps the
         * ownership where it is.
         */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open the command menu"
          onClick={() =>
            document.dispatchEvent(
              new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
            )
          }
        >
          <Search />
        </Button>
      </div>
    </header>
  )
}
