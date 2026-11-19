"use client"

import * as React from "react"
import { useParams, usePathname, useSearchParams } from "next/navigation"

type Params = Record<string, string | string[] | undefined>

interface TargetRouteValue {
  pathname: string
  params: Params
  searchParams: URLSearchParams
}

const TargetRouteContext = React.createContext<TargetRouteValue | null>(null)

/**
 * The route a skeleton is drawn for, when that is not the route on screen.
 *
 * ⚠ A SKELETON SHOWN AT THE CLICK RENDERS BEFORE NEXT HAS MOVED, so Next's own
 * hooks still describe the page being left: a record's skeleton would look up
 * the wrong id, the overview the wrong range. Inside this, the hooks below
 * answer for the destination; everywhere else they are Next's.
 */
export function TargetRoute({
  value,
  children,
}: {
  value: TargetRouteValue
  children: React.ReactNode
}) {
  return (
    <TargetRouteContext.Provider value={value}>{children}</TargetRouteContext.Provider>
  )
}

export function useRoutePathname(): string {
  const pathname = usePathname()
  return React.useContext(TargetRouteContext)?.pathname ?? pathname
}

export function useRouteParams(): Params {
  const params = useParams() as Params | null
  return React.useContext(TargetRouteContext)?.params ?? params ?? {}
}

type ReadSearchParams = Pick<URLSearchParams, "get" | "getAll" | "has" | "toString">

export function useRouteSearchParams(): ReadSearchParams {
  const searchParams = useSearchParams()
  return React.useContext(TargetRouteContext)?.searchParams ?? searchParams ?? EMPTY
}

const EMPTY = new URLSearchParams()
