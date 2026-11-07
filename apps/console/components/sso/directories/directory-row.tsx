"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Badge, type BadgeTone } from "@repo/ui/components/badge/badge"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import type { SsoAbilities, SsoDirectory } from "@/lib/sso-types"
import { IdpMark } from "../idp-mark"
import type { useSsoCall } from "../shared"
import { DirectoryDetail } from "./directory-detail"
import { directoryStateText } from "./types"

function badgeFor(d: SsoDirectory): { label: string; tone: BadgeTone } {
  if (!d.enabled) return { label: "Off", tone: "warning" }
  if (d.conflicts > 0)
    return {
      label: `${d.conflicts} ${d.conflicts === 1 ? "conflict" : "conflicts"}`,
      tone: "danger",
    }
  if (d.lastSyncError) return { label: "Sync error", tone: "danger" }
  return { label: "On", tone: "success" }
}

export function DirectoryRow({
  directory,
  abilities,
  onChange,
  reload,
  call,
}: {
  directory: SsoDirectory
  abilities: SsoAbilities
  onChange: (directory: SsoDirectory) => void
  reload: () => Promise<void>
  call: ReturnType<typeof useSsoCall>
}) {
  const [open, setOpen] = React.useState(false)
  const reduced = useReducedMotion()
  const badge = badgeFor(directory)
  const stateText = directoryStateText(directory)

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors duration-150 hover:bg-muted/50"
      >
        <IdpMark idp={directory.provider} className="size-9" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{directory.name}</span>
          <span className="block truncate text-muted-foreground">{stateText}</span>
        </span>
        <Badge tone={badge.tone} size="sm">
          {badge.label}
        </Badge>
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}
        >
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </motion.span>
      </button>

      <Reveal show={open} spacing="px-4 pb-4">
        <DirectoryDetail
          directory={directory}
          abilities={abilities}
          onChange={onChange}
          reload={reload}
          call={call}
        />
      </Reveal>
    </li>
  )
}
