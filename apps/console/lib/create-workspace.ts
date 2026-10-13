"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

/**
 * Making a workspace (2026-10-13): set-up itself, opened on its workspace
 * step with an empty name (`/onboarding?new=1`). Continue creates the
 * workspace with that name and set-up carries on to the domain step in
 * place. It used to be created at once as "Mohamed's workspace" and renamed.
 */
export function useCreateWorkspace() {
  const router = useRouter()
  const [creating, setCreating] = React.useState(false)

  const create = async () => {
    setCreating(true)
    try {
      router.push("/onboarding?new=1")
    } finally {
      setCreating(false)
    }
  }

  return { creating, create }
}
