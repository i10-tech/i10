"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import { FolderInput, FolderPlus, MoreHorizontal, Trash2 } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import { Button } from "@repo/ui/components/button/button"
import { Checkbox } from "@repo/ui/components/checkbox/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/i10/menu"
import { Kbd } from "@repo/ui/components/i10/kbd"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { cn } from "cn"
import { ConfirmDialog, confirmWordFor } from "@/components/confirm-dialog"
import { BulkBar } from "@/components/list/bulk-bar"
import { useGesture } from "@/components/list/gesture/use-gesture"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListTable,
  rowClass,
  rowMenuClass,
  selectedRowClass,
  SWAP,
} from "@/components/list/table"
import {
  FilterSelect,
  ListResults,
  ListSearch,
  ListToolbar,
  ListToolbarEnd,
  ViewToggle,
  useRememberedView,
} from "@/components/list/toolbar"
import {
  FolderCard,
  RenameIcon,
  TemplateCard,
  TemplateMenu,
  seedTemplate,
  type TemplateAction,
} from "@/components/templates/cards"
import { Breadcrumb } from "@/components/templates/breadcrumb"
import { TemplateDetailsDialog } from "@/components/templates/details-dialog"
import { FolderArt } from "@/components/templates/folder-art"
import { TemplateSnapshot } from "@/components/template-snapshot"
import { NameDialog } from "@/components/templates/name-dialog"
import { MoveItems, MoveSubmenu } from "@/components/templates/move-items"
import { NewFolderDialog, NewTemplateMenu } from "@/components/templates/new-menu"
import {
  deleteTemplate,
  deleteTemplateFolder,
  deleteTemplates,
  duplicateTemplate,
  moveToFolder,
  renameTemplateFolder,
  updateTemplate,
} from "@/lib/actions"
import {
  blockedFor,
  contentsOf,
  countNoun,
  folderKey,
  folderOfKey,
  isFolderKey,
  moveTargets,
  pathTo,
} from "@/lib/template-tree"
import {
  STATUS_LABEL,
  hrefOf,
  isEditable,
  matches,
  statusOf,
  titleOf,
  type TemplateStatus,
} from "@/lib/templates"
import { toastDone, toastFailure } from "@/lib/toast"
import type { TemplateFolder, TemplateSummary } from "@/lib/types"
import { RowMenu } from "@/components/list/row-menu"
import { Time } from "@/components/time"

type StatusFilter = "all" | TemplateStatus

type Dialog =
  | { kind: "details"; template: TemplateSummary }
  | { kind: "rename"; template: TemplateSummary }
  | { kind: "delete"; ids: string[]; folderIds?: string[] }
  | { kind: "new-folder"; moveKeys: string[] }
  | { kind: "rename-folder"; folder: TemplateFolder }
  | { kind: "delete-folder"; folder: TemplateFolder }
  | null

/**
 * The templates page, Resend's way: folders and templates as cards (or rows),
 * search, a status filter, ticking several to move or delete them together,
 * and dragging templates and folders into folders, which nest.
 *
 * ⚠ WHAT MOVES ON SCREEN MOVES AT ONCE, AND THE SERVER CATCHES UP. A move or a
 * delete is applied to this list the moment it is asked for, and the action's
 * response then carries the re-rendered page. If the action fails, the list
 * goes back and says why.
 *
 * ⚠ SEARCH LOOKS EVERYWHERE, NOT ONLY IN THE FOLDER ON SCREEN. Somebody
 * typing a name wants that template, wherever they filed it, and a folder by
 * its name at any depth.
 *
 * ⚠ THE FOLDERS COME FLAT AND THE TREE IS BUILT HERE (lib/template-tree): a
 * page shows the folders whose `parent_id` is the folder on screen.
 */
// ⚠ ONE EMPTY LIST, NOT A NEW ONE PER RENDER. The optimistic layer below resets
// when the list it was given changes identity; a fresh `[]` on every loading
// render reset it on every render, and React stopped the loop with an error.
const NO_TEMPLATES: TemplateSummary[] = []
const NO_FOLDERS: TemplateFolder[] = []

export function TemplateLibrary({
  templates = NO_TEMPLATES,
  folders = NO_FOLDERS,
  folderId,
  loading = false,
  shape,
}: {
  templates?: TemplateSummary[]
  folders?: TemplateFolder[]
  /** The folder being shown, or null for "All templates". */
  folderId: string | null
  loading?: boolean
  shape?: {
    templates: number
    folders?: number
    /** How many folders are above this one. */
    depth?: number
    view?: "grid" | "table"
  }
}) {
  const router = useRouter()
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState<StatusFilter>("all")
  const viewKey = folderId ? `templates-${folderId}` : "templates"
  const [view, chooseView] = useRememberedView(viewKey, shape?.view ?? "grid")
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<Dialog>(null)
  // What a gesture has lifted right now (dimmed), as selection keys, and the
  // drop target it is over: a folder's id, or `root` for "All templates".
  const [lifted, setLifted] = React.useState<Set<string> | null>(null)
  const [over, setOver] = React.useState<string | null>(null)

  // ⚠ OPTIMISTIC LAYER: moves and deletions asked for and not yet reflected
  // in the server's list. Cleared whenever a new list arrives.
  const [layer, setLayer] = React.useState(freshLayer)
  // A new list from the server already shows what was asked for; the layer
  // goes. Adjusted during render, not in an effect - see lib/react.ts.
  const [seen, setSeen] = React.useState({ templates, folders })
  if (seen.templates !== templates || seen.folders !== folders) {
    setSeen({ templates, folders })
    setLayer(freshLayer())
  }

  const all = React.useMemo(
    () =>
      templates
        .filter((t) => !layer.gone.has(t.id))
        .map((t) =>
          layer.templates.has(t.id)
            ? { ...t, folder_id: layer.templates.get(t.id) ?? null }
            : t,
        ),
    [templates, layer],
  )
  const liveFolders = React.useMemo(() => {
    const placed = folders
      .filter((f) => !layer.gone.has(f.id))
      .map((f) =>
        layer.folders.has(f.id)
          ? { ...f, parent_id: layer.folders.get(f.id) ?? null }
          : f,
      )
    return placed.map((f) => ({
      ...f,
      templates: all.filter((t) => t.folder_id === f.id).length,
      folders: placed.filter((c) => c.parent_id === f.id).length,
    }))
  }, [folders, all, layer])
  const folder = folderId ? (liveFolders.find((f) => f.id === folderId) ?? null) : null
  const trail = folderId ? pathTo(liveFolders, folderId) : []
  const searching = query.trim() !== ""

  const shownTemplates = all.filter(
    (t) =>
      (searching ? matches(t, query) : t.folder_id === folderId) &&
      (status === "all" || statusOf(t) === status),
  )
  const needle = query.trim().toLowerCase()
  const shownFolders =
    status !== "all"
      ? []
      : liveFolders.filter((f) =>
          searching
            ? f.id !== folderId && f.name.toLowerCase().includes(needle)
            : f.parent_id === folderId,
        )

  // Selection only ever holds what is on screen.
  //
  // ⚠ FOLDERS ARE IN IT TOO, AS `folder:<id>`, so a range, ⌘A and the
  // select-all box cover both, in the order they are shown. Moving and
  // dragging take them together; `pickedFolderIds` is the folders alone.
  const visibleIds = [
    ...shownFolders.map((f) => folderKey(f.id)),
    ...shownTemplates.map((t) => t.id),
  ]
  const picked = visibleIds.filter((id) => selected.has(id))
  const pickedTemplates = picked.filter((id) => !isFolderKey(id))
  const pickedFolderIds = picked.filter(isFolderKey).map(folderOfKey)
  const selecting = picked.length > 0
  /** Where an item is now: its folder, or null at the top level. */
  const homeOf = (key: string): string | null =>
    isFolderKey(key)
      ? (liveFolders.find((f) => f.id === folderOfKey(key))?.parent_id ?? null)
      : (all.find((t) => t.id === key)?.folder_id ?? null)
  // One pointer gesture for the whole page below its header, not only the
  // grid, so the toolbar's empty space, the margins and what is left below the
  // last row start one too: a box on empty space, a sweep from a checkbox, a
  // lift of templates and folders onto a folder.
  const library = React.useRef<HTMLDivElement>(null)

  const clearFilters = () => {
    setQuery("")
    setStatus("all")
  }

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
  // ⚠ THE UNDO TOAST CALLS THE LATEST `move`, not the one it was made in: that
  // one still sees the list from before the move, finds every item "already
  // home" and does nothing.
  const moveLatest = React.useRef(move)
  React.useEffect(() => {
    moveLatest.current = move
  })

  async function move(keys: string[], to: string | null, { quiet = false } = {}) {
    const from = new Map(keys.map((key) => [key, homeOf(key)]))
    const real = keys.filter((key) => from.get(key) !== to)
    if (real.length === 0) return
    setLayer((prev) => placed(prev, real, to))
    clearSelection()
    const result = await moveToFolder(
      {
        templateIds: real.filter((k) => !isFolderKey(k)),
        folderIds: real.filter(isFolderKey).map(folderOfKey),
      },
      to,
    )
    if (!result.ok) {
      setLayer((prev) => unplaced(prev, real))
      toastFailure(result)
      return
    }
    if (quiet) return
    const where = to
      ? `"${liveFolders.find((f) => f.id === to)?.name ?? "folder"}"`
      : "All templates"
    const folderCount = real.filter(isFolderKey).length
    const what =
      real.length === 1
        ? folderCount === 1
          ? "Folder"
          : "Template"
        : countNoun({ templates: real.length - folderCount, folders: folderCount })
    toastDone(`${what} moved to ${where}`, {
      action: {
        label: "Undo",
        onClick: () => {
          // Each goes back to where it came from, which may differ.
          const groups = new Map<string | null, string[]>()
          for (const key of real) {
            const back = from.get(key) ?? null
            groups.set(back, [...(groups.get(back) ?? []), key])
          }
          for (const [back, group] of groups)
            void moveLatest.current(group, back, { quiet: true })
        },
      },
    })
  }

  // ── Dragging ───────────────────────────────────────────────────────────
  useGesture({
    root: library,
    selected,
    carryFor: (origin, how) => {
      const keys = how === "selection" ? picked : [origin]
      if (keys.length === 0) return null
      return {
        keys,
        homes: keys.map(homeOf),
        blocked: blockedFor(liveFolders, keys.filter(isFolderKey).map(folderOfKey)),
      }
    },
    // As Finder does: the card you grabbed by name, and the count beside it.
    titleFor: (key) =>
      isFolderKey(key)
        ? (liveFolders.find((f) => f.id === folderOfKey(key))?.name ?? "Folder")
        : titleOf(
            all.find((t) => t.id === key) ?? ({ name: "Template" } as TemplateSummary),
          ),
    onSelect: setSelected,
    onLift: setLifted,
    onOver: setOver,
    onDrop: (keys, to) => void move(keys, to),
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
        return setDialog({ kind: "new-folder", moveKeys: [template.id] })
      case "remove-from-folder": {
        // One level up, as Finder moves a file out: not all the way to the top.
        const parent = liveFolders.find((f) => f.id === template.folder_id)?.parent_id
        return void move([template.id], parent ?? null)
      }
      case "duplicate": {
        const result = await duplicateTemplate(template.id)
        if (!result.ok) return toastFailure(result)
        toastDone(`Duplicated as "${titleOf(result.data)}"`, {
          action: { label: "Open", onClick: () => router.push(hrefOf(result.data)) },
        })
        router.refresh()
        return
      }
    }
  }

  const skeletonEmpty =
    loading && (shape?.templates ?? 0) === 0 && (shape?.folders ?? 0) === 0
  // ⚠ A FOLDER'S EMPTY SKELETON IS THE FOLDER'S EMPTY STATE, not the library's: the
  // two say different things and have different art.
  const skeletonEmptyFolder = skeletonEmpty && folderId !== null
  const empty =
    (!loading && templates.length === 0 && folders.length === 0) ||
    (skeletonEmpty && !skeletonEmptyFolder)
  const nothingShown =
    (!loading && shownTemplates.length === 0 && shownFolders.length === 0) ||
    skeletonEmptyFolder

  return (
    <div ref={library} className="relative">
      {/* Toolbar */}
      <ListToolbar>
        <ListSearch
          value={query}
          onChange={setQuery}
          placeholder={folder ? "Search all templates" : "Search templates"}
          label="Search templates"
        />
        <ListResults
          count={shownTemplates.length + shownFolders.length}
          noun={["template", "templates"]}
          query={query}
          filtered={status !== "all"}
          onClear={clearFilters}
        />
        <ListToolbarEnd>
          <FilterSelect
            value={status === "all" ? "" : status}
            onValueChange={(v) => setStatus((v || "all") as StatusFilter)}
            label="Filter by status"
            allLabel="All statuses"
            options={[
              { value: "published", label: "Published" },
              { value: "draft", label: "Draft" },
              { value: "changes", label: "Unpublished changes" },
            ]}
          />
          <ViewToggle value={view} onChange={chooseView} />
        </ListToolbarEnd>
      </ListToolbar>

      <Breadcrumb
        folderId={folderId}
        trail={trail}
        depth={shape?.depth ?? 0}
        loading={loading}
        searching={searching}
        over={over}
        onRoot={() => setQuery("")}
        onRename={(f) => setDialog({ kind: "rename-folder", folder: f })}
        onDelete={(f) => setDialog({ kind: "delete-folder", folder: f })}
      />

      {/* What is here - and empty space the selection box starts from. */}
      <div className="min-h-[60vh] pt-6 pb-24">
        <BoneRegion id="library">
          <AnimatePresence mode="wait" initial={false}>
            {empty ? (
              <motion.div key="empty-library" {...SWAP}>
                <EmptyLibrary />
              </motion.div>
            ) : nothingShown ? (
              folderId && !searching && status === "all" ? (
                <motion.div key="empty-folder" {...SWAP}>
                  <EmptyFolder folderId={folderId} />
                </motion.div>
              ) : (
                <motion.p
                  key="nothing-shown"
                  {...SWAP}
                  className="rounded-2xl border border-dashed px-4 py-16 text-center text-sm text-muted-foreground"
                >
                  {searching
                    ? `No template matches “${query.trim()}”.`
                    : `No ${STATUS_LABEL[status as TemplateStatus].toLowerCase()} templates here.`}
                </motion.p>
              )
            ) : view === "grid" ? (
              loading ? (
                <div key="grid-loading">
                  <ul className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                    {Array.from({ length: shape?.folders ?? 0 }, (_, i) => (
                      <BoneScope key={`f-${i}`} id={`folder-${i}`} unit>
                        <li>
                          <FolderCard
                            loading
                            selected={false}
                            selecting={false}
                            over={false}
                            onSelect={() => {}}
                            onRename={() => {}}
                            onDelete={() => {}}
                          />
                        </li>
                      </BoneScope>
                    ))}
                    {Array.from({ length: shape?.templates ?? 0 }, (_, i) => (
                      <BoneScope key={`t-${i}`} id={`tpl-${i}`} unit>
                        <li>
                          <TemplateCard
                            loading
                            selected={false}
                            selecting={false}
                            dragging={false}
                          />
                        </li>
                      </BoneScope>
                    ))}
                  </ul>
                </div>
              ) : (
                <motion.div key="grid" {...SWAP}>
                  <LayoutGroup>
                    <ul className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                      <AnimatePresence mode="popLayout" initial={false}>
                        {shownFolders.map((f, i) => (
                          <BoneScope key={`f-${f.id}`} id={`folder-${i}`} unit>
                            <li data-select-key={folderKey(f.id)} data-drop-to={f.id}>
                              <FolderCard
                                folder={f}
                                selected={selected.has(folderKey(f.id))}
                                selecting={selecting}
                                onSelect={(e) => select(folderKey(f.id), e)}
                                over={over === f.id}
                                dragging={lifted?.has(folderKey(f.id)) ?? false}
                                targets={moveTargets(liveFolders, {
                                  folderIds: [f.id],
                                  homes: [f.parent_id],
                                })}
                                onMove={(to) => void move([folderKey(f.id)], to)}
                                onRename={() =>
                                  setDialog({ kind: "rename-folder", folder: f })
                                }
                                onDelete={() =>
                                  setDialog({ kind: "delete-folder", folder: f })
                                }
                              />
                            </li>
                          </BoneScope>
                        ))}
                        {shownTemplates.map((t, i) => (
                          <BoneScope key={t.id} id={`tpl-${i}`} unit>
                            <li data-select-key={t.id}>
                              <TemplateCard
                                template={t}
                                folders={liveFolders}
                                selected={selected.has(t.id)}
                                selecting={selecting}
                                onSelect={(e) => select(t.id, e)}
                                onAction={(a) => void act(t, a)}
                                dragging={lifted?.has(t.id) ?? false}
                              />
                            </li>
                          </BoneScope>
                        ))}
                      </AnimatePresence>
                    </ul>
                  </LayoutGroup>
                </motion.div>
              )
            ) : (
              <motion.div key="table" {...SWAP}>
                <TemplateTable
                  folders={shownFolders}
                  allFolders={liveFolders}
                  templates={shownTemplates}
                  selected={selected}
                  selecting={selecting}
                  onSelect={select}
                  onSelectAll={(checked) =>
                    setSelected(checked ? new Set(visibleIds) : new Set())
                  }
                  onAction={(t, a) => void act(t, a)}
                  over={over}
                  lifted={lifted}
                  onFolderMove={(f, to) => void move([folderKey(f.id)], to)}
                  onFolderRename={(f) =>
                    setDialog({ kind: "rename-folder", folder: f })
                  }
                  onFolderDelete={(f) =>
                    setDialog({ kind: "delete-folder", folder: f })
                  }
                  loading={loading}
                  shape={shape}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </BoneRegion>
      </div>

      {/* The bar for what is ticked */}
      <BulkBar count={picked.length} onClear={clearSelection} label="Selected">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <FolderInput />
              Move
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="center"
            className="max-h-80 w-56 overflow-y-auto"
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Move to
            </DropdownMenuLabel>
            <MoveItems
              targets={moveTargets(liveFolders, {
                folderIds: pickedFolderIds,
                homes: picked.map(homeOf),
              })}
              onMove={(to) => void move(picked, to)}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setDialog({ kind: "new-folder", moveKeys: picked })}
            >
              <FolderPlus />
              New folder…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="danger"
          size="sm"
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
        folderId={folderId}
        onDeleted={(ids) => {
          setLayer((prev) => ({ ...prev, gone: new Set([...prev.gone, ...ids]) }))
          clearSelection()
        }}
        onMoveInto={(keys, to) => void move(keys, to)}
        onFolderDeleted={(f) => {
          clearSelection()
          setLayer((prev) => withoutFolder(prev, f.id, templates, folders))
          if (folderId === f.id)
            router.push(
              f.parent_id
                ? `/templates/folder/${encodeURIComponent(f.parent_id)}`
                : "/templates",
            )
        }}
      />
    </div>
  )
}

function EmptyLibrary() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: motionTokens.duration.standard,
        ease: [...motionTokens.ease.standard],
      }}
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
      transition={{
        duration: motionTokens.duration.standard,
        ease: [...motionTokens.ease.standard],
      }}
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
  folders,
  allFolders,
  templates,
  selected,
  selecting,
  onSelect,
  onSelectAll,
  onAction,
  over,
  lifted,
  onFolderMove,
  onFolderRename,
  onFolderDelete,
  loading = false,
  shape,
}: {
  folders: TemplateFolder[]
  allFolders: TemplateFolder[]
  templates: TemplateSummary[]
  selected: Set<string>
  selecting: boolean
  onSelect: (id: string, e: { shiftKey: boolean; checked: boolean }) => void
  onSelectAll: (checked: boolean) => void
  onAction: (t: TemplateSummary, a: TemplateAction) => void
  /** The drop target a gesture is over: a folder's id, or `root`. */
  over: string | null
  /** Rows a gesture has lifted, as selection keys, dimmed in place. */
  lifted: Set<string> | null
  onFolderMove: (f: TemplateFolder, to: string | null) => void
  onFolderRename: (f: TemplateFolder) => void
  onFolderDelete: (f: TemplateFolder) => void
  loading?: boolean
  shape?: { templates: number; folders?: number }
}) {
  const router = useRouter()
  const allTicked =
    templates.length + folders.length > 0 &&
    templates.every((t) => selected.has(t.id)) &&
    folders.every((f) => selected.has(folderKey(f.id)))
  const [hoverFolder, setHoverFolder] = React.useState<string | null>(null)
  // Rows to draw: the data's, or as many placeholders as the shape remembers.
  const folderRows: (TemplateFolder | undefined)[] = loading
    ? Array.from({ length: shape?.folders ?? 0 }, () => undefined)
    : folders
  const templateRows: (TemplateSummary | undefined)[] = loading
    ? Array.from({ length: shape?.templates ?? 0 }, () => undefined)
    : templates
  return (
    // Arc's table, like every other list: the same frame, heads and rows.
    <ListTable>
      <ListHeader>
        <th className="w-[4.25rem] py-2.5 pl-4">
          <Bone id="all" shape="box" width={36} height={36} inset={9} radius={5} inline>
            <Checkbox
              checked={allTicked ? true : selecting ? "indeterminate" : false}
              disabled={loading}
              onCheckedChange={(c) => onSelectAll(c === true)}
              aria-label="Select all"
            />
          </Bone>
        </th>
        <ListHead className="pl-0">Name</ListHead>
        <ListHead hideBelow="sm" className="w-[6.5rem]">
          Status
        </ListHead>
        <ListHead hideBelow="sm" className="w-[6rem]">
          Version
        </ListHead>
        <ListHead className="w-[7rem]">Edited</ListHead>
        <ListHead className="w-[3.75rem]">
          <span className="sr-only">Actions</span>
        </ListHead>
      </ListHeader>
      <tbody>
        <AnimatePresence initial={false}>
          {folderRows.map((f, i) => {
            const dropOver = f ? over === f.id : false
            const cells = (
              <>
                <td className="py-3 pl-4" onClick={(e) => e.stopPropagation()}>
                  <Bone
                    id="tick"
                    shape="box"
                    width={36}
                    height={36}
                    inset={9}
                    radius={5}
                    inline
                  >
                    {f && (
                      <Checkbox
                        className="touch-none"
                        checked={selected.has(folderKey(f.id))}
                        onClick={(e) =>
                          onSelect(folderKey(f.id), {
                            shiftKey: e.shiftKey,
                            checked: !selected.has(folderKey(f.id)),
                          })
                        }
                        aria-label={`Select ${f.name}`}
                      />
                    )}
                  </Bone>
                </td>
                <td className="max-w-0 pl-0">
                  <div className="flex items-center gap-3">
                    <Bone
                      id="icon"
                      shape="box"
                      width={44}
                      height={35}
                      radius={6}
                      inline
                    >
                      {f && (
                        <RowTile>
                          {/* ⚠ THE GRID'S FOLDER, DRAWN AT ITS FULL 160px AND SCALED
                              DOWN, not drawn small: the art is fluid, but its
                              borders and shadows are fixed sizes, so a folder
                              drawn small wore them too heavy. Scaled, every part
                              shrinks together. 160 * 0.225 = 36px wide. It lifts
                              on hover and when a template is dragged on. */}
                          <div className="relative h-[30px] w-[36px]">
                            <div className="absolute top-0 left-0 w-[160px] origin-top-left scale-[0.225]">
                              <div data-drag-art>
                                <FolderArt
                                  count={f.templates}
                                  raised={hoverFolder === f.id || dropOver}
                                  over={dropOver}
                                  previews={f.preview}
                                  className="w-full"
                                />
                              </div>
                            </div>
                          </div>
                        </RowTile>
                      )}
                    </Bone>
                    <div className="min-w-0 flex-1">
                      <Bone id="name" lineHeight={20} width={120}>
                        {f && <p className="truncate font-medium">{f.name}</p>}
                      </Bone>
                      <Bone id="count" lineHeight={16} width={60} className="mt-0.5">
                        {f && (
                          <p className="text-xs text-muted-foreground">
                            {contentsOf(f)}
                          </p>
                        )}
                      </Bone>
                    </div>
                  </div>
                </td>
                <ListCell hideBelow="sm" className="text-muted-foreground">
                  -
                </ListCell>
                <ListCell hideBelow="sm" className="text-muted-foreground">
                  -
                </ListCell>
                <ListCell
                  className="text-xs text-muted-foreground"
                  title={f?.updated_at}
                >
                  <Bone id="date" lineHeight={16} width={60}>
                    {f && <Time iso={f.updated_at} />}
                  </Bone>
                </ListCell>
                <td className="pr-3 text-right" onClick={(e) => e.stopPropagation()}>
                  {f && (
                    <RowMenu label={f.name}>
                      <DropdownMenuItem onSelect={() => onFolderRename(f)}>
                        <RenameIcon />
                        Rename folder
                      </DropdownMenuItem>
                      <MoveSubmenu
                        targets={moveTargets(allFolders, {
                          folderIds: [f.id],
                          homes: [f.parent_id],
                        })}
                        onMove={(to) => onFolderMove(f, to)}
                      />
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => onFolderDelete(f)}
                      >
                        <Trash2 />
                        Delete folder
                      </DropdownMenuItem>
                    </RowMenu>
                  )}
                </td>
              </>
            )
            return (
              <BoneScope key={f ? `f-${f.id}` : `f-${i}`} id={`folder-${i}`} unit>
                {f ? (
                  <motion.tr
                    data-select-key={folderKey(f.id)}
                    data-drop-to={f.id}
                    layout
                    exit={{
                      opacity: 0,
                      transition: {
                        duration: motionTokens.duration.instant,
                        ease: [...motionTokens.ease.exit],
                      },
                    }}
                    transition={motionTokens.spring.responsive}
                    onClick={(e) => {
                      // Only a click in the row: a dialog or menu opened from it
                      // bubbles its clicks here through React (see MotionRow).
                      if (!e.currentTarget.contains(e.target as Node)) return
                      // While picking, a click ticks rather than opens.
                      if (selecting)
                        onSelect(folderKey(f.id), {
                          shiftKey: e.shiftKey,
                          checked: !selected.has(folderKey(f.id)),
                        })
                      else router.push(`/templates/folder/${encodeURIComponent(f.id)}`)
                    }}
                    onPointerEnter={() => setHoverFolder(f.id)}
                    onPointerLeave={() =>
                      setHoverFolder((h) => (h === f.id ? null : h))
                    }
                    className={cn(
                      rowClass,
                      "cursor-pointer",
                      selected.has(folderKey(f.id)) && selectedRowClass,
                      lifted?.has(folderKey(f.id)) && "opacity-45",
                      dropOver &&
                        "bg-primary/[0.06] outline-2 -outline-offset-2 outline-primary/60",
                    )}
                  >
                    {cells}
                  </motion.tr>
                ) : (
                  <tr className={cn(rowClass, "cursor-pointer")}>{cells}</tr>
                )}
              </BoneScope>
            )
          })}
          {templateRows.map((t, i) => {
            const ticked = t ? selected.has(t.id) : false
            const status = t ? statusOf(t) : "published"
            const cells = (
              <>
                <td className="py-3 pl-4" onClick={(e) => e.stopPropagation()}>
                  <Bone
                    id="tick"
                    shape="box"
                    width={36}
                    height={36}
                    inset={9}
                    radius={5}
                    inline
                  >
                    {t && (
                      <Checkbox
                        className="touch-none"
                        checked={ticked}
                        onClick={(e) =>
                          onSelect(t.id, { shiftKey: e.shiftKey, checked: !ticked })
                        }
                        aria-label={`Select ${titleOf(t)}`}
                      />
                    )}
                  </Bone>
                </td>
                <td className="max-w-0 pl-0">
                  {(() => {
                    const inner = (
                      <>
                        <Bone
                          id="thumb"
                          shape="box"
                          width={44}
                          height={35}
                          radius={4}
                          inline
                        >
                          {t && (
                            <RowTile>
                              <div
                                data-drag-art
                                className="absolute inset-x-[14%] top-[18%] -bottom-1 overflow-hidden rounded-t-[3px] shadow-[0_0_0_1px_rgb(0_0_0/0.06)]"
                              >
                                <TemplateSnapshot
                                  templateId={t.id}
                                  stamp={t.updated_at}
                                  lazy
                                />
                              </div>
                            </RowTile>
                          )}
                        </Bone>
                        <div className="min-w-0 flex-1">
                          <Bone id="title" lineHeight={20} width={140}>
                            {t && <p className="truncate font-medium">{titleOf(t)}</p>}
                          </Bone>
                          <Bone id="name" lineHeight={16} width={90} className="mt-0.5">
                            {t && (
                              <p className="truncate font-mono text-xs text-muted-foreground">
                                {t.name}
                              </p>
                            )}
                          </Bone>
                        </div>
                      </>
                    )
                    const linkClass = "flex min-w-0 items-center gap-3 outline-none"
                    return t ? (
                      <Link
                        href={hrefOf(t)}
                        className={linkClass}
                        onClick={(e) => e.stopPropagation()}
                        onPointerEnter={() => seedTemplate(t)}
                        onFocus={() => seedTemplate(t)}
                      >
                        {inner}
                      </Link>
                    ) : (
                      <a aria-hidden tabIndex={-1} className={linkClass}>
                        {inner}
                      </a>
                    )
                  })()}
                </td>
                <ListCell hideBelow="sm">
                  <Bone
                    id="status"
                    shape="box"
                    width={64}
                    height={20}
                    radius={9999}
                    inline
                  >
                    {t && (
                      <Badge tone={status === "published" ? "info" : "neutral"}>
                        {STATUS_LABEL[status]}
                      </Badge>
                    )}
                  </Bone>
                </ListCell>
                <ListCell
                  hideBelow="sm"
                  className="tabular font-mono text-xs text-muted-foreground"
                  title={t ? versionLabel(t) : undefined}
                >
                  <Bone id="version" lineHeight={16} width={40}>
                    {t && (
                      <>
                        {t.version > 0 ? `v${t.version}` : "-"}
                        {!isEditable(t) && (
                          <span className="ml-2 capitalize">{t.source}</span>
                        )}
                      </>
                    )}
                  </Bone>
                </ListCell>
                <ListCell
                  className="text-xs text-muted-foreground"
                  title={t?.updated_at}
                >
                  <Bone id="date" lineHeight={16} width={60}>
                    {t && <Time iso={t.updated_at} />}
                  </Bone>
                </ListCell>
                <td className="pr-3 text-right" onClick={(e) => e.stopPropagation()}>
                  {t && (
                    <TemplateMenu
                      template={t}
                      folders={allFolders}
                      onAction={(a) => onAction(t, a)}
                      trigger={
                        <Button
                          variant="ghost"
                          size="sm"
                          className={rowMenuClass}
                          // ⚠ SKIPPED BY test/skeleton-parity: a skeleton row has nothing to act on.
                          data-skeleton="skip"
                          aria-label={`Actions for ${titleOf(t)}`}
                        >
                          <MoreHorizontal />
                        </Button>
                      }
                    />
                  )}
                </td>
              </>
            )
            return (
              <BoneScope key={t ? t.id : `t-${i}`} id={`tpl-${i}`} unit>
                {t ? (
                  <motion.tr
                    data-select-key={t.id}
                    layout
                    exit={{
                      opacity: 0,
                      transition: {
                        duration: motionTokens.duration.instant,
                        ease: [...motionTokens.ease.exit],
                      },
                    }}
                    transition={motionTokens.spring.responsive}
                    onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                    onPointerEnter={() => seedTemplate(t)}
                    onFocus={() => seedTemplate(t)}
                    onClick={(e) => {
                      seedTemplate(t)
                      // Only a click in the row - see the folder row above.
                      if (!e.currentTarget.contains(e.target as Node)) return
                      if (selecting)
                        onSelect(t.id, { shiftKey: e.shiftKey, checked: !ticked })
                      else router.push(hrefOf(t))
                    }}
                    className={cn(
                      rowClass,
                      "cursor-pointer",
                      ticked && selectedRowClass,
                      lifted?.has(t.id) && "opacity-45",
                    )}
                  >
                    {cells}
                  </motion.tr>
                ) : (
                  <tr className={cn(rowClass, "cursor-pointer")}>{cells}</tr>
                )}
              </BoneScope>
            )
          })}
        </AnimatePresence>
      </tbody>
    </ListTable>
  )
}

/** Every dialog the library opens, in one place. */
function LibraryDialogs({
  dialog,
  setDialog,
  templates,
  folders,
  folderId,
  onDeleted,
  onMoveInto,
  onFolderDeleted,
}: {
  dialog: Dialog
  setDialog: (d: Dialog) => void
  templates: TemplateSummary[]
  folders: TemplateFolder[]
  /** The folder on screen; a new folder is made inside it. */
  folderId: string | null
  onDeleted: (ids: string[]) => void
  onMoveInto: (keys: string[], to: string) => void
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
  // What a deleted folder's contents become: templates and folders inside a
  // deleted folder that are not themselves being deleted.
  const deletedFolderIds = d?.kind === "delete" ? (d.folderIds ?? []) : []
  const rehomed = templates.filter(
    (t) =>
      t.folder_id &&
      d?.kind === "delete" &&
      deletedFolderIds.includes(t.folder_id) &&
      !d.ids.includes(t.id),
  ).length
  const rehomedFolders = folders.filter(
    (f) =>
      f.parent_id &&
      deletedFolderIds.includes(f.parent_id) &&
      !deletedFolderIds.includes(f.id),
  ).length
  const whereTo = (f: TemplateFolder) =>
    f.parent_id
      ? `"${folders.find((p) => p.id === f.parent_id)?.name ?? "its parent"}"`
      : "All templates"

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
        parentId={folderId}
        onCreated={(id) => {
          if (d?.kind === "new-folder" && d.moveKeys.length > 0)
            onMoveInto(d.moveKeys, id)
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
          d?.kind === "delete-folder"
            ? d.folder.templates + d.folder.folders > 0
              ? `Its ${contentsOf(d.folder).replace(", ", " and ")} move to ${whereTo(d.folder)}. Nothing else is deleted.`
              : "The folder is empty."
            : ""
        }
        confirmLabel="Delete folder"
        doneLabel="Deleted"
        confirmWord={confirmWordFor(d?.kind === "delete-folder" ? [d.folder.name] : [])}
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
          // ⚠ A FOLDER IS DELETED, ITS CONTENTS ARE NOT - they move up to its
          // parent, as when one folder is deleted on its own.
          rehomed + rehomedFolders > 0
            ? `${countNoun({ templates: rehomed, folders: rehomedFolders })} inside ${deletingFolders.length === 1 ? "that folder move" : "those folders move"} up a level.`
            : deletingFolders.length > 0 && deleting.length === 0
              ? `${deletingFolders.length === 1 ? "It is" : "They are"} empty.`
              : null,
        ]
          .filter(Boolean)
          .join(" ")}
        confirmLabel={one ? "Delete template" : `Delete ${what}`}
        doneLabel="Deleted"
        // ⚠ ONE THING: TYPE ITS NAME. SEVERAL: TYPE THE BULK WORD. The name is what
        // proves you are on the right one; for a batch there is no single
        // name, but there is still a deliberate word between a stray ⌫ and
        // losing them.
        confirmWord={confirmWordFor([
          ...deleting.map((t) => t.name),
          ...deletingFolders.map((f) => f.name),
        ])}
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

/** "v3", plus where a read-only template comes from. */
function versionLabel(t: TemplateSummary): string {
  const v = t.version > 0 ? `v${t.version}` : "-"
  return isEditable(t) ? v : `${v} ${t.source}`
}

/**
 * The optimistic layer: where templates and folders have been put, and what has
 * been deleted, before the server's list says so.
 */
type Layer = {
  templates: Map<string, string | null>
  folders: Map<string, string | null>
  gone: Set<string>
}
const freshLayer = (): Layer => ({
  templates: new Map(),
  folders: new Map(),
  gone: new Set(),
})

/** `keys` put in `to`, each a template id or `folder:<id>`. */
function placed(layer: Layer, keys: string[], to: string | null): Layer {
  const next = {
    ...layer,
    templates: new Map(layer.templates),
    folders: new Map(layer.folders),
  }
  for (const key of keys) {
    if (isFolderKey(key)) next.folders.set(folderOfKey(key), to)
    else next.templates.set(key, to)
  }
  return next
}

/** A move taken back, because the server refused it. */
function unplaced(layer: Layer, keys: string[]): Layer {
  const next = {
    ...layer,
    templates: new Map(layer.templates),
    folders: new Map(layer.folders),
  }
  for (const key of keys) {
    if (isFolderKey(key)) next.folders.delete(folderOfKey(key))
    else next.templates.delete(key)
  }
  return next
}

/**
 * A folder deleted: it goes, and what was inside it moves to ITS parent, as the
 * API does.
 */
function withoutFolder(
  layer: Layer,
  id: string,
  templates: TemplateSummary[],
  folders: TemplateFolder[],
): Layer {
  const parent = layer.folders.has(id)
    ? (layer.folders.get(id) ?? null)
    : (folders.find((f) => f.id === id)?.parent_id ?? null)
  const next = {
    ...layer,
    templates: new Map(layer.templates),
    folders: new Map(layer.folders),
    gone: new Set(layer.gone).add(id),
  }
  for (const t of templates) {
    const at = next.templates.has(t.id) ? next.templates.get(t.id) : t.folder_id
    if (at === id) next.templates.set(t.id, parent)
  }
  for (const f of folders) {
    const at = next.folders.has(f.id) ? next.folders.get(f.id) : f.parent_id
    if (at === id) next.folders.set(f.id, parent)
  }
  return next
}
