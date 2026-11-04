"use client"

import * as React from "react"
import { useOrganization, useOrganizationList } from "@clerk/nextjs"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { clerkReason } from "@/components/account/shared"
import { afterSwitch } from "@/lib/after-switch"
import { toastError } from "@/lib/toast"
import { useWorkspacesChanged } from "@/lib/workspace-name"
import type { TenantProfile } from "@/lib/types"

/**
 * Which workspace these settings are for: a picker in the top
 * right of every settings page, for people in more than one workspace.
 * Picking another switches the active workspace and stays on the page, as
 * the rail's switcher does - billing becomes that workspace's billing.
 *
 * ⚠ HIDDEN FOR ONE WORKSPACE. A picker with a single choice is a label that
 * looks pressable; the rail already names the only workspace there is.
 */
export function SettingsWorkspace({
  initialWorkspace,
  clerkEnabled = false,
}: {
  initialWorkspace?: Pick<TenantProfile, "id" | "name"> | null
  clerkEnabled?: boolean
}) {
  if (!clerkEnabled || !initialWorkspace) return null

  return <ClerkSettingsWorkspace initialWorkspace={initialWorkspace} />
}

function ClerkSettingsWorkspace({
  initialWorkspace,
}: {
  initialWorkspace: Pick<TenantProfile, "id" | "name">
}) {
  const router = useRouter()
  const { organization } = useOrganization()
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { pageSize: 50, keepPreviousData: true },
  })
  const reduced = useReducedMotion()
  const [busy, setBusy] = React.useState(false)
  const wrap = React.useRef<HTMLDivElement>(null)
  useWorkspacesChanged(() => {
    void organization?.reload().catch(() => {})
    void userMemberships.revalidate?.()
  })

  const memberships = userMemberships.data ?? []
  const activeOrg = organization ?? initialWorkspace

  const items = memberships.map((m) => {
    const org = m.organization.id === activeOrg.id ? activeOrg : m.organization
    // Clerk's picture, its default without an upload, as the rail shows it.
    const imageUrl =
      "imageUrl" in org && typeof org.imageUrl === "string" ? org.imageUrl : undefined
    return {
      value: org.id,
      label: org.name,
      icon: <WorkspaceMark name={org.name} src={imageUrl} />,
    }
  })

  async function choose(id: string) {
    if (id === activeOrg.id) return
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

  /*
   * ⚠ NOTHING UNTIL THE LIST HAS LOADED, THEN ONLY FOR TWO OR MORE. The header
   * row reserves the picker's height, so waiting moves nothing; showing a
   * placeholder first made one-workspace people watch a picker appear and
   * vanish. Already loaded on mount (a client navigation), it is simply there.
   */
  const show = isLoaded && memberships.length >= 2

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          ref={wrap}
          key="picker"
          // ⚠ `flex`, NOT A BLOCK: MorphSelect's root is inline-grid, and on a
          // block it sits on a text line whose descender made this 42.5px
          // against the row's 36, so the title dropped 3px as the picker landed.
          className="flex"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={
            reduced
              ? { duration: 0 }
              : {
                  duration: motionTokens.duration.fast,
                  ease: [...motionTokens.ease.standard],
                }
          }
        >
          <MorphSelect
            label="Workspace"
            hideLabel
            align="end"
            items={items}
            value={activeOrg.id}
            disabled={busy}
            onValueChange={(id) => void choose(id)}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * A workspace's logo at the picker's 20px, or its first letter on a tile.
 *
 * ⚠ NOT `Avatar` SHRUNK: its smallest size is 28px, and squeezed to 20 it
 * lost its tile and left two loose initials beside the name.
 */
export function WorkspaceMark({ name, src }: { name: string; src?: string }) {
  // The letters `Avatar` draws, so a mark that cannot load reads like the rail's.
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  const [failed, setFailed] = React.useState<string | null>(null)
  return src && failed !== src ? (
    // eslint-disable-next-line @next/next/no-img-element -- Clerk's image host, 20px
    <img
      src={src}
      alt=""
      className="size-5 rounded-md object-cover"
      onError={() => setFailed(src)}
    />
  ) : (
    <span className="grid size-5 place-items-center rounded-md bg-muted text-[9px] font-medium text-muted-foreground">
      {initials}
    </span>
  )
}
