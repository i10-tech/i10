"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Badge, type BadgeTone } from "@repo/ui/components/badge/badge"
import { Bone } from "@repo/ui/components/bone/bone"
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
  /** Absent while loading: the same row, drawn with a bar for each piece. */
  directory?: SsoDirectory
  abilities: SsoAbilities
  onChange: (directory: SsoDirectory) => void
  reload: () => Promise<void>
  call: ReturnType<typeof useSsoCall>
}) {
  const [open, setOpen] = React.useState(false)
  const reduced = useReducedMotion()
  const badge = directory ? badgeFor(directory) : null
  const stateText = directory ? directoryStateText(directory) : ""

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors duration-150 hover:bg-muted/50"
      >
        <Bone id="mark" shape="box" width={36} height={36} radius={8} inline>
          {directory && <IdpMark idp={directory.provider} className="size-9" />}
        </Bone>
        <span className="min-w-0 flex-1">
          <Bone id="name" width={140} lineHeight={20}>
            {directory && (
              <span className="block truncate font-medium">{directory.name}</span>
            )}
          </Bone>
          <Bone id="state" width={100} lineHeight={20}>
            {directory && (
              <span className="block truncate text-muted-foreground">{stateText}</span>
            )}
          </Bone>
        </span>
        <Bone id="status" shape="box" width={60} height={22} radius={4} inline>
          {badge && (
            <Badge tone={badge.tone} size="sm">
              {badge.label}
            </Badge>
          )}
        </Bone>
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}
        >
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </motion.span>
      </button>

      <Reveal show={open} spacing="px-4 pb-4">
        {directory && (
          <DirectoryDetail
            directory={directory}
            abilities={abilities}
            onChange={onChange}
            reload={reload}
            call={call}
          />
        )}
      </Reveal>
    </li>
  )
}
