"use client"

import { BroadcastsView, BroadcastsLoading } from "@/components/broadcasts-view"
import { SegmentsView, SegmentsLoading } from "@/components/segments-view"
import { TopicsView, TopicsLoading } from "@/components/topics-view"
import { broadcastsShape } from "@/lib/shapes/broadcasts"
import { segmentsShape } from "@/lib/shapes/segments"
import { topicsShape } from "@/lib/shapes/topics"
import type { BroadcastSummary, SegmentRow, TopicRow } from "@/lib/types"

export {
  BroadcastsView,
  BroadcastsLoading,
  SegmentsView,
  SegmentsLoading,
  TopicsView,
  TopicsLoading,
}

/**
 * Backwards-compatible wrappers for marketing lists.
 * The canonical views are BroadcastsView, SegmentsView, TopicsView.
 */
export function BroadcastsList({ broadcasts }: { broadcasts: BroadcastSummary[] }) {
  const shape = broadcastsShape.of({ broadcasts })
  return <BroadcastsView shape={shape} data={{ broadcasts }} />
}

export function SegmentsList({ segments }: { segments: SegmentRow[] }) {
  const shape = segmentsShape.of({ segments })
  return <SegmentsView shape={shape} data={{ segments }} />
}

export function TopicsList({ topics }: { topics: TopicRow[] }) {
  const shape = topicsShape.of({ topics })
  return <TopicsView shape={shape} data={{ topics }} />
}
