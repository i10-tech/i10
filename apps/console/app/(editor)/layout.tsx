import { redirect } from "next/navigation"
import { TenantNotReady } from "@/components/tenant-not-ready"
import { tryApi } from "@/lib/api"
import { hasSkippedOnboarding } from "@/lib/onboarding-skip"
import type { Me } from "@/lib/types"

/**
 * Full-screen tools that leave the console's sidebar behind - the template
 * editor, as Resend's opens on a page of its own.
 *
 * ⚠ THE SAME GUARDS AS THE CONSOLE SHELL, without its chrome: a workspace
 * still being provisioned waits, and one that should onboard is sent there.
 * See app/(app)/layout.tsx for why each exists.
 */
export const dynamic = "force-dynamic"

export default async function EditorLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const me = await tryApi<Me>("/console/me")
  if (!me.ok && me.error.name === "tenant_not_ready") return <TenantNotReady />
  if (!me.ok) throw new Error(me.error.message)
  if (
    me.data.onboarding.should_onboard &&
    !(await hasSkippedOnboarding(me.data.tenant?.id ?? ""))
  ) {
    redirect("/onboarding")
  }
  return children
}
