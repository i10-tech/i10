"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Search } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { MenuIcon } from "@repo/ui/components/icon-morph/icon-morph"
import { Drawer, DrawerContent, DrawerTrigger } from "@repo/ui/components/drawer/drawer"
import { SidebarNav } from "@/components/sidebar-nav"
import { AccountBar } from "@/components/account-bar"
import { WorkspaceBar } from "@/components/workspace-bar"
import { Wordmark } from "@/components/wordmark"
import type { Attention, PlanSummary, TenantProfile } from "@/lib/types"
import { useResetWhen } from "@/lib/react"

/**
 * The top bar below the large breakpoint, and the drawer behind it.
 *
 * ⚠ IT CLOSES ON NAVIGATION, AND THAT HAS TO BE WIRED BY HAND. A client-side
 * route change does not unmount the sheet - Next swaps the page beneath it and
 * the drawer stays open over the thing you just asked for, which reads as the
 * tap not having registered. Watching `usePathname` is the only signal
 * available, because the links are plain `<Link>`s and closing in each one's
 * `onClick` would fire before the navigation and miss any that are triggered
 * some other way.
 *
 * ⚠ AND IT IS `lg:hidden` RATHER THAN A SEPARATE MOBILE TREE. One navigation
 * definition, rendered twice - see lib/nav.ts. A second hand-written list is
 * how a page ends up reachable on a laptop and invisible on a phone.
 */
export function MobileNav({
  tenant,
  plan,
  fallbackEmail,
  clerkEnabled,
  attention,
  usage,
}: {
  tenant: TenantProfile | null
  plan: PlanSummary | null
  fallbackEmail?: string | null
  clerkEnabled: boolean
  attention?: Promise<Attention["domains"] | null>
  /** The usage ring, rendered by the server - the same row as the desktop rail. */
  usage?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const pathname = usePathname()

  // See the block comment: a client-side route change does not unmount the
  // sheet, so it has to be closed by hand. Adjusted during render rather than
  // in an effect - an effect would paint the open drawer over the new page for
  // one frame before closing it.
  useResetWhen(pathname, () => setOpen(false))

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background px-3 lg:hidden">
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Open navigation">
            <MenuIcon state={open} size={18} aria-hidden />
          </Button>
        </DrawerTrigger>
        {/* Arc's drawer: its header is the title and the close button, so the
            workspace leads the body, like the desktop rail. */}
        <DrawerContent
          side="left"
          title="Navigation"
          description="Move around the i10 dashboard."
        >
          <div className="flex min-h-full flex-col gap-2">
            <WorkspaceBar tenant={tenant} clerkEnabled={clerkEnabled} />
            {/*
             * ⚠ ITS OWN `scope`, SO THE DRAWER'S ACTIVE HIGHLIGHT AND THE
             * DESKTOP RAIL'S ARE DIFFERENT OBJECTS. Both are mounted while the
             * drawer is open; sharing a `layoutId` would have Motion morph one
             * into the other across the screen every time either re-rendered.
             */}
            <div className="flex-1">
              <SidebarNav scope="drawer" attention={attention} />
            </div>
            <div className="border-t pt-2">
              <AccountBar
                clerkEnabled={clerkEnabled}
                plan={plan}
                fallbackEmail={fallbackEmail ?? null}
                usage={usage}
              />
            </div>
          </div>
        </DrawerContent>
      </Drawer>

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
          size="sm"
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
