"use client"

import * as React from "react"
import Link from "next/link"
import { motion } from "motion/react"
import {
  Copy,
  FolderMinus,
  FolderPlus,
  Info,
  MoreHorizontal,
  Pencil,
  TextCursorInput,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { Checkbox } from "@repo/ui/components/checkbox/checkbox"
import { Bone } from "@repo/ui/components/bone/bone"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/i10/menu"
import { Tooltip } from "@repo/ui/components/tooltip/tooltip"
import { cn } from "cn"
import { seedShape } from "@/components/list/remembered-shapes"
import { FolderArt } from "@/components/templates/folder-art"
import { MoveSubmenu } from "@/components/templates/move-items"
import { TemplateSnapshot } from "@/components/template-snapshot"
import { templateDetailShape } from "@/lib/shapes/template-detail"
import { STATUS_LABEL, hrefOf, isEditable, statusOf, titleOf } from "@/lib/templates"
import { contentsOf, moveTargets, type MoveTarget } from "@/lib/template-tree"
import type { TemplateFolder, TemplateSummary } from "@/lib/types"
import { Time } from "@/components/time"

export function seedTemplate(t: TemplateSummary) {
  seedShape(templateDetailShape, t.id, {
    source: t.source,
    kind: t.kind,
    versions: t.versions,
    live: t.version > 0,
    github: Boolean(t.github),
    removed: Boolean(t.github?.removed),
    folder: Boolean(t.folder_id),
    titled: Boolean(t.title),
    tab: "preview",
  })
}

/**
 * The rename icon, in the menu's grey.
 *
 * ⚠ COLOURED HERE BECAUSE THE MENU'S RULE MISSES IT. Menu items grey every
 * icon whose class does not contain `text-` - and lucide names this one
 * `lucide-text-cursor-input`, so it was left white beside grey neighbours.
 */
export function RenameIcon() {
  return <TextCursorInput className="text-muted-foreground" />
}

export type TemplateAction =
  | "details"
  | "rename"
  | "duplicate"
  | "new-folder"
  | "remove-from-folder"
  | "delete"
  | { move: string | null }

const SPRING = { type: "spring", stiffness: 500, damping: 38, mass: 0.6 } as const

/**
 * A template in the grid: its email on a sheet of paper, its name and alias,
 * and where it stands.
 *
 * ⚠ THE WHOLE CARD IS THE LINK, AND THE CHECKBOX AND MENU SIT ABOVE IT. They
 * stop the click from reaching the link, so ticking a card never opens it.
 *
 * ⚠ LIFTED BY THE LIST'S GESTURE, NOT BY THE BROWSER. Nothing here is
 * `draggable`: components/list/gesture reads `data-select-key` on the item
 * around it, and `dragging` dims the card while it is carried.
 */
export function TemplateCard({
  template,
  folders = [],
  selected = false,
  selecting = false,
  onSelect,
  onAction,
  dragging = false,
  loading = false,
}: {
  template?: TemplateSummary
  folders?: TemplateFolder[]
  selected?: boolean
  /** Something is ticked, so every checkbox shows. */
  selecting?: boolean
  onSelect?: (event: { shiftKey: boolean; checked: boolean }) => void
  onAction?: (action: TemplateAction) => void
  /** Carried by a gesture: dimmed where it sits. */
  dragging?: boolean
  loading?: boolean
}) {
  const t = template
  const status = t ? statusOf(t) : "published"
  const [menu, setMenu] = React.useState(false)

  // ⚠ THE CARD'S HOVER, NOT THE LINK'S. The tick and the menu sit beside the
  // link, so `hover:` dropped the background while the pointer was on them;
  // it also stays while the menu is open.
  const linkClass = cn(
    "block rounded-2xl p-1.5 outline-none",
    "transition-[background-color,box-shadow] duration-(--duration-dismiss) ease-(--ease-quad-out)",
    "group-hover/card:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
    menu && "bg-muted/60",
    selected &&
      "bg-primary/[0.06] ring-2 ring-primary/70 group-hover/card:bg-primary/[0.08]",
  )
  // ⚠ ONE BODY FOR THE CARD AND ITS SKELETON; the pieces that need a template
  // are inside their Bones, so a skeleton cannot drift from the card.
  const body = (
    <>
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-muted ring-1 ring-border/60 ring-inset">
        {/* ⚠ THE BONE IS THE PREVIEW'S BOX. The sheet inside is `absolute`;
            while the bone sharpens, its filter makes it the sheet's containing
            block, and a bone of no height drew the sheet as a strip. */}
        <Bone
          id="preview"
          shape="box"
          width="100%"
          height="100%"
          radius="var(--radius-xl)"
          className="absolute inset-0"
        >
          {t && (
            <motion.div
              data-drag-art
              className="absolute inset-x-[13%] top-[16%] -bottom-2 overflow-hidden rounded-t-lg shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.25)]"
            >
              <TemplateSnapshot templateId={t.id} stamp={t.updated_at} lazy />
            </motion.div>
          )}
        </Bone>
      </div>
      <div className="flex items-start gap-2 px-1.5 pt-2.5 pb-1">
        <div className="min-w-0 flex-1">
          <Bone id="title" lineHeight={20} width="72%">
            {t && (
              <p className="truncate text-sm font-medium" title={titleOf(t)}>
                {titleOf(t)}
              </p>
            )}
          </Bone>
          <Bone id="name" lineHeight={16} width="48%" className="mt-1">
            {t && (
              <p
                className="truncate font-mono text-xs text-muted-foreground"
                title={t.name}
              >
                {t.name}
              </p>
            )}
          </Bone>
        </div>
        <Bone
          id="status"
          shape="box"
          width={64}
          height={20}
          radius={9999}
          className="mt-0.5 shrink-0"
          inline
        >
          {t && (
            <>
              <Badge
                tone={status === "published" ? "info" : "neutral"}
                className="mt-0.5 shrink-0"
              >
                {status === "changes" ? "Changes" : STATUS_LABEL[status]}
              </Badge>
              <p className="sr-only">
                {STATUS_LABEL[status]}, edited <Time iso={t.updated_at} />
              </p>
            </>
          )}
        </Bone>
      </div>
    </>
  )

  if (loading || !t) {
    return (
      <div className="group/card relative">
        <a aria-hidden tabIndex={-1} className={linkClass}>
          {body}
        </a>
      </div>
    )
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: dragging ? 0.45 : 1, scale: dragging ? 0.97 : 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={SPRING}
      className="group/card relative"
      data-selected={selected || undefined}
    >
      <Link
        href={hrefOf(t)}
        onPointerEnter={() => seedTemplate(t)}
        onFocus={() => seedTemplate(t)}
        className={linkClass}
        data-navigates={selecting ? "false" : undefined}
        onClick={(event) => {
          seedTemplate(t)
          // While picking, a click ticks rather than opens - Resend's grid
          // behaves the same once one card is ticked.
          if (selecting) {
            event.preventDefault()
            onSelect?.({ shiftKey: event.shiftKey, checked: !selected })
          }
        }}
      >
        {body}
      </Link>

      {/* Tick, top left. ⚠ SKIPPED BY test/skeleton-parity: it acts on a card a skeleton does not have. */}
      <div
        data-skeleton="skip"
        className={cn(
          "absolute top-4 left-4 z-10 transition-opacity duration-(--duration-instant)",
          selected || selecting || menu
            ? "opacity-100"
            : "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100",
        )}
      >
        <Checkbox
          checked={selected}
          aria-label={`Select ${titleOf(t)}`}
          className="size-5 touch-none rounded-md bg-background/90 shadow-sm backdrop-blur"
          onClick={(event) => {
            event.stopPropagation()
            onSelect?.({ shiftKey: event.shiftKey, checked: !selected })
          }}
        />
      </div>

      {/* Menu, top right. Skipped for the same reason. */}
      <div
        data-skeleton="skip"
        className={cn(
          "absolute top-3 right-3 z-10 transition-opacity duration-(--duration-instant)",
          menu
            ? "opacity-100"
            : "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100",
        )}
      >
        <TemplateMenu
          template={t}
          folders={folders}
          open={menu}
          onOpenChange={setMenu}
          onAction={onAction ?? (() => {})}
          trigger={
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Actions for ${titleOf(t)}`}
            >
              <MoreHorizontal />
            </Button>
          }
        />
      </div>
    </motion.div>
  )
}

/**
 * Everything one template can have done to it, from its card, its row, or
 * the editor's menu.
 */
export function TemplateMenu({
  template,
  folders,
  open,
  onOpenChange,
  onAction,
  trigger,
  align = "end",
}: {
  template: TemplateSummary
  folders: TemplateFolder[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onAction: (action: TemplateAction) => void
  trigger: React.ReactNode
  align?: "start" | "end"
}) {
  const t = template
  const targets = moveTargets(folders, { folderIds: [], homes: [t.folder_id] })
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52">
        <DropdownMenuItem onSelect={() => onAction("details")}>
          <Info />
          View details
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={hrefOf(t)} onPointerEnter={() => seedTemplate(t)}>
            {isEditable(t) ? <Pencil /> : <SquareArrowOutUpRight />}
            {isEditable(t) ? "Edit template" : "Open template"}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction("rename")}>
          <RenameIcon />
          Rename template
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction("duplicate")}>
          <Copy />
          Duplicate template
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onAction("new-folder")}>
          <FolderPlus />
          Create folder
        </DropdownMenuItem>
        <MoveSubmenu targets={targets} onMove={(to) => onAction({ move: to })} />
        {t.folder_id && (
          <DropdownMenuItem onSelect={() => onAction("remove-from-folder")}>
            <FolderMinus />
            Remove from folder
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onAction("delete")}>
          <Trash2 />
          Delete template
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A folder in the grid. Opens on click; takes what is dropped on it, and is
 * itself lifted by the list's gesture, so it can be moved into another folder.
 */
export function FolderCard({
  folder,
  selected = false,
  selecting = false,
  onSelect,
  over = false,
  dragging = false,
  targets = [],
  onMove,
  onRename,
  onDelete,
  loading = false,
}: {
  folder?: TemplateFolder
  selected?: boolean
  /** Something is ticked, so every checkbox shows and a click ticks. */
  selecting?: boolean
  onSelect?: (event: { shiftKey: boolean; checked: boolean }) => void
  /** A gesture has something over it: it swells and takes the ring. */
  over?: boolean
  /** Carried by a gesture: dimmed where it sits. */
  dragging?: boolean
  /** Where it may be moved: `lib/template-tree.moveTargets`. */
  targets?: MoveTarget[]
  onMove?: (to: string | null) => void
  onRename?: () => void
  onDelete?: () => void
  loading?: boolean
}) {
  const [hover, setHover] = React.useState(false)
  const [menu, setMenu] = React.useState(false)

  // The card's hover, not the link's, as on a template.
  const linkClass = cn(
    "block rounded-2xl p-1.5 outline-none",
    "transition-[background-color,box-shadow] duration-(--duration-dismiss) ease-(--ease-quad-out)",
    "group-hover/card:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
    menu && "bg-muted/60",
    selected &&
      "bg-primary/[0.06] ring-2 ring-primary/70 group-hover/card:bg-primary/[0.08]",
    over && "bg-primary/10 ring-2 ring-primary/60",
  )
  // ⚠ ONE BODY FOR THE CARD AND ITS SKELETON, as on a template. The same tile a
  // template sits in, so a row of folders and templates lines up - name under name.
  const body = (
    <>
      <div className="grid aspect-[4/3] place-items-center rounded-xl bg-muted/50 ring-1 ring-border/50 ring-inset">
        <Bone
          id="art"
          shape="box"
          width="100%"
          height="100%"
          radius="var(--radius-xl)"
          className="size-full"
        >
          {folder && (
            <div className="grid size-full items-end justify-items-center pb-[5%]">
              <div data-drag-art className="w-[60%]">
                <FolderArt
                  count={folder.templates}
                  raised={hover || menu}
                  over={over}
                  previews={folder.preview}
                  className="w-full"
                />
              </div>
            </div>
          )}
        </Bone>
      </div>
      <div className="px-1.5 pt-2.5 pb-1">
        <Bone id="name" lineHeight={20} width="60%">
          {folder && (
            <p className="truncate text-sm font-medium" title={folder.name}>
              {folder.name}
            </p>
          )}
        </Bone>
        <Bone id="count" lineHeight={16} width="35%" className="mt-1">
          {folder && (
            <p className="text-xs text-muted-foreground">{contentsOf(folder)}</p>
          )}
        </Bone>
      </div>
    </>
  )

  if (loading || !folder) {
    return (
      <div className="group/card relative">
        <a aria-hidden tabIndex={-1} className={linkClass}>
          {body}
        </a>
      </div>
    )
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{
        opacity: dragging ? 0.45 : 1,
        scale: over ? 1.03 : dragging ? 0.97 : 1,
      }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={SPRING}
      className="group/card relative"
      data-selected={selected || undefined}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <Link
        href={`/templates/folder/${encodeURIComponent(folder.id)}`}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        data-navigates={selecting ? "false" : undefined}
        onClick={(event) => {
          // While picking, a click ticks rather than opens, as on a template.
          if (selecting) {
            event.preventDefault()
            onSelect?.({ shiftKey: event.shiftKey, checked: !selected })
          }
        }}
        className={linkClass}
      >
        {body}
      </Link>
      {/* Tick, top left - as on a template, and skipped by test/skeleton-parity for the same reason. */}
      <div
        data-skeleton="skip"
        className={cn(
          "absolute top-4 left-4 z-10 transition-opacity duration-(--duration-instant)",
          selected || selecting || menu
            ? "opacity-100"
            : "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100",
        )}
      >
        <Checkbox
          checked={selected}
          aria-label={`Select ${folder.name}`}
          className="size-5 touch-none rounded-md bg-background/90 shadow-sm backdrop-blur"
          onClick={(event) => {
            event.stopPropagation()
            onSelect?.({ shiftKey: event.shiftKey, checked: !selected })
          }}
        />
      </div>
      <div
        data-skeleton="skip"
        className={cn(
          "absolute top-3 right-3 z-10 transition-opacity duration-(--duration-instant)",
          menu
            ? "opacity-100"
            : "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100",
        )}
      >
        <DropdownMenu open={menu} onOpenChange={setMenu} modal={false}>
          <Tooltip content="Folder actions">
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Actions for ${folder.name}`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem asChild>
              <Link href={`/templates/folder/${encodeURIComponent(folder.id)}`}>
                <SquareArrowOutUpRight />
                Open folder
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename}>
              <RenameIcon />
              Rename folder
            </DropdownMenuItem>
            <MoveSubmenu targets={targets} onMove={(to) => onMove?.(to)} />
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 />
              Delete folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </motion.div>
  )
}
