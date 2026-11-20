import type { TemplateFolder } from "@/lib/types"

/**
 * The folder tree the API sends flat: who is inside whom, the path to a
 * folder, and where a load may be moved.
 *
 * ⚠ ONE COPY, because the drag gesture, the "Move to" menus and the
 * breadcrumb all have to agree on which folders are the same place, and a
 * folder dropped inside itself is a cycle the server refuses.
 */

type Node = Pick<TemplateFolder, "id" | "parent_id">

/** A folder's place in the selection, beside template ids. */
export const folderKey = (id: string) => `folder:${id}`
export const isFolderKey = (key: string) => key.startsWith("folder:")
export const folderOfKey = (key: string) => key.slice("folder:".length)

/** The folders directly inside `parent` (null is the top), in the order given. */
export function childrenOf<T extends Node>(
  folders: readonly T[],
  parent: string | null,
): T[] {
  return folders.filter((f) => f.parent_id === parent)
}

/** Every folder inside `id`, at any depth; not `id` itself. */
export function descendantsOf(folders: readonly Node[], id: string): Set<string> {
  const found = new Set<string>()
  const queue = [id]
  while (queue.length > 0) {
    const at = queue.pop()!
    for (const f of folders) {
      if (f.parent_id === at && !found.has(f.id)) {
        found.add(f.id)
        queue.push(f.id)
      }
    }
  }
  return found
}

/** The path from the top to `id`, the folder itself last; empty when there is no such folder. */
export function pathTo<T extends Node>(folders: readonly T[], id: string): T[] {
  const path: T[] = []
  let at: string | null = id
  while (at !== null && path.length <= folders.length) {
    const f: T | undefined = folders.find((x) => x.id === at)
    if (!f) return []
    path.unshift(f)
    at = f.parent_id
  }
  return path
}

/** Folders that cannot take `carried` folders: those folders, and every folder inside one. */
export function blockedFor(
  folders: readonly Node[],
  carried: readonly string[],
): Set<string> {
  const blocked = new Set(carried)
  for (const id of carried) for (const d of descendantsOf(folders, id)) blocked.add(d)
  return blocked
}

export type MoveTarget = {
  /** The folder, or null for All templates. */
  to: string | null
  label: string
  /** 0 at the top level; each level inside is one deeper. */
  depth: number
}

/**
 * Where a load may go, as the menus list it: All templates, then the whole
 * tree depth first. Left out are the carried folders with everything inside
 * them (a cycle) and the place every carried item already is.
 *
 * `homes` is where each carried item is now.
 */
export function moveTargets(
  folders: readonly TemplateFolder[],
  {
    folderIds,
    homes,
  }: { folderIds: readonly string[]; homes: readonly (string | null)[] },
): MoveTarget[] {
  const blocked = blockedFor(folders, folderIds)
  const all: MoveTarget[] = [{ to: null, label: "All templates", depth: 0 }]
  const walk = (parent: string | null, depth: number) => {
    for (const f of childrenOf(folders, parent)) {
      if (blocked.has(f.id)) continue
      all.push({ to: f.id, label: f.name, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return all.filter((t) => !homes.every((home) => home === t.to))
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** "3 templates", "2 folders" or "4 items", for a toast or a chip. */
export function countNoun({
  templates,
  folders,
}: {
  templates: number
  folders: number
}): string {
  if (folders === 0) return plural(templates, "template")
  if (templates === 0) return plural(folders, "folder")
  return plural(templates + folders, "item")
}

/** What a folder holds, in plain words: "2 folders, 5 templates", "3 templates", "Empty". */
export function contentsOf({
  templates,
  folders,
}: {
  templates: number
  folders: number
}): string {
  if (templates === 0 && folders === 0) return "Empty"
  return [
    folders > 0 ? plural(folders, "folder") : null,
    templates > 0 ? plural(templates, "template") : null,
  ]
    .filter(Boolean)
    .join(", ")
}

/**
 * The path as a breadcrumb draws it: every crumb up to three folders deep;
 * past that the first, the last two, and the middle folded into one.
 */
export function collapsePath<T>(ancestors: readonly T[]): {
  shown: T[]
  folded: T[]
  at: number
} {
  if (ancestors.length <= 3)
    return { shown: [...ancestors], folded: [], at: ancestors.length }
  return {
    shown: [ancestors[0]!, ...ancestors.slice(-2)],
    folded: ancestors.slice(1, -2),
    at: 1,
  }
}
