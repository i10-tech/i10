"use client"

import * as React from "react"
import { useRouteParams } from "@/lib/target-route"
import { encodeShape, shapeCookie, shapeFromText, type ShapeDef } from "@/lib/shapes"

/**
 * The shape each page had the last time it loaded, for this workspace - what a
 * loading page draws. See lib/shapes and docs/decisions/skeletons.md.
 *
 * ⚠ A COOKIE, SO THE SERVER RENDERS IT, for the reason the remembered views
 * are (see remembered-views.tsx). The layout reads them and this provider
 * hands them down.
 *
 * ⚠ SEAM FOR GET /console/shapes: the layout merges that call's answer over
 * the cookies, so the first visit on a device is exact too. Nothing here
 * changes when it lands.
 */

interface Shapes {
  tenantId: string
  /** Remembered JSON text per page. */
  shapes: Record<string, string>
}

const RememberedShapes = React.createContext<Shapes>({ tenantId: "", shapes: {} })

export function RememberedShapesProvider({
  tenantId,
  shapes,
  children,
}: Shapes & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ tenantId, shapes }), [tenantId, shapes])
  return <RememberedShapes.Provider value={value}>{children}</RememberedShapes.Provider>
}

const listeners = new Set<() => void>()

function readCookie(page: string, tenantId: string): string | null {
  const name = `${shapeCookie(page)}=`
  const raw = document.cookie
    .split("; ")
    .find((part) => part.startsWith(name))
    ?.slice(name.length)
  if (!raw) return null
  try {
    const value = decodeURIComponent(raw)
    return value.startsWith(`${tenantId}:`) ? value.slice(tenantId.length + 1) : null
  } catch {
    return null
  }
}

/** The shape a skeleton should draw for this page. */
export function useRememberedShape<S, D>(def: ShapeDef<S, D>): S {
  const { tenantId, shapes } = React.useContext(RememberedShapes)
  const fromServer = shapes[def.page] ?? null
  const text = React.useSyncExternalStore(
    (notify) => {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    () => (tenantId ? (readCookie(def.page, tenantId) ?? fromServer) : fromServer),
    () => fromServer,
  )
  return React.useMemo(() => shapeFromText(def, text), [def, text])
}

/** Rendered by a loaded page with its shape. Draws nothing. */
export function RememberShape<S, D>({
  def,
  shape,
  skip = false,
}: {
  def: ShapeDef<S, D>
  shape: S
  skip?: boolean
}) {
  const { tenantId } = React.useContext(RememberedShapes)
  const text = JSON.stringify(shape)
  React.useEffect(() => {
    if (skip || !tenantId || readCookie(def.page, tenantId) === text) return
    const secure = window.location.protocol === "https:" ? "; secure" : ""
    document.cookie = `${shapeCookie(def.page)}=${encodeShape(tenantId, JSON.parse(text))}; path=/; max-age=31536000; samesite=lax${secure}`
    for (const notify of listeners) notify()
  }, [def.page, text, skip, tenantId])
  return null
}

const seeded = new Map<string, unknown>()
const seedKey = (page: string, id: string) => `${page}:${id}`
const storageKey = (page: string, id: string) => `i10-seed-${page}-${id}`

function getSessionStorage(): Storage | undefined {
  if (typeof sessionStorage !== "undefined") return sessionStorage
  if (typeof window !== "undefined" && typeof window.sessionStorage !== "undefined") {
    return window.sessionStorage
  }
  return undefined
}

/**
 * Stashes a record's shape before navigating to it (e.g. on row hover or click),
 * so the record page's loading.tsx can render an exact skeleton on the first visit.
 * Stored in memory and mirrored to sessionStorage so a refresh within the tab keeps it.
 */
export function seedShape<S, D>(def: ShapeDef<S, D>, id: string, shape: S): void {
  seeded.set(seedKey(def.page, id), shape)
  const storage = getSessionStorage()
  if (storage) {
    try {
      storage.setItem(storageKey(def.page, id), JSON.stringify(shape))
    } catch {
      // Storage unavailable or quota exceeded
    }
  }
}

/**
 * Reads a seeded shape from memory or sessionStorage, validating it with def.parse,
 * or falling back to def.fallback.
 */
export function getSeededShape<S, D>(def: ShapeDef<S, D>, id: string): S {
  const key = seedKey(def.page, id)
  const mem = seeded.get(key)
  if (mem !== undefined) {
    const parsed = def.parse(mem)
    if (parsed !== null) return parsed
  }
  const storage = getSessionStorage()
  if (storage) {
    try {
      const stored = storage.getItem(storageKey(def.page, id))
      if (stored) {
        const parsed = def.parse(JSON.parse(stored))
        if (parsed !== null) {
          seeded.set(key, parsed)
          return parsed
        }
      }
    } catch {
      // Fall back
    }
  }
  return def.fallback
}

/** Clears the in-memory seeded map (primarily for unit tests). */
export function clearSeededShapes(): void {
  seeded.clear()
}

const decoded = (segment: string) => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Hook for record page loading.tsx: reads the route id via useRouteParams() and gets
 * the seeded shape, falling back to def.fallback on a cold deep link. `param` names
 * the route segment when it is not `id` (a mailbox is `[address]`); the value is
 * read decoded, so a list can seed it under the address as typed.
 */
export function useRecordShape<S, D>(def: ShapeDef<S, D>, param = "id"): S {
  const params = useRouteParams()
  const raw = params?.[param]
  const segment =
    typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined
  const id = segment === undefined ? undefined : decoded(segment)
  return React.useMemo(() => (id ? getSeededShape(def, id) : def.fallback), [def, id])
}
