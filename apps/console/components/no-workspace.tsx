"use client"

import { useEffect, useRef } from "react"
import { useOrganizationList } from "@clerk/nextjs"
import { useRouter } from "next/navigation"
import { Spinner } from "@repo/ui/components/i10/spinner"

/**
 * Signed in with no workspace active (#325): the API answered 409
 * `no_workspace`.
 *
 * ⚠ TWO DIFFERENT PEOPLE LAND HERE, AND ONLY ONE OF THEM HAS NO WORKSPACE.
 * Clerk no longer requires an active organization, so a fresh sign-in by
 * somebody with three workspaces can arrive with none active - they are put
 * in the first one, and the switcher moves them from there. Somebody who
 * belongs to none goes to onboarding, where naming one (or picking Personal)
 * is what creates it.
 */
export function NoWorkspace() {
  const router = useRouter()
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { pageSize: 1 },
  })
  const done = useRef(false)

  useEffect(() => {
    if (!isLoaded || userMemberships.isLoading || done.current) return
    done.current = true
    const first = userMemberships.data?.[0]?.organization.id
    if (!first) {
      router.replace("/onboarding")
      return
    }
    void setActive({ organization: first }).then(() => router.refresh())
  }, [isLoaded, userMemberships.isLoading, userMemberships.data, setActive, router])

  return (
    <main className="flex min-h-dvh items-center justify-center" aria-live="polite">
      <Spinner className="size-5 text-muted-foreground" />
      <span className="sr-only">Opening your workspace</span>
    </main>
  )
}
