import * as React from "react"
import { mock } from "bun:test"
import { createPatch } from "diff"
import { parseDocument } from "htmlparser2"
import { renderToStaticMarkup } from "react-dom/server"

type ChildNode = ReturnType<typeof parseDocument>["children"][number]
interface Element {
  name: string
  attribs: Record<string, string>
  children: ChildNode[]
}

// ⚠ MOCKED BEFORE ANY VIEW IS LOADED. A static import of a view hoists above
// this call and throws on `server-only`; cases.tsx loads the views with
// `await import` after this module has run.
mock.module("server-only", () => ({}))

/**
 * What a skeleton must match: the page itself, with every data-bearing piece
 * (a Bone) collapsed to a placeholder. See docs/decisions/skeletons.md.
 */

export interface ParityView {
  /** The route as test/skeleton-coverage knows it: "/domains", "/domains/[id]". */
  route: string
  /** The concrete URL the view is drawn at. */
  pathname: string
  params?: Record<string, string>
  /** A view's props are the shape and, once loaded, the data. */
  View: React.ComponentType<{ shape: never; data?: never }>
  shape: { of(data: never): unknown }
  cases: ParityCase[]
}

export interface ParityCase {
  name: string
  /**
   * The data, built from a tag that every piece of free text carries. Two tags
   * give two datasets with the same shape and different content.
   */
  fixture: (tag: string) => unknown
}

/** A view with its fixtures checked against its own data type. */
export function defineView<S, D>(view: {
  route: string
  pathname: string
  params?: Record<string, string>
  View: React.ComponentType<{ shape: S; data?: D }>
  shape: { of(data: D): S }
  cases: { name: string; fixture: (tag: string) => D }[]
}): ParityView {
  return view as unknown as ParityView
}

// ── Rendering ───────────────────────────────────────────────────────────

const { AppRouterContext } =
  await import("next/dist/shared/lib/app-router-context.shared-runtime")
const { PathnameContext, SearchParamsContext, PathParamsContext } =
  await import("next/dist/shared/lib/hooks-client-context.shared-runtime")

const router = {
  push() {},
  replace() {},
  refresh() {},
  prefetch() {},
  back() {},
  forward() {},
}

function render(view: ParityView, props: { shape: unknown; data?: unknown }): string {
  const View = view.View as React.ComponentType<typeof props>
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={view.pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <PathParamsContext.Provider value={view.params ?? {}}>
            <View {...props} />
          </PathParamsContext.Provider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  )
}

/** The view as it paints with `data`, and as it paints while loading with `shape`. */
export function renderLoaded(view: ParityView, data: unknown): string {
  return render(view, { shape: view.shape.of(data as never), data })
}
export function renderLoading(view: ParityView, shape: unknown): string {
  return render(view, { shape })
}

// ── Normalising ─────────────────────────────────────────────────────────

/**
 * One line per node: tag and sorted classes, trimmed text, a Bone as
 * `<bone KEY>` with nothing inside it. Every other attribute is dropped.
 *
 * ⚠ `data-skeleton="skip"` IS IGNORED IN BOTH TREES, WITH ITS CHILDREN. It is
 * for a piece that cannot exist without data (a menu that acts on a row, a
 * closed popover's options); each use carries a comment saying why.
 */
export function normalize(html: string): string {
  const lines: string[] = []
  const walk = (nodes: ChildNode[], depth: number) => {
    const pad = "  ".repeat(depth)
    for (const node of nodes) {
      if (node.type === "text") {
        const text = (node as unknown as { data: string }).data
          .replace(/\s+/g, " ")
          .trim()
        if (text) lines.push(`${pad}${text}`)
        continue
      }
      if (node.type !== "tag" && node.type !== "script" && node.type !== "style")
        continue
      const el = node as Element
      if (el.attribs["data-skeleton"] === "skip") continue
      if (el.attribs["data-bone"] !== undefined) {
        lines.push(`${pad}<bone ${el.attribs["data-bone"]}>`)
        continue
      }
      const classes = (el.attribs.class ?? "").split(/\s+/).filter(Boolean).sort()
      lines.push(
        `${pad}<${el.name}${classes.length ? ` class="${classes.join(" ")}"` : ""}>`,
      )
      walk(el.children, depth + 1)
    }
  }
  walk(parseDocument(html).children, 0)
  return lines.join("\n") + "\n"
}

/** A unified diff of two normalised trees, or "" when they are the same. */
export function diffTrees(label: string, expected: string, actual: string): string {
  if (expected === actual) return ""
  return createPatch(label, expected, actual, "loaded page", "skeleton", { context: 4 })
}
