"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "cn"
import { isActive, SETTINGS_NAV } from "@/lib/nav"

/**
 * ⚠ HORIZONTAL AND SCROLLABLE BELOW `lg`, VERTICAL ABOVE IT. A vertical list of
 * eight links above the content on a phone means scrolling past the navigation
 * to reach the thing you navigated to. A horizontal scroller keeps the content
 * at the top of the viewport, which is where somebody who just tapped "Billing"
 * is looking.
 */
export function SettingsNav() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Settings"
      className="mb-6 flex gap-1 overflow-x-auto border-b pb-2 lg:mb-0 lg:flex-col lg:gap-5 lg:border-b-0 lg:pb-0"
    >
      {SETTINGS_NAV.map((group, index) => (
        <div
          key={group.label ?? index}
          className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5"
        >
          {group.label && (
            <h2 className="hidden px-2 pb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase lg:block">
              {group.label}
            </h2>
          )}
          {group.items.map((item) => {
            const active = isActive(pathname, item)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm whitespace-nowrap transition-colors",
                  "duration-(--duration-instant) ease-(--ease-linear)",
                  active
                    ? "bg-secondary font-medium text-secondary-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <item.icon className="size-3.5 shrink-0" />
                {item.label}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
