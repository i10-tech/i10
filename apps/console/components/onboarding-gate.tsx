"use client"

import { useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"

/**
 * ⚠ CLIENT-SIDE ENFORCEMENT OF THE ONBOARDING GATE.
 *
 * Once settings is exempt from the layout's server-side redirect, navigating to
 * anything outside `/settings` within the shared app layout must redirect to
 * onboarding at once.
 */
export function OnboardingGate({ enabled }: { enabled: boolean }) {
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    if (!enabled) return
    if (!pathname.startsWith("/settings")) {
      router.replace("/onboarding")
    }
  }, [enabled, pathname, router])

  return null
}
