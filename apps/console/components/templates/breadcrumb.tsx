"use client"

import * as React from "react"
import Link from "next/link"
import { AnimatePresence, motion } from "motion/react"
import { ChevronRight, MoreHorizontal, Trash2 } from "lucide-react"
import { Bone } from "@repo/ui/components/bone/bone"
import { Button } from "@repo/ui/components/button/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/i10/menu"
import { Tooltip } from "@repo/ui/components/tooltip/tooltip"
import { cn } from "cn"
import { RenameIcon } from "@/components/templates/cards"
import { collapsePath } from "@/lib/template-tree"
import type { TemplateFolder } from "@/lib/types"

const folderHref = (id: string) => `/templates/folder/${encodeURIComponent(id)}`

const crumbClass = cn(
  "block max-w-44 truncate rounded-md px-1.5 py-0.5 whitespace-nowrap text-muted-foreground",
  "transition-colors hover:text-foreground",
)
const OVER = "bg-primary/10 text-foreground ring-2 ring-primary/60"

/**
 * Where we are, as a path: All templates, each folder above this one, then this
 * one with its actions. Only inside a folder: a search from the top says what
 * it found in the toolbar, so starting one must not push the page down.
 *
 * ⚠ EVERY CRUMB BUT THE LAST IS A LINK AND A DROP TARGET (`data-drop-to`), so a
 * template or a folder can be dropped straight onto any level above. The
 * folder you are in is not: everything on screen is already there.
 *
 * ⚠ PAST THREE FOLDERS THE MIDDLE FOLDS INTO ONE MENU (lib/template-tree
 * collapsePath), so the path stays on one line. While the folder loads,
 * `depth` draws the same shape from bones.
 *
 * ⚠ THE CRUMBS ARE MARKED `data-no-gesture` ONE BY ONE, NOT THE WHOLE ROW: the
 * row's empty space starts a selection box like the rest of the page.
 */
export function Breadcrumb({
  folderId,
  trail,
  depth,
  loading,
  searching,
  over,
  onRoot,
  onRename,
  onDelete,
}: {
  folderId: string | null
  /** The path from the top to the folder on screen, itself last; empty until known. */
  trail: TemplateFolder[]
  /** How many folders are above this one: how many crumbs a skeleton draws. */
  depth: number
  loading: boolean
  searching: boolean
  /** The drop target a gesture is over: a folder's id, or `root`. */
  over: string | null
  onRoot: () => void
  onRename: (folder: TemplateFolder) => void
  onDelete: (folder: TemplateFolder) => void
}) {
  const folder = trail.length > 0 ? trail[trail.length - 1]! : null
  const ancestors: (TemplateFolder | undefined)[] = loading
    ? Array.from({ length: depth }, () => undefined)
    : trail.slice(0, -1)
  const { shown, folded, at } = collapsePath(ancestors)
  const onPath = Boolean(folder || (loading && folderId)) && !searching

  return (
    <AnimatePresence initial={false}>
      {folderId && (
        <motion.nav
          aria-label="Breadcrumb"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          // ⚠ A 4px BLEED ROUND THE CLIPPING BOX (2026-10-04). It clips for the
          // height animation, and the drop target's ring sits 2px outside
          // "All templates" - so dragging a template onto it drew the ring
          // with its left edge cut off. Pulled out and padded back by the
          // same amount, nothing moves and the ring has room.
          className="-mx-1 overflow-hidden px-1 pb-1"
        >
          <ol className="flex items-center gap-1.5 pt-5 text-sm whitespace-nowrap">
            <li className="shrink-0">
              <Link
                href="/templates"
                data-drop-to="root"
                data-no-gesture
                className={cn(crumbClass, "max-w-none", over === "root" && OVER)}
                onClick={onRoot}
              >
                All templates
              </Link>
            </li>
            {onPath && (
              <>
                {shown.map((f, i) => (
                  <React.Fragment key={f ? f.id : `crumb-${i}`}>
                    {i === at && folded.length > 0 && (
                      <Folded folders={folded} loading={loading} />
                    )}
                    <Chevron />
                    <li className="min-w-0">
                      {f ? (
                        <Link
                          href={folderHref(f.id)}
                          data-drop-to={f.id}
                          data-no-gesture
                          className={cn(crumbClass, over === f.id && OVER)}
                          onClick={onRoot}
                        >
                          <Bone id={`crumb-${i}`} lineHeight={20} width={80} inline>
                            {f.name}
                          </Bone>
                        </Link>
                      ) : (
                        <a aria-hidden tabIndex={-1} className={crumbClass}>
                          <Bone id={`crumb-${i}`} lineHeight={20} width={80} inline />
                        </a>
                      )}
                    </li>
                  </React.Fragment>
                ))}
                <Chevron />
                <li className="max-w-64 min-w-0 truncate font-medium">
                  <Bone id="folder-name" lineHeight={20} width={100} inline>
                    {folder?.name}
                  </Bone>
                </li>
                {/*
                 * ⚠ THE MENU'S BUTTON IS THERE WHILE THE FOLDER LOADS, DIMMED
                 * (2026-11-18). It came with the folder: the 32px button is taller
                 * than the name's line, so the breadcrumb grew and every template
                 * under it jumped down as the folder arrived. SKIPPED BY
                 * test/skeleton-parity: only the loaded one carries the menu.
                 */}
                <li data-skeleton="skip" className="shrink-0">
                  {!folder ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label="Folder actions"
                      disabled
                    >
                      <MoreHorizontal />
                    </Button>
                  ) : (
                    <DropdownMenu modal={false}>
                      <Tooltip content="Folder actions">
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="secondary"
                            size="sm"
                            aria-label="Folder actions"
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                      </Tooltip>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem onSelect={() => onRename(folder)}>
                          <RenameIcon />
                          Rename folder
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => onDelete(folder)}
                        >
                          <Trash2 />
                          Delete folder
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              </>
            )}
          </ol>
        </motion.nav>
      )}
    </AnimatePresence>
  )
}

function Chevron() {
  return (
    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  )
}

/**
 * The folders between the first and the last two, folded into one button.
 * SKIPPED BY test/skeleton-parity in both trees: a skeleton knows how many
 * crumbs there are, not which, and draws the button disabled.
 */
function Folded({
  folders,
  loading,
}: {
  folders: (TemplateFolder | undefined)[]
  loading: boolean
}) {
  return (
    <>
      <Chevron />
      <li data-skeleton="skip" className="shrink-0">
        {loading ? (
          <Button variant="ghost" size="sm" aria-label="Folders in between" disabled>
            <MoreHorizontal />
          </Button>
        ) : (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Folders in between">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-72 w-52 overflow-y-auto"
            >
              {folders.map(
                (f) =>
                  f && (
                    <DropdownMenuItem key={f.id} asChild>
                      <Link href={folderHref(f.id)}>
                        <span className="truncate">{f.name}</span>
                      </Link>
                    </DropdownMenuItem>
                  ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    </>
  )
}
