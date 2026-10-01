"use client"

import { PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { Kbd } from "@repo/ui/components/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { useRail } from "@/components/rail"

/** Collapse or expand the desktop rail. ⌘B does the same. */
export function RailToggle() {
  const { collapsed, toggle } = useRail()
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggle}
          aria-label={label}
          aria-expanded={!collapsed}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Icon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label} <Kbd>⌘B</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
