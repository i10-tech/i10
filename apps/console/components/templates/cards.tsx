"use client"

import * as React from "react"
import Link from "next/link"
import { motion } from "motion/react"
import {
  Copy,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Info,
  MoreHorizontal,
  Pencil,
  TextCursorInput,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { Checkbox } from "@repo/ui/components/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { cn } from "cn"
import { FolderArt } from "@/components/templates/folder-art"
import { TemplateThumbnail } from "@/components/template-thumbnail"
import { formatRelative } from "@/lib/format"
import { STATUS_LABEL, hrefOf, isEditable, statusOf, titleOf } from "@/lib/templates"
import type { TemplateFolder, TemplateSummary } from "@/lib/types"

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

/** The MIME type a dragged template travels as. */
export const DRAG_TYPE = "application/x-i10-templates"

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
 * ⚠ DRAGGABLE ONTO A FOLDER. A selection drags as a whole: dragging one of
 * three ticked cards moves all three, as a file manager does.
 */
export function TemplateCard({
  template,
  folders,
  imagesFrom,
  selected,
  selecting,
  onSelect,
  onAction,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  template: TemplateSummary
  folders: TemplateFolder[]
  imagesFrom: string | null
  selected: boolean
  /** Something is ticked, so every checkbox shows. */
  selecting: boolean
  onSelect: (event: { shiftKey: boolean; checked: boolean }) => void
  onAction: (action: TemplateAction) => void
  onDragStart: (event: React.DragEvent) => void
  onDragEnd: () => void
  dragging: boolean
}) {
  const t = template
  const status = statusOf(t)
  const [menu, setMenu] = React.useState(false)

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
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className={cn(
          "block rounded-2xl p-1.5 outline-none",
          "transition-[background-color,box-shadow] duration-(--duration-dismiss) ease-(--ease-quad-out)",
          "hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
          selected &&
            "bg-primary/[0.06] ring-2 ring-primary/70 hover:bg-primary/[0.08]",
        )}
        onClick={(event) => {
          // While picking, a click ticks rather than opens - Resend's grid
          // behaves the same once one card is ticked.
          if (selecting) {
            event.preventDefault()
            onSelect({ shiftKey: event.shiftKey, checked: !selected })
          }
        }}
      >
        <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-muted ring-1 ring-border/60 ring-inset">
          <motion.div className="absolute inset-x-[13%] top-[16%] -bottom-2 overflow-hidden rounded-t-lg shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.25)]">
            <TemplateThumbnail
              templateId={t.id}
              stamp={t.updated_at}
              imagesFrom={imagesFrom}
              label={`${titleOf(t)} preview`}
            />
          </motion.div>
        </div>
        <div className="flex items-start gap-2 px-1.5 pt-2.5 pb-1">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" title={titleOf(t)}>
              {titleOf(t)}
            </p>
            <p
              className="truncate font-mono text-xs text-muted-foreground"
              title={t.name}
            >
              {t.name}
            </p>
          </div>
          <Badge
            variant={status === "published" ? "default" : "secondary"}
            className="mt-0.5 shrink-0"
          >
            {status === "changes" ? "Changes" : STATUS_LABEL[status]}
          </Badge>
        </div>
      </Link>

      {/* Tick, top left. */}
      <div
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
          className="size-5 rounded-md bg-background/90 shadow-sm backdrop-blur"
          onClick={(event) => {
            event.stopPropagation()
            onSelect({ shiftKey: event.shiftKey, checked: !selected })
          }}
        />
      </div>

      {/* Menu, top right. */}
      <div
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
          onAction={onAction}
          trigger={
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={`Actions for ${titleOf(t)}`}
              className="size-7 rounded-lg bg-background/90 shadow-sm backdrop-blur hover:bg-background"
            >
              <MoreHorizontal />
            </Button>
          }
        />
      </div>

      <p className="sr-only">
        {STATUS_LABEL[status]}, edited {formatRelative(t.updated_at)}
      </p>
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
  const others = folders.filter((f) => f.id !== t.folder_id)
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52">
        <DropdownMenuItem onSelect={() => onAction("details")}>
          <Info />
          View details
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={hrefOf(t)}>
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
        {others.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInput />
              Move to folder
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-48 overflow-y-auto">
              {others.map((f) => (
                <DropdownMenuItem key={f.id} onSelect={() => onAction({ move: f.id })}>
                  <span className="truncate">{f.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
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
 * A folder in the grid. Opens on click; takes templates dropped on it.
 */
export function FolderCard({
  folder,
  selected,
  selecting,
  onSelect,
  over,
  onDragOver,
  onDragLeave,
  onDrop,
  onRename,
  onDelete,
}: {
  folder: TemplateFolder
  selected: boolean
  /** Something is ticked, so every checkbox shows and a click ticks. */
  selecting: boolean
  onSelect: (event: { shiftKey: boolean; checked: boolean }) => void
  over: boolean
  onDragOver: (event: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (event: React.DragEvent) => void
  onRename: () => void
  onDelete: () => void
}) {
  const [hover, setHover] = React.useState(false)
  const [menu, setMenu] = React.useState(false)
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={SPRING}
      className="group/card relative"
      data-selected={selected || undefined}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <Link
        href={`/templates/folder/${encodeURIComponent(folder.id)}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={(event) => {
          // While picking, a click ticks rather than opens, as on a template.
          if (selecting) {
            event.preventDefault()
            onSelect({ shiftKey: event.shiftKey, checked: !selected })
          }
        }}
        className={cn(
          "block rounded-2xl p-1.5 outline-none",
          "transition-[background-color,box-shadow] duration-(--duration-dismiss) ease-(--ease-quad-out)",
          "hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
          selected &&
            "bg-primary/[0.06] ring-2 ring-primary/70 hover:bg-primary/[0.08]",
          over && "bg-primary/[0.06] ring-2 ring-primary/70",
        )}
      >
        {/* The same tile a template sits in, so a row of folders and
            templates lines up - name under name. */}
        <div className="grid aspect-[4/3] place-items-center rounded-xl bg-muted/50 ring-1 ring-border/50 ring-inset">
          <FolderArt
            count={folder.templates}
            raised={hover || menu}
            over={over}
            className="translate-y-[4%]"
          />
        </div>
        <div className="px-1.5 pt-2.5 pb-1">
          <p className="truncate text-sm font-medium" title={folder.name}>
            {folder.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {folder.templates === 0
              ? "Empty"
              : `${folder.templates} template${folder.templates === 1 ? "" : "s"}`}
          </p>
        </div>
      </Link>
      {/* Tick, top left - as on a template. */}
      <div
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
          className="size-5 rounded-md bg-background/90 shadow-sm backdrop-blur"
          onClick={(event) => {
            event.stopPropagation()
            onSelect({ shiftKey: event.shiftKey, checked: !selected })
          }}
        />
      </div>
      <div
        className={cn(
          "absolute top-3 right-3 z-10 transition-opacity duration-(--duration-instant)",
          menu
            ? "opacity-100"
            : "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100",
        )}
      >
        <DropdownMenu open={menu} onOpenChange={setMenu} modal={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label={`Actions for ${folder.name}`}
                  className="size-7 rounded-lg bg-background/90 shadow-sm backdrop-blur hover:bg-background"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Folder actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-44">
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
