import { defineShape } from "@/lib/shapes"
import type { IncomingTransfer } from "@/lib/types"

export interface TransferData {
  id: string
  offer: IncomingTransfer | null
  ok: boolean
  clerkEnabled: boolean
  error?: { name: string; message: string }
}

export interface TransferShape {
  /** Whether the transfer offer is available and active. */
  ok: boolean
}

export const transferShape = defineShape<TransferShape, TransferData>({
  page: "transfer",
  fallback: { ok: true },
  of: (data) => ({
    ok: data.ok,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    return {
      ok: r.ok === true,
    }
  },
})
