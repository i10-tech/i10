import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { SsoAbilities, SsoConnections, SsoDirectories } from "@/lib/sso-types"

export interface SsoData {
  canManage: boolean
  available: boolean
  catalog: SsoConnections
  directories?: SsoDirectories
  abilities: SsoAbilities
  error?: string
}

export interface SsoShape {
  /** Whether the user can manage SSO. */
  canManage: boolean
  /** Whether SSO is available on this deployment. */
  available: boolean
  /** Number of connections to draw while loading. 0 means empty state. */
  connections: number
  /**
   * Number of directories to draw while loading. Null is UNKNOWN (the read
   * failed, or an old API sent no count): the skeleton draws neutral rows.
   */
  directories: number | null
}

const MAX_DIRECTORIES = 5
const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const ssoShapeFallback: SsoShape = {
  canManage: true,
  available: true,
  connections: 1,
  // ⚠ UNKNOWN, NOT ZERO. Zero draws the directories EMPTY STATE, which on a
  // workspace that has directories is a skeleton claiming there are none.
  directories: null,
}

export const ssoShape = defineShape<SsoShape, SsoData>({
  page: "sso",
  fallback: ssoShapeFallback,
  // A first visit's counts (GET /console/shapes). A count the API did not send
  // stays unknown; with neither, the fallback.
  fromCounts: (counts) => {
    const connections = count(counts.ssoConnections, MAX_SKELETON_ROWS)
    const directories = count(counts.ssoDirectories, MAX_DIRECTORIES)
    if (connections === null && directories === null) return null
    return {
      ...ssoShapeFallback,
      connections: connections ?? ssoShapeFallback.connections,
      directories,
    }
  },
  of: (data) => ({
    canManage: data.canManage,
    available: data.available,
    connections: Math.min(data.catalog.data.length, MAX_SKELETON_ROWS),
    directories: data.directories
      ? Math.min(data.directories.data.length, MAX_DIRECTORIES)
      : null,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const connections = count(r.connections, MAX_SKELETON_ROWS)
    const directories = count(r.directories, MAX_DIRECTORIES)
    // null is a real value here (unknown), so only a bad non-null one drops it.
    if (connections === null || (directories === null && r.directories !== null))
      return null
    return {
      canManage: r.canManage === true,
      available: r.available === true,
      connections,
      directories,
    }
  },
})
