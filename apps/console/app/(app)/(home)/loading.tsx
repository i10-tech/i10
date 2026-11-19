"use client"

import { useRouteSearchParams } from "@/lib/target-route"
import { useRememberedShape } from "@/components/list/remembered-shapes"
import { overviewShape } from "@/lib/shapes/overview"
import { OverviewView } from "@/components/overview-view"

/** Loading the overview: the page's own view, drawn from the remembered shape. */
export default function Loading() {
  const remembered = useRememberedShape(overviewShape)
  const searchParams = useRouteSearchParams()
  const daysParam = searchParams.get("days")
  const days = [7, 14, 30, 90].includes(Number(daysParam))
    ? Number(daysParam)
    : remembered.days
  return <OverviewView shape={{ ...remembered, days }} />
}
