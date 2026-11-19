"use client"

import { useRecordShape } from "@/components/list/remembered-shapes"
import { broadcastShape } from "@/lib/shapes/broadcast"
import { BroadcastView } from "@/components/broadcast-view"

/** Loading a broadcast record: its own view drawn from the seeded or fallback shape. */
export default function Loading() {
  return <BroadcastView shape={useRecordShape(broadcastShape)} />
}
