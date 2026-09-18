"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { cn } from "cn"
import { inSettings, isActive, NAV, SETTINGS_NAV, type NavGroup } from "@/lib/nav"

/**
 * The left rail.
 *
 * ⚠ A CLIENT COMPONENT ONLY BECAUSE OF `usePathname`, AND THAT IS THE WHOLE
 * REASON. Everything else about it is static. Rendering the whole shell on the
 * client to get an active state would ship the navigation, the icons and the
 * workspace switcher as JavaScript on every page; this way the layout around it
 * stays a server component and only the highlight costs anything.
 *
 * ⚠ THE ACTIVE ITEM IS A FILLED ROW, NOT A LEFT BORDER OR A COLOURED LABEL.
 * A border shifts the text by however many pixels wide it is unless every other
 * row carries a transparent one, which is the kind of detail that gets lost in
 * a refactor and produces a nav that twitches as you move through it. A
 * background fill changes nothing about layout.
 */
export function SidebarNav({ groups }: { groups?: NavGroup[] }) {
  const pathname = usePathname()

  /*
   * ⚠ THE RAIL SWAPS RATHER THAN THE PAGE GROWING A SECOND COLUMN. Settings
   * used to render its own narrow nav inside the content area, so on a settings
   * page the screen carried two vertical lists of links a few pixels apart —
   * one for the console, one for settings — and the eye had to work out which
   * of them it was reading. Replacing the rail keeps exactly one navigation on
   * screen at a time, and the back link is what the main rail's continued
   * presence used to provide.
   *
   * ⚠ DECIDED FROM THE PATH, IN THE ONE COMPONENT THAT ALREADY KNOWS IT. The
   * shell is a server component and cannot read the pathname; threading it down
   * as a prop would mean the layout re-rendering on every navigation. This
   * component is already a client component for the active highlight, so the
   * branch is free.
   */
  const settings = groups === undefined && inSettings(pathname)
  const shown = groups ?? (settings ? SETTINGS_NAV : NAV)

  return (
    <nav
      className="flex flex-col gap-5 px-2 py-1"
      aria-label={settings ? "Settings" : "Primary"}
    >
      {settings && (
        /*
         * ⚠ "Back to the dashboard" RATHER THAN A BARE ARROW. An arrow alone in a
         * sidebar reads as "collapse", and somebody who clicks it expecting a
         * narrower rail and lands on the overview has lost their place. It also
         * has to be the first focusable thing in the rail, so keyboard users
         * reach the way out before the eight settings pages.
         */
        <Link
          href="/"
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
            "duration-(--duration-instant) ease-(--ease-linear)",
            "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
          )}
        >
          <ArrowLeft className="size-4 shrink-0" />
          <span className="truncate">Back to the dashboard</span>
        </Link>
      )}

      {shown.map((group, i) => (
        <div key={group.label ?? `group-${i}`} className="flex flex-col gap-0.5">
          {group.label && (
            <h2 className="px-2 pt-1 pb-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              {group.label}
            </h2>
          )}
          {group.items
            .filter((item) => !item.hidden)
            .map((item) => {
              const active = isActive(pathname, item)
              const Icon = item.icon

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  // ⚠ `aria-current="page"` IS THE ACCESSIBLE HALF OF THE
                  // HIGHLIGHT. The background fill tells a sighted person where
                  // they are; without this a screen reader reads twelve
                  // identical links.
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
                    // ⚠ COLOUR ONLY, SO `--ease-linear` IS CORRECT HERE. The
                    // motion rules reserve eased curves for things that MOVE;
                    // a linear ramp on a background is exactly what Base's
                    // fifth timing row is for.
                    "duration-(--duration-instant) ease-(--ease-linear)",
                    active
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              )
            })}
        </div>
      ))}
    </nav>
  )
}
