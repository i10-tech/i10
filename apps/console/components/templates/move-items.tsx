"use client"

import { Folder, FolderInput, Library } from "lucide-react"
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@repo/ui/components/i10/menu"
import type { MoveTarget } from "@/lib/template-tree"

/**
 * The destinations a "Move to" menu offers: All templates, then every folder
 * indented by how deep it is. `lib/template-tree.moveTargets` has already left
 * out the ones that cannot take the load.
 */
export function MoveItems({
  targets,
  onMove,
}: {
  targets: MoveTarget[]
  onMove: (to: string | null) => void
}) {
  return (
    <>
      {targets.map((t) => (
        <DropdownMenuItem
          key={t.to ?? "root"}
          onSelect={() => onMove(t.to)}
          style={{ paddingLeft: 11 + t.depth * 14 }}
        >
          {t.to === null ? <Library /> : <Folder />}
          <span className="truncate">{t.label}</span>
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** "Move to" as a submenu of an item's menu; nothing when there is nowhere to go. */
export function MoveSubmenu({
  targets,
  onMove,
}: {
  targets: MoveTarget[]
  onMove: (to: string | null) => void
}) {
  if (targets.length === 0) return null
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput />
        Move to
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
        <MoveItems targets={targets} onMove={onMove} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
