import { describe, expect, test } from "bun:test"
import {
  blockedFor,
  collapsePath,
  contentsOf,
  countNoun,
  descendantsOf,
  moveTargets,
  pathTo,
} from "@/lib/template-tree"
import type { TemplateFolder } from "@/lib/types"

const { Breadcrumb } = await import("@/components/templates/breadcrumb")
const { renderToStaticMarkup } = await import("react-dom/server")
const { AppRouterContext } =
  await import("next/dist/shared/lib/app-router-context.shared-runtime")

const f = (id: string, parent_id: string | null, name = id): TemplateFolder => ({
  id,
  name,
  parent_id,
  templates: 0,
  folders: 0,
  preview: [],
  created_at: "",
  updated_at: "",
})

// a
// |- b
// |  |- c
// |  `- d
// `- e
// z
const tree = [
  f("a", null),
  f("b", "a"),
  f("c", "b"),
  f("d", "b"),
  f("e", "a"),
  f("z", null),
]

describe("the folder tree", () => {
  test("a folder's descendants are everything inside it, at any depth", () => {
    expect([...descendantsOf(tree, "a")].sort()).toEqual(["b", "c", "d", "e"])
    expect([...descendantsOf(tree, "c")]).toEqual([])
  })

  test("the path to a folder runs from the top and ends at the folder", () => {
    expect(pathTo(tree, "d").map((x) => x.id)).toEqual(["a", "b", "d"])
    expect(pathTo(tree, "missing")).toEqual([])
  })

  test("a carried folder blocks itself and everything inside it", () => {
    expect([...blockedFor(tree, ["b"])].sort()).toEqual(["b", "c", "d"])
  })

  test("a menu offers All templates first, then the tree, indented by depth", () => {
    const all = moveTargets(tree, { folderIds: [], homes: ["z"] })
    expect(all.map((t) => [t.to, t.depth])).toEqual([
      [null, 0],
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 2],
      ["e", 1],
    ])
  })

  test("a menu leaves out the carried folders with what is inside, and where it already is", () => {
    const targets = moveTargets(tree, { folderIds: ["b"], homes: ["a"] })
    expect(targets.map((t) => t.to)).toEqual([null, "e", "z"])
  })

  test("a folder's contents are said in plain words", () => {
    expect(contentsOf({ templates: 0, folders: 0 })).toBe("Empty")
    expect(contentsOf({ templates: 5, folders: 2 })).toBe("2 folders, 5 templates")
    expect(contentsOf({ templates: 1, folders: 0 })).toBe("1 template")
    expect(contentsOf({ templates: 0, folders: 1 })).toBe("1 folder")
  })

  test("a load is counted as what it is", () => {
    expect(countNoun({ templates: 3, folders: 0 })).toBe("3 templates")
    expect(countNoun({ templates: 0, folders: 2 })).toBe("2 folders")
    expect(countNoun({ templates: 3, folders: 2 })).toBe("5 items")
  })

  test("a long path folds its middle and keeps the first and last two", () => {
    expect(collapsePath(["a", "b", "c"])).toEqual({
      shown: ["a", "b", "c"],
      folded: [],
      at: 3,
    })
    expect(collapsePath(["a", "b", "c", "d", "e"])).toEqual({
      shown: ["a", "d", "e"],
      folded: ["b", "c"],
      at: 1,
    })
  })
})

describe("the breadcrumb", () => {
  const html = (folderId: string, over: string | null = null) =>
    renderToStaticMarkup(
      <AppRouterContext.Provider value={{} as never}>
        <Breadcrumb
          folderId={folderId}
          trail={pathTo(tree, folderId)}
          depth={0}
          loading={false}
          searching={false}
          over={over}
          onRoot={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
        />
      </AppRouterContext.Provider>,
    )
  const targetsIn = (markup: string) =>
    [...markup.matchAll(/data-drop-to="([^"]+)"/g)].map((m) => m[1])

  test("All templates and every ancestor are drop targets, and the folder you are in is not", () => {
    expect(targetsIn(html("d"))).toEqual(["root", "a", "b"])
    expect(targetsIn(html("a"))).toEqual(["root"])
  })

  test("only the crumbs refuse a gesture, not the row's empty space", () => {
    const markup = html("c")
    expect(markup.match(/data-no-gesture/g)?.length).toBe(3)
    expect(markup).not.toMatch(/<(nav|ol)[^>]*data-no-gesture/)
  })

  test("the crumb a gesture is over takes the ring", () => {
    expect(html("d", "b")).toMatch(/data-drop-to="b"[^>]*ring-2/)
  })
})
