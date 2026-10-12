"use client"

import * as React from "react"
import { useClerk } from "@clerk/nextjs"
import { useRouter } from "next/navigation"

/** "Mohamed's workspace" until onboarding names it. */
export function placeholderName(firstName: string | null | undefined): string {
  return firstName?.trim() ? `${firstName.trim()}'s workspace` : "New workspace"
}

/**
 * Making a workspace, the whole of it (2026-10-12): Clerk's organization with
 * a placeholder name, made active, then onboarding - whose first step is the
 * workspace's name. Replaces the naming dialogs that asked first and then had
 * onboarding ask again; Clerk's `afterCreateOrganizationUrl="/onboarding"`
 * was where this ended up anyway.
 */
export function useCreateWorkspace() {
  const clerk = useClerk()
  const router = useRouter()
  const [creating, setCreating] = React.useState(false)

  const create = async () => {
    setCreating(true)
    try {
      const made = await clerk.createOrganization({
        name: placeholderName(clerk.user?.firstName),
      })
      await clerk.setActive({ organization: made.id })
      router.push("/onboarding")
      router.refresh()
    } finally {
      setCreating(false)
    }
  }

  return { creating, create }
}
