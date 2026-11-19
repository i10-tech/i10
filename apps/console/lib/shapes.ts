/**
 * The cookie side of the remembered page shapes - plain, so the app layout (a
 * server component) can read them. See components/list/remembered-shapes and
 * docs/decisions/skeletons.md.
 *
 * A page's SHAPE is the small value that decides its structure: how many rows,
 * which optional pieces show. Loaded, the page passes `def.of(data)`; loading,
 * the remembered one. Its view branches on the shape alone, so the skeleton and
 * the page cannot disagree about structure.
 */

export type ShapeCounts = Record<string, number>

export interface ShapeDef<S, D> {
  /** The page's key: the cookie is `i10-shape-<page>`. */
  page: string
  /** Drawn when the page has never been seen in this workspace. */
  fallback: S
  /** What the page's data says its shape is. */
  of(data: D): S
  /** Validates a remembered value; null drops it for the fallback. */
  parse(raw: unknown): S | null
  /** Map a single count for this page onto its shape. */
  fromCount?(n: number): S | null
  /** Map the full counts map from GET /console/shapes onto its shape. */
  fromCounts?(counts: Record<string, number>): S | null
}

export const defineShape = <S, D>(def: ShapeDef<S, D>) => def

const PREFIX = "i10-shape-"
export const shapeCookie = (page: string) => `${PREFIX}${page}`

/** `<tenantId>:<json>`, so one workspace's shape never draws in another. */
export const encodeShape = (tenantId: string, shape: unknown) =>
  encodeURIComponent(`${tenantId}:${JSON.stringify(shape)}`)

/** The remembered JSON text per page, for this tenant. Text, so a snapshot compares by value. */
export function parseShapes(
  cookies: { name: string; value: string }[],
  tenantId: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const cookie of cookies) {
    if (!cookie.name.startsWith(PREFIX)) continue
    let value: string
    try {
      value = decodeURIComponent(cookie.value)
    } catch {
      continue
    }
    if (!tenantId || !value.startsWith(`${tenantId}:`)) continue
    out[cookie.name.slice(PREFIX.length)] = value.slice(tenantId.length + 1)
  }
  return out
}

/** Text from `parseShapes` (or the live cookie) as the page's shape, or its fallback. */
export function shapeFromText<S, D>(
  def: ShapeDef<S, D>,
  text: string | null | undefined,
): S {
  if (!text) return def.fallback
  try {
    return def.parse(JSON.parse(text)) ?? def.fallback
  } catch {
    return def.fallback
  }
}

/**
 * Resolves a page's shape by priority:
 * 1. Cookie wins when present (it carries flags the count does not).
 * 2. API count fills in pages with no cookie.
 * 3. Fallback when neither cookie nor count produces a shape.
 */
export function resolveShape<S, D>(
  def: ShapeDef<S, D>,
  cookieText: string | null | undefined,
  counts: Record<string, number> | null | undefined,
): S {
  if (cookieText) {
    try {
      const parsed = def.parse(JSON.parse(cookieText))
      if (parsed !== null) return parsed
    } catch {
      // Malformed cookie drops through to count or fallback
    }
  }
  if (counts) {
    const pageCount = counts[def.page]
    const fromApi = def.fromCounts
      ? def.fromCounts(counts)
      : def.fromCount && typeof pageCount === "number"
        ? def.fromCount(pageCount)
        : null
    if (fromApi !== null) return fromApi
  }
  return def.fallback
}

export interface ShapeMergeDef {
  page: string
  fromCount?(n: number): unknown
  fromCounts?(counts: Record<string, number>): unknown
}

/**
 * Merges API counts into remembered cookie shapes:
 * Cookie wins when present. Counts fill in pages with no cookie.
 */
export function mergeShapes(
  cookieShapes: Record<string, string>,
  counts: Record<string, number> | null | undefined,
  defs: ShapeMergeDef[],
): Record<string, string> {
  const out = { ...cookieShapes }
  if (!counts) return out
  for (const def of defs) {
    if (out[def.page]) continue
    const pageCount = counts[def.page]
    const shape = def.fromCounts
      ? def.fromCounts(counts)
      : def.fromCount && typeof pageCount === "number"
        ? def.fromCount(pageCount)
        : null
    if (shape !== null) {
      out[def.page] = JSON.stringify(shape)
    }
  }
  return out
}
