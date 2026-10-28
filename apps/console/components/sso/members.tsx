"use client"

import * as React from "react"
import { useOrganization } from "@clerk/nextjs"

/**
 * The workspace's members, for the pickers of the SSO screens (the bypass list,
 * a mailbox's delegate, the audit log's person filter).
 */

export interface Member {
  userId: string
  label: string
}

/**
 * The workspace's members from Clerk, for the picker.
 *
 * ⚠ RENDERED ONLY WHEN CLERK IS MOUNTED: its hooks throw outside the provider,
 * which the root layout mounts only with a publishable key.
 */
export function ClerkMembers({
  onMembers,
}: {
  onMembers: (members: Member[]) => void
}) {
  const { memberships } = useOrganization({
    memberships: { pageSize: 50, keepPreviousData: true },
  })
  const data = memberships?.data
  const members = React.useMemo(
    () =>
      data?.flatMap((m) => {
        const userId = m.publicUserData?.userId
        if (!userId) return []
        const name = [m.publicUserData?.firstName, m.publicUserData?.lastName]
          .filter(Boolean)
          .join(" ")
        const email = m.publicUserData?.identifier
        return [
          {
            userId,
            label: name && email ? `${name} (${email})` : (email ?? name ?? userId),
          },
        ]
      }),
    [data],
  )
  /*
   * ⚠ REPORTED ONLY WHEN THE LIST ITSELF CHANGES. Clerk hands back a new
   * `data` array on renders where nothing changed, and the parent re-renders
   * on every report, so reporting on identity alone loops until React gives up.
   */
  const signature = members ? JSON.stringify(members) : null
  React.useEffect(() => {
    if (members) onMembers(members)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the content, see above
  }, [signature, onMembers])
  return null
}

/** A member's label, or their id when the picker has not loaded or they are gone. */
export function memberLabel(members: Member[] | null, userId: string): string {
  return members?.find((m) => m.userId === userId)?.label ?? userId
}
