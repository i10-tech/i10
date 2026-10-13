"use client"

import * as React from "react"
import { useOrganization, useOrganizationList } from "@clerk/nextjs"
import { useRouter } from "next/navigation"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { clerkReason } from "@/components/account/shared"
import { afterSwitch } from "@/lib/after-switch"
import { toastError } from "@/lib/toast"
import { useWorkspacesChanged } from "@/lib/workspace-name"

/**
 * Which workspace these settings are for (2026-10-12): a picker in the top
 * right of every settings page, for people in more than one workspace.
 * Picking another switches the active workspace and stays on the page, as
 * the rail's switcher does - billing becomes that workspace's billing.
 *
 * ⚠ HIDDEN FOR ONE WORKSPACE. A picker with a single choice is a label that
 * looks pressable; the rail already names the only workspace there is.
 */
export function SettingsWorkspace() {
  const router = useRouter()
  const { organization } = useOrganization()
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { pageSize: 50, keepPreviousData: true },
  })
  const [busy, setBusy] = React.useState(false)
  const wrap = React.useRef<HTMLDivElement>(null)
  useWorkspacesChanged(() => {
    void organization?.reload().catch(() => {})
    void userMemberships.revalidate?.()
  })
  const memberships = userMemberships.data ?? []
  if (!isLoaded || !organization || memberships.length < 2) return null

  const items = memberships.map((m) => {
    // The active one from `organization`, which a rename reloads at once; the
    // list's copy catches up on its own refetch.
    const org = m.organization.id === organization.id ? organization : m.organization
    return {
      value: org.id,
      label: org.name,
      icon: (
        <WorkspaceMark name={org.name} src={org.hasImage ? org.imageUrl : undefined} />
      ),
    }
  })

  async function choose(id: string) {
    if (id === organization?.id) return
    setBusy(true)
    try {
      await setActive?.({ organization: id })
      router.replace(afterSwitch(window.location.pathname, window.location.search))
      router.refresh()
    } catch (error) {
      toastError("Could not switch workspace", clerkReason(error))
    } finally {
      setBusy(false)
      // ⚠ NOT LEFT FOCUSED AFTER A SWITCH (2026-10-13): the select handed focus
      // back to its trigger, which sat highlighted on the new workspace's page.
      requestAnimationFrame(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && wrap.current?.contains(active))
          active.blur()
      })
    }
  }

  return (
    <div ref={wrap} className="contents">
      <MorphSelect
        label="Workspace"
        hideLabel
        align="end"
        items={items}
        value={organization.id}
        disabled={busy}
        onValueChange={(id) => void choose(id)}
      />
    </div>
  )
}

/**
 * A workspace's logo at the picker's 20px, or its first letter on a tile.
 *
 * ⚠ NOT `Avatar` SHRUNK: its smallest size is 28px, and squeezed to 20 it
 * lost its tile and left two loose initials beside the name.
 */
export function WorkspaceMark({ name, src }: { name: string; src?: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- Clerk's image host, 20px
    <img src={src} alt="" className="size-5 rounded-md object-cover" />
  ) : (
    <span className="grid size-5 place-items-center rounded-md bg-muted text-[10px] font-medium text-muted-foreground uppercase">
      {name.trim().charAt(0) || "?"}
    </span>
  )
}
