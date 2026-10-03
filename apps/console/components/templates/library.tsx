"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import {
  ChevronRight,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { Checkbox } from "@repo/ui/components/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { Kbd } from "@repo/ui/components/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { cn } from "cn"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { BulkBar } from "@/components/list/bulk-bar"
import { MarqueeBox, useMarquee } from "@/components/list/marquee"
import { rowMenuClass } from "@/components/list/table"
import {
  FilterSelect,
  ListToolbar,
  SearchField,
  ViewToggle,
  useRememberedView,
} from "@/components/list/toolbar"
import {
  DRAG_TYPE,
  FolderCard,
  RenameIcon,
  TemplateCard,
  TemplateMenu,
  type TemplateAction,
} from "@/components/templates/cards"
import { TemplateDetailsDialog } from "@/components/templates/details-dialog"
import { FolderArt } from "@/components/templates/folder-art"
import { TemplateThumbnail } from "@/components/template-thumbnail"
import { NameDialog } from "@/components/templates/name-dialog"
import { NewFolderDialog, NewTemplateMenu } from "@/components/templates/new-menu"
import {
  deleteTemplate,
  deleteTemplateFolder,
  deleteTemplates,
  duplicateTemplate,
  moveTemplates,
  renameTemplateFolder,
  updateTemplate,
} from "@/lib/actions"
import { formatRelative } from "@/lib/format"
import {
  STATUS_LABEL,
  hrefOf,
  isEditable,
  matches,
  statusOf,
  titleOf,
  type TemplateStatus,
} from "@/lib/templates"
import { toastFailure } from "@/lib/toast"
import type { TemplateFolder, TemplateSummary } from "@/lib/types"

type StatusFilter = "all" | TemplateStatus

type Dialog =
  | { kind: "details"; template: TemplateSummary }
  | { kind: "rename"; template: TemplateSummary }
  | { kind: "delete"; ids: string[]; folderIds?: string[] }
  | { kind: "new-folder"; moveIds: string[] }
  | { kind: "rename-folder"; folder: TemplateFolder }
  | { kind: "delete-folder"; folder: TemplateFolder }
  | null

/**
 * The templates page, Resend's way: folders and templates as cards (or rows),
 * search, a status filter, ticking several to move or delete them together,
 * and dragging templates into folders.
 *
 * ⚠ WHAT MOVES ON SCREEN MOVES AT ONCE, AND THE SERVER CATCHES UP. A move or a
 * delete is applied to this list the moment it is asked for, and the action's
 * response then carries the re-rendered page. If the action fails, the list
 * goes back and says why.
 *
 * ⚠ SEARCH LOOKS EVERYWHERE, NOT ONLY IN THE FOLDER ON SCREEN. Somebody
 * typing a name wants that template, wherever they filed it.
 */
export function TemplateLibrary({
  templates,
  folders,
  folderId,
  imagesFrom,
}: {
  templates: TemplateSummary[]
  folders: TemplateFolder[]
  /** The folder being shown, or null for "All templates". */
  folderId: string | null
  imagesFrom: string | null
}) {
  const router = useRouter()
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState<StatusFilter>("all")
  const [view, chooseView] = useRememberedView("templates", "grid")
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<Dialog>(null)
  const [dragIds, setDragIds] = React.useState<string[] | null>(null)
  const [over, setOver] = React.useState<string | null>(null)

  // ⚠ OPTIMISTIC LAYER: moves and deletions asked for and not yet reflected
  // in the server's list. Cleared whenever a new list arrives.
  const [moved, setMoved] = React.useState<Map<string, string | null>>(() => new Map())
  const [gone, setGone] = React.useState<Set<string>>(() => new Set())
  // A new list from the server already shows what was asked for; the layer
  // goes. Adjusted during render, not in an effect - see lib/react.ts.
  const [seen, setSeen] = React.useState({ templates, folders })
  if (seen.templates !== templates || seen.folders !== folders) {
    setSeen({ templates, folders })
    setMoved(new Map())
    setGone(new Set())
  }

  const all = React.useMemo(
    () =>
      templates
        .filter((t) => !gone.has(t.id))
        .map((t) =>
          moved.has(t.id) ? { ...t, folder_id: moved.get(t.id) ?? null } : t,
        ),
    [templates, moved, gone],
  )
  const liveFolders = React.useMemo(
    () =>
      folders
        .filter((f) => !gone.has(f.id))
        .map((f) => ({
          ...f,
          templates: all.filter((t) => t.folder_id === f.id).length,
        })),
    [folders, all, gone],
  )
  const folder = folderId ? (liveFolders.find((f) => f.id === folderId) ?? null) : null
  const searching = query.trim() !== ""

  const shownTemplates = all.filter(
    (t) =>
      (searching ? matches(t, query) : t.folder_id === folderId) &&
      (status === "all" || statusOf(t) === status),
  )
  const shownFolders =
    folderId !== null || status !== "all"
      ? []
      : liveFolders.filter(
          (f) =>
            !searching || f.name.toLowerCase().includes(query.trim().toLowerCase()),
        )

  // Selection only ever holds what is on screen.
  //
  // ⚠ FOLDERS ARE IN IT TOO, AS `folder:<id>`, so a range, ⌘A and the
  // select-all box cover both, in the order they are shown. What acts on
  // templates alone - moving, dragging - takes `pickedTemplates`.
  const visibleIds = [
    ...shownFolders.map((f) => folderKey(f.id)),
    ...shownTemplates.map((t) => t.id),
  ]
  const picked = visibleIds.filter((id) => selected.has(id))
  const pickedTemplates = picked.filter((id) => !isFolderKey(id))
  const pickedFolderIds = picked.filter(isFolderKey).map(folderOfKey)
  const selecting = picked.length > 0
  // Where every ticked template already is, if they share one place; that
  // place is not offered as somewhere to move them.
  const pickedFolders = new Set(
    pickedTemplates.map((id) => all.find((t) => t.id === id)?.folder_id ?? null),
  )
  const pickedIn: string | null | undefined =
    pickedFolders.size === 1 ? [...pickedFolders][0] : undefined
  // Drag a box over empty space to select, as on a desktop.
  const area = React.useRef<HTMLDivElement>(null)
  const band = useMarquee({ root: area, selected, onChange: setSelected })

  const clearSelection = React.useCallback(() => {
    setSelected(new Set())
    setAnchor(null)
  }, [])

  function select(
    id: string,
    { shiftKey, checked }: { shiftKey: boolean; checked: boolean },
  ) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (shiftKey && anchor && visibleIds.includes(anchor)) {
        const a = visibleIds.indexOf(anchor)
        const b = visibleIds.indexOf(id)
        for (const x of visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1))
          next.add(x)
      } else if (checked) next.add(id)
      else next.delete(id)
      return next
    })
    setAnchor(id)
  }

  // ── Keyboard: ⌘A ticks everything, ⌫ deletes what is ticked (Esc is the bar's).
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, [contenteditable=true]")) return
      if (document.querySelector("[role=dialog], [role=menu]")) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        if (visibleIds.length === 0) return
        event.preventDefault()
        setSelected(new Set(visibleIds))
      } else if (
        (event.key === "Backspace" || event.key === "Delete") &&
        picked.length > 0
      ) {
        event.preventDefault()
        setDialog({ kind: "delete", ids: pickedTemplates, folderIds: pickedFolderIds })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  // ── Moving ─────────────────────────────────────────────────────────────
  async function move(ids: string[], to: string | null, { quiet = false } = {}) {
    const from = new Map(
      ids.map((id) => [id, all.find((t) => t.id === id)?.folder_id ?? null]),
    )
    const real = ids.filter((id) => from.get(id) !== to)
    if (real.length === 0) return
    setMoved((prev) => {
      const next = new Map(prev)
      for (const id of real) next.set(id, to)
      return next
    })
    clearSelection()
    const result = await moveTemplates(real, to)
    if (!result.ok) {
      setMoved((prev) => {
        const next = new Map(prev)
        for (const id of real) next.delete(id)
        return next
      })
      toastFailure(result)
      return
    }
    if (quiet) return
    const where = to
      ? `"${liveFolders.find((f) => f.id === to)?.name ?? "folder"}"`
      : "All templates"
    toast.success(
      real.length === 1
        ? `Template moved to ${where}`
        : `${real.length} templates moved to ${where}`,
      {
        action: {
          label: "Undo",
          onClick: () => {
            // Each goes back to where it came from, which may differ.
            const groups = new Map<string | null, string[]>()
            for (const id of real) {
              const back = from.get(id) ?? null
              groups.set(back, [...(groups.get(back) ?? []), id])
            }
            for (const [back, group] of groups) void move(group, back, { quiet: true })
          },
        },
      },
    )
  }

  // ── Dragging ───────────────────────────────────────────────────────────
  function startDrag(id: string, event: React.DragEvent) {
    const ids = selected.has(id) ? pickedTemplates : [id]
    setDragIds(ids)
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids))
    event.dataTransfer.setData("text/plain", ids.join(","))
    // A small chip as the drag image rather than a ghost of the whole card.
    const ghost = document.createElement("div")
    ghost.textContent =
      ids.length === 1
        ? titleOf(all.find((t) => t.id === id)!)
        : `${ids.length} templates`
    ghost.style.cssText =
      "position:fixed;top:-1000px;padding:6px 10px;border-radius:9999px;font:500 12px/1 system-ui,sans-serif;background:#111;color:#fff;box-shadow:0 6px 20px rgb(0 0 0/.25)"
    document.body.appendChild(ghost)
    event.dataTransfer.setDragImage(ghost, 12, 12)
    requestAnimationFrame(() => ghost.remove())
  }
  const dropTarget = (key: string, to: string | null) => ({
    over: over === key,
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      if (over !== key) setOver(key)
    },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
      setOver(null)
      let ids: string[] = []
      try {
        ids = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as string[]
      } catch {
        return
      }
      setDragIds(null)
      void move(ids, to)
    },
  })

  // ── One template's menu ────────────────────────────────────────────────
  async function act(template: TemplateSummary, action: TemplateAction) {
    if (typeof action === "object") return void move([template.id], action.move)
    switch (action) {
      case "details":
        return setDialog({ kind: "details", template })
      case "rename":
        return setDialog({ kind: "rename", template })
      case "delete":
        return setDialog({ kind: "delete", ids: [template.id] })
      case "new-folder":
        return setDialog({ kind: "new-folder", moveIds: [template.id] })
      case "remove-from-folder":
        return void move([template.id], null)
      case "duplicate": {
        const result = await duplicateTemplate(template.id)
        if (!result.ok) return toastFailure(result)
        toast.success(`Duplicated as "${titleOf(result.data)}"`, {
          action: { label: "Open", onClick: () => router.push(hrefOf(result.data)) },
        })
        router.refresh()
        return
      }
    }
  }

  const empty = templates.length === 0 && folders.length === 0
  const nothingShown = shownTemplates.length === 0 && shownFolders.length === 0

  return (
    <div className="relative">
      {/* Toolbar */}
      <ListToolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={folder ? "Search all templates" : "Search templates"}
          label="Search templates"
        />
        <FilterSelect
          value={status === "all" ? "" : status}
          onValueChange={(v) => setStatus((v || "all") as StatusFilter)}
          label="Filter by status"
          allLabel="All statuses"
          className="w-48"
          options={[
            { value: "published", label: "Published" },
            { value: "draft", label: "Draft" },
            { value: "changes", label: "Unpublished changes" },
          ]}
        />
        <ViewToggle value={view} onChange={chooseView} />
      </ListToolbar>

      {/* Where we are */}
      <AnimatePresence initial={false}>
        {(folderId || searching) && (
          <motion.nav
            aria-label="Breadcrumb"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <ol className="flex items-center gap-1.5 pt-5 text-sm">
              <li>
                <Link
                  href="/templates"
                  {...omitOver(dropTarget("root", null))}
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground",
                    over === "root" &&
                      "bg-primary/10 text-foreground ring-2 ring-primary/60",
                  )}
                  onClick={() => setQuery("")}
                >
                  All templates
                </Link>
              </li>
              {folder && !searching && (
                <>
                  <ChevronRight
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                  <li className="font-medium">{folder.name}</li>
                  <li>
                    <DropdownMenu modal={false}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="secondary"
                              size="icon-sm"
                              className="size-7 rounded-lg bg-background/90 shadow-sm backdrop-blur hover:bg-background"
                              aria-label="Folder actions"
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent>Folder actions</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem
                          onSelect={() => setDialog({ kind: "rename-folder", folder })}
                        >
                          <RenameIcon />
                          Rename folder
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDialog({ kind: "delete-folder", folder })}
                        >
                          <Trash2 />
                          Delete folder
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                </>
              )}
              {searching && (
                <>
                  <ChevronRight
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                  <li className="text-muted-foreground">
                    {shownTemplates.length + shownFolders.length} result
                    {shownTemplates.length + shownFolders.length === 1 ? "" : "s"} for “
                    {query.trim()}”
                  </li>
                </>
              )}
            </ol>
          </motion.nav>
        )}
      </AnimatePresence>

      {/* What is here - and the space a selection box is drawn in. */}
      <div ref={area} className="min-h-[60vh] pt-6 pb-24">
        {empty ? (
          <EmptyLibrary />
        ) : nothingShown ? (
          folderId && !searching && status === "all" ? (
            <EmptyFolder folderId={folderId} />
          ) : (
            <motion.p
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border border-dashed px-4 py-16 text-center text-sm text-muted-foreground"
            >
              {searching
                ? `No template matches “${query.trim()}”.`
                : `No ${STATUS_LABEL[status as TemplateStatus].toLowerCase()} templates here.`}
            </motion.p>
          )
        ) : view === "grid" ? (
          <LayoutGroup>
            <ul className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              <AnimatePresence mode="popLayout" initial={false}>
                {shownFolders.map((f) => (
                  <li key={`f-${f.id}`} data-select-key={folderKey(f.id)}>
                    <FolderCard
                      folder={f}
                      selected={selected.has(folderKey(f.id))}
                      selecting={selecting}
                      onSelect={(e) => select(folderKey(f.id), e)}
                      {...dropTarget(f.id, f.id)}
                      onRename={() => setDialog({ kind: "rename-folder", folder: f })}
                      onDelete={() => setDialog({ kind: "delete-folder", folder: f })}
                    />
                  </li>
                ))}
                {shownTemplates.map((t) => (
                  <li key={t.id} data-select-key={t.id}>
                    <TemplateCard
                      template={t}
                      folders={liveFolders}
                      imagesFrom={imagesFrom}
                      selected={selected.has(t.id)}
                      selecting={selecting}
                      onSelect={(e) => select(t.id, e)}
                      onAction={(a) => void act(t, a)}
                      onDragStart={(e) => startDrag(t.id, e)}
                      onDragEnd={() => {
                        setDragIds(null)
                        setOver(null)
                      }}
                      dragging={dragIds?.includes(t.id) ?? false}
                    />
                  </li>
                ))}
              </AnimatePresence>
            </ul>
          </LayoutGroup>
        ) : (
          <TemplateTable
            folders={shownFolders}
            allFolders={liveFolders}
            imagesFrom={imagesFrom}
            templates={shownTemplates}
            selected={selected}
            selecting={selecting}
            onSelect={select}
            onSelectAll={(checked) =>
              setSelected(checked ? new Set(visibleIds) : new Set())
            }
            onAction={(t, a) => void act(t, a)}
            dropTarget={dropTarget}
            onDragStart={startDrag}
            onDragEnd={() => {
              setDragIds(null)
              setOver(null)
            }}
            onFolderRename={(f) => setDialog({ kind: "rename-folder", folder: f })}
            onFolderDelete={(f) => setDialog({ kind: "delete-folder", folder: f })}
          />
        )}
      </div>

      {/* The bar for what is ticked */}
      <MarqueeBox box={band} />

      <BulkBar count={picked.length} onClear={clearSelection} label="Selected">
        {/* Folders do not nest, so only templates move. */}
        {pickedTemplates.length > 0 && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="rounded-xl">
                <FolderInput />
                Move
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="center"
              className="max-h-80 w-52 overflow-y-auto"
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Move to
              </DropdownMenuLabel>
              <DropdownMenuItem
                disabled={pickedIn === null}
                onSelect={() => void move(pickedTemplates, null)}
              >
                All templates
              </DropdownMenuItem>
              {liveFolders.map((f) => (
                <DropdownMenuItem
                  key={f.id}
                  disabled={pickedIn === f.id}
                  onSelect={() => void move(pickedTemplates, f.id)}
                >
                  <span className="truncate">{f.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  setDialog({ kind: "new-folder", moveIds: pickedTemplates })
                }
              >
                <FolderPlus />
                New folder…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() =>
            setDialog({
              kind: "delete",
              ids: pickedTemplates,
              folderIds: pickedFolderIds,
            })
          }
        >
          <Trash2 />
          Delete
          <Kbd className="ml-0.5 bg-destructive/10 text-destructive">⌫</Kbd>
        </Button>
      </BulkBar>

      <LibraryDialogs
        dialog={dialog}
        setDialog={setDialog}
        templates={all}
        folders={liveFolders}
        onDeleted={(ids) => {
          setGone((prev) => new Set([...prev, ...ids]))
          clearSelection()
        }}
        onMoveInto={(ids, to) => void move(ids, to)}
        onFolderDeleted={(f) => {
          clearSelection()
          setGone((prev) => new Set([...prev, f.id]))
          setMoved((prev) => {
            const next = new Map(prev)
            for (const t of all) if (t.folder_id === f.id) next.set(t.id, null)
            return next
          })
          if (folderId === f.id) router.push("/templates")
        }}
      />
    </div>
  )
}

/** The drop handlers without the `over` flag, for elements that style themselves. */
function omitOver<T extends { over: boolean }>(target: T): Omit<T, "over"> {
  const rest: Partial<T> = { ...target }
  delete rest.over
  return rest as Omit<T, "over">
}

function EmptyLibrary() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center"
    >
      <FolderArt count={2} raised over={false} className="w-40" />
      <p className="mt-6 text-sm font-medium">No templates yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Write one in the editor, or upload React Email files. Then send it by id or
        alias, so changing the copy never needs a deploy.
      </p>
      <div className="mt-5">
        <NewTemplateMenu />
      </div>
    </motion.div>
  )
}

function EmptyFolder({ folderId }: { folderId: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center"
    >
      <FolderArt count={0} raised={false} over={false} className="w-36" />
      <p className="mt-6 text-sm font-medium">This folder is empty</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Make a template here, or drag templates onto the folder from All templates.
      </p>
      <div className="mt-5">
        <NewTemplateMenu folderId={folderId} />
      </div>
    </motion.div>
  )
}

/** The same library as rows: denser, for many templates. */
function TemplateTable({
  imagesFrom,
  folders,
  allFolders,
  templates,
  selected,
  selecting,
  onSelect,
  onSelectAll,
  onAction,
  dropTarget,
  onDragStart,
  onDragEnd,
  onFolderRename,
  onFolderDelete,
}: {
  folders: TemplateFolder[]
  allFolders: TemplateFolder[]
  imagesFrom: string | null
  templates: TemplateSummary[]
  selected: Set<string>
  selecting: boolean
  onSelect: (id: string, e: { shiftKey: boolean; checked: boolean }) => void
  onSelectAll: (checked: boolean) => void
  onAction: (t: TemplateSummary, a: TemplateAction) => void
  dropTarget: (
    key: string,
    to: string | null,
  ) => {
    over: boolean
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: () => void
    onDrop: (e: React.DragEvent) => void
  }
  onDragStart: (id: string, e: React.DragEvent) => void
  onDragEnd: () => void
  onFolderRename: (f: TemplateFolder) => void
  onFolderDelete: (f: TemplateFolder) => void
}) {
  const router = useRouter()
  const allTicked =
    templates.length + folders.length > 0 &&
    templates.every((t) => selected.has(t.id)) &&
    folders.every((f) => selected.has(folderKey(f.id)))
  const [hoverFolder, setHoverFolder] = React.useState<string | null>(null)
  return (
    <div className="overflow-hidden rounded-2xl border">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="w-10 py-2.5 pl-4">
              <Checkbox
                checked={allTicked ? true : selecting ? "indeterminate" : false}
                onCheckedChange={(c) => onSelectAll(c === true)}
                aria-label="Select all"
              />
            </th>
            <th className="py-2.5 font-medium">Name</th>
            <th className="hidden py-2.5 font-medium md:table-cell">Status</th>
            <th className="hidden py-2.5 font-medium lg:table-cell">Version</th>
            <th className="py-2.5 font-medium">Edited</th>
            <th className="w-12" />
          </tr>
        </thead>
        <tbody className="divide-y">
          <AnimatePresence initial={false}>
            {folders.map((f) => {
              const drop = dropTarget(f.id, f.id)
              return (
                <motion.tr
                  key={`f-${f.id}`}
                  data-select-key={folderKey(f.id)}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onDragOver={drop.onDragOver}
                  onDragLeave={drop.onDragLeave}
                  onDrop={drop.onDrop}
                  onClick={(e) => {
                    // While picking, a click ticks rather than opens.
                    if (selecting)
                      onSelect(folderKey(f.id), {
                        shiftKey: e.shiftKey,
                        checked: !selected.has(folderKey(f.id)),
                      })
                    else router.push(`/templates/folder/${encodeURIComponent(f.id)}`)
                  }}
                  onPointerEnter={() => setHoverFolder(f.id)}
                  onPointerLeave={() => setHoverFolder((h) => (h === f.id ? null : h))}
                  className={cn(
                    "group cursor-pointer transition-colors hover:bg-muted/40",
                    selected.has(folderKey(f.id)) &&
                      "bg-primary/[0.05] hover:bg-primary/[0.08]",
                    drop.over &&
                      "bg-primary/[0.06] outline-2 -outline-offset-2 outline-primary/60",
                  )}
                >
                  <td className="py-3 pl-4" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(folderKey(f.id))}
                      onClick={(e) =>
                        onSelect(folderKey(f.id), {
                          shiftKey: e.shiftKey,
                          checked: !selected.has(folderKey(f.id)),
                        })
                      }
                      aria-label={`Select ${f.name}`}
                    />
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-3">
                      {/* The grid's folder, small: papers for what is inside,
                          lifting on hover and when a template is dragged on. */}
                      {/* ⚠ THE GRID'S FOLDER, DRAWN AT ITS FULL 160px AND SCALED
                          DOWN - not drawn small. Its edges, highlight, shadows
                          and corners are fixed sizes, so a folder drawn at 44px
                          wore them four times as heavy; scaled, every part
                          shrinks together and it is the same picture. */}
                      <div className="relative h-[35px] w-[44px] shrink-0">
                        <div className="absolute top-0 left-0 w-[160px] origin-top-left scale-[0.275]">
                          <FolderArt
                            count={f.templates}
                            raised={hoverFolder === f.id || drop.over}
                            over={drop.over}
                            className="w-full"
                          />
                        </div>
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{f.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {f.templates === 0
                            ? "Empty"
                            : `${f.templates} template${f.templates === 1 ? "" : "s"}`}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="hidden md:table-cell" />
                  <td className="hidden lg:table-cell" />
                  <td className="text-xs text-muted-foreground" title={f.updated_at}>
                    {formatRelative(f.updated_at)}
                  </td>
                  <td className="pr-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className={rowMenuClass}
                          aria-label={`Actions for ${f.name}`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onFolderRename(f)}>
                          <RenameIcon />
                          Rename folder
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => onFolderDelete(f)}
                        >
                          <Trash2 />
                          Delete folder
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </motion.tr>
              )
            })}
            {templates.map((t) => {
              const status = statusOf(t)
              const ticked = selected.has(t.id)
              return (
                <motion.tr
                  key={t.id}
                  data-select-key={t.id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  draggable
                  onDragStart={(e) =>
                    onDragStart(t.id, e as unknown as React.DragEvent)
                  }
                  onDragEnd={onDragEnd}
                  onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                  onClick={(e) => {
                    if (selecting)
                      onSelect(t.id, { shiftKey: e.shiftKey, checked: !ticked })
                    else router.push(hrefOf(t))
                  }}
                  className={cn(
                    "group cursor-pointer transition-colors hover:bg-muted/40",
                    ticked && "bg-primary/[0.05] hover:bg-primary/[0.08]",
                  )}
                >
                  <td className="py-3 pl-4" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={ticked}
                      onClick={(e) =>
                        onSelect(t.id, { shiftKey: e.shiftKey, checked: !ticked })
                      }
                      aria-label={`Select ${titleOf(t)}`}
                    />
                  </td>
                  <td className="py-3">
                    <Link
                      href={hrefOf(t)}
                      className="flex min-w-0 items-center gap-3 outline-none"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <RowTile>
                        <div className="absolute inset-x-[14%] top-[18%] -bottom-1 overflow-hidden rounded-t-[3px] shadow-[0_0_0_1px_rgb(0_0_0/0.06)]">
                          <TemplateThumbnail
                            templateId={t.id}
                            stamp={t.updated_at}
                            imagesFrom={imagesFrom}
                            label={`${titleOf(t)} preview`}
                          />
                        </div>
                      </RowTile>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{titleOf(t)}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {t.name}
                        </p>
                      </div>
                    </Link>
                  </td>
                  <td className="hidden md:table-cell">
                    <Badge variant={status === "published" ? "default" : "secondary"}>
                      {STATUS_LABEL[status]}
                    </Badge>
                  </td>
                  <td className="tabular hidden font-mono text-xs text-muted-foreground lg:table-cell">
                    {t.version > 0 ? `v${t.version}` : "-"}
                    {!isEditable(t) && (
                      <span className="ml-2 capitalize">{t.source}</span>
                    )}
                  </td>
                  <td
                    className="text-xs whitespace-nowrap text-muted-foreground"
                    title={t.updated_at}
                  >
                    {formatRelative(t.updated_at)}
                  </td>
                  <td className="pr-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <TemplateMenu
                      template={t}
                      folders={allFolders}
                      onAction={(a) => onAction(t, a)}
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className={rowMenuClass}
                          aria-label={`Actions for ${titleOf(t)}`}
                        >
                          <MoreHorizontal />
                        </Button>
                      }
                    />
                  </td>
                </motion.tr>
              )
            })}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  )
}

/** Every dialog the library opens, in one place. */
function LibraryDialogs({
  dialog,
  setDialog,
  templates,
  folders,
  onDeleted,
  onMoveInto,
  onFolderDeleted,
}: {
  dialog: Dialog
  setDialog: (d: Dialog) => void
  templates: TemplateSummary[]
  folders: TemplateFolder[]
  onDeleted: (ids: string[]) => void
  onMoveInto: (ids: string[], to: string) => void
  onFolderDeleted: (f: TemplateFolder) => void
}) {
  // ⚠ THE LAST DIALOG STAYS RENDERED WHILE IT ANIMATES OUT, so its title
  // does not blank mid-exit when `dialog` goes back to null.
  const [last, setLast] = React.useState<Dialog>(dialog)
  if (dialog && dialog !== last) setLast(dialog)
  const d = dialog ?? last
  const close = (open: boolean) => !open && setDialog(null)

  const deleting =
    d?.kind === "delete" ? templates.filter((t) => d.ids.includes(t.id)) : []
  const deletingFolders =
    d?.kind === "delete" ? folders.filter((f) => d.folderIds?.includes(f.id)) : []
  const one =
    deleting.length === 1 && deletingFolders.length === 0 ? deleting[0]! : null
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const what = [
    deletingFolders.length === 1 && deleting.length === 0
      ? `the folder ${deletingFolders[0]!.name}`
      : deletingFolders.length > 0
        ? plural(deletingFolders.length, "folder")
        : null,
    deleting.length > 0 && !one ? plural(deleting.length, "template") : null,
  ]
    .filter(Boolean)
    .join(" and ")
  // Templates in a deleted folder that are not themselves being deleted.
  const rehomed = templates.filter(
    (t) =>
      t.folder_id &&
      d?.kind === "delete" &&
      d.folderIds?.includes(t.folder_id) &&
      !d.ids.includes(t.id),
  ).length

  return (
    <>
      {d?.kind === "details" && (
        <TemplateDetailsDialog
          template={d.template}
          folders={folders}
          variables={d.template.variables}
          open={dialog?.kind === "details"}
          onOpenChange={close}
        />
      )}
      {d?.kind === "rename" && (
        <NameDialog
          open={dialog?.kind === "rename"}
          onOpenChange={close}
          title="Rename template"
          description="The alias code sends it by stays the same."
          initial={titleOf(d.template)}
          maxLength={200}
          submitLabel="Rename"
          doneLabel="Renamed"
          onSubmit={(title) => updateTemplate(d.template.id, { title })}
          onSuccess={() => setDialog(null)}
        />
      )}
      <NewFolderDialog
        open={dialog?.kind === "new-folder"}
        onOpenChange={close}
        onCreated={(id) => {
          if (d?.kind === "new-folder" && d.moveIds.length > 0)
            onMoveInto(d.moveIds, id)
        }}
      />
      {d?.kind === "rename-folder" && (
        <NameDialog
          open={dialog?.kind === "rename-folder"}
          onOpenChange={close}
          title="Rename folder"
          initial={d.folder.name}
          submitLabel="Rename"
          doneLabel="Renamed"
          onSubmit={(name) => renameTemplateFolder(d.folder.id, name)}
          onSuccess={() => setDialog(null)}
        />
      )}
      <ConfirmDialog
        open={dialog?.kind === "delete-folder"}
        onOpenChange={close}
        title={
          d?.kind === "delete-folder"
            ? `Delete the folder ${d.folder.name}?`
            : "Delete folder?"
        }
        description={
          d?.kind === "delete-folder" && d.folder.templates > 0
            ? `Its ${d.folder.templates} template${d.folder.templates === 1 ? "" : "s"} move to All templates. No template is deleted.`
            : "The folder is empty."
        }
        confirmLabel="Delete folder"
        doneLabel="Deleted"
        confirmWord={d?.kind === "delete-folder" ? d.folder.name : undefined}
        onConfirm={async () => {
          if (d?.kind !== "delete-folder") return false
          const result = await deleteTemplateFolder(d.folder.id)
          if (!result.ok) {
            toastFailure(result)
            return false
          }
          onFolderDeleted(d.folder)
          return true
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={close}
        title={one ? `Delete ${titleOf(one)}?` : `Delete ${what}?`}
        description={[
          one
            ? `Any send naming ${one.name} or its id will start failing. Check your code first.`
            : deleting.length > 0
              ? `Any send naming one of these templates will start failing: ${deleting.map((t) => t.name).join(", ")}.`
              : null,
          // ⚠ A FOLDER IS DELETED, ITS TEMPLATES ARE NOT - they move to All
          // templates, as when one folder is deleted on its own.
          rehomed > 0
            ? `${plural(rehomed, "template")} in ${deletingFolders.length === 1 ? "that folder moves" : "those folders move"} to All templates.`
            : deletingFolders.length > 0 && deleting.length === 0
              ? `${deletingFolders.length === 1 ? "It is" : "They are"} empty.`
              : null,
        ]
          .filter(Boolean)
          .join(" ")}
        confirmLabel={one ? "Delete template" : `Delete ${what}`}
        doneLabel="Deleted"
        // ⚠ ONE THING: TYPE ITS NAME. SEVERAL: TYPE "Delete". The name is what
        // proves you are on the right one; for a batch there is no single
        // name, but there is still a deliberate word between a stray ⌫ and
        // losing them.
        confirmWord={
          one
            ? one.name
            : deleting.length === 0 && deletingFolders.length === 1
              ? deletingFolders[0]!.name
              : "Delete"
        }
        onConfirm={async () => {
          const ids = deleting.map((t) => t.id)
          if (ids.length > 0) {
            const result =
              ids.length === 1
                ? await deleteTemplate(ids[0]!)
                : await deleteTemplates(ids)
            if (!result.ok) {
              toastFailure(result)
              return false
            }
            onDeleted(ids)
          }
          // One at a time: there is no bulk folder delete, and a handful is
          // all a person ticks. A failure stops there and says which.
          for (const f of deletingFolders) {
            const result = await deleteTemplateFolder(f.id)
            if (!result.ok) {
              toastFailure(result)
              return false
            }
            onFolderDeleted(f)
          }
          return true
        }}
      />
    </>
  )
}

/**
 * The picture at the start of a row: the same tile for a folder and a
 * template, so every name in the list starts at the same place.
 */
function RowTile({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative grid h-9 w-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted ring-1 ring-border/60 ring-inset">
      {children}
    </div>
  )
}

/** A folder's place in the selection, beside template ids. */
function folderKey(id: string): string {
  return `folder:${id}`
}
function isFolderKey(key: string): boolean {
  return key.startsWith("folder:")
}
function folderOfKey(key: string): string {
  return key.slice("folder:".length)
}
