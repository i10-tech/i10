"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { afterSwitch } from "@/lib/after-switch"

export interface WorkspaceSwitchTarget {
  id: string
  name: string
  imageUrl?: string
}

export interface WorkspaceSwitchContextValue {
  pending: WorkspaceSwitchTarget | null
  switchWorkspace: (
    target: WorkspaceSwitchTarget,
    activate: () => Promise<unknown>,
  ) => Promise<void>
}

const WorkspaceSwitchContext = React.createContext<WorkspaceSwitchContextValue | null>(
  null,
)

/**
 * Accesses the active workspace switch state.
 *
 * ⚠ DEGRADES TO PLAIN NAVIGATION OUTSIDE THE PROVIDER RATHER THAN THROWING.
 * If a component is rendered in an isolated test, preview fixture, or story
 * without `WorkspaceSwitchProvider`, throwing would crash the tree. Falling
 * back to immediate execution with `pending: null` performs the activation and
 * route replacement without requiring the full shell context.
 */
export function useWorkspaceSwitch(): WorkspaceSwitchContextValue {
  const context = React.useContext(WorkspaceSwitchContext)
  const router = useRouter()

  if (context) return context

  return {
    pending: null,
    switchWorkspace: async (_target, activate) => {
      await activate()
      const next = afterSwitch(window.location.pathname, window.location.search)
      const current = window.location.pathname + window.location.search
      if (next !== current) {
        router.replace(next)
      }
      router.refresh()
    },
  }
}

/**
 * Coordinates workspace switching across the shell.
 *
 * ⚠ SYNCHRONOUS PENDING ON THE CLICK, SETTLED WITH THE NEXT SERVER TREE.
 * Setting `pending` synchronously on the click flips the switcher trigger,
 * breadcrumb, and Settings picker at 0ms, while `PageFrame` dims the stale
 * page content and marks it `inert`.
 *
 * ⚠ CLERK HOOKS REMAIN WITH THE CALLER.
 * Clerk hooks throw outside `<ClerkProvider>` and the console runs without
 * Clerk in preview mode, so callers pass their own `activate()` closure.
 *
 * ⚠ RE-WRAPPED IN startTransition AFTER THE AWAIT.
 * React drops transition context across awaits. Wrapping the navigation and
 * refresh in `startTransition` after `activate()` completes keeps the router
 * updates inside the transition.
 */
export function WorkspaceSwitchProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [target, setTarget] = React.useState<WorkspaceSwitchTarget | null>(null)
  const [isPending, startTransition] = React.useTransition()

  // Clears when the transition settles (isPending false) so the server's fresh
  // tree and the cleared override land in the same commit with no flash.
  const pending = isPending ? target : null

  const switchWorkspace = React.useCallback(
    (
      nextTarget: WorkspaceSwitchTarget,
      activate: () => Promise<unknown>,
    ): Promise<void> => {
      // Sets pending synchronously so every consumer flips on the click
      setTarget(nextTarget)
      return new Promise<void>((resolve, reject) => {
        startTransition(async () => {
          try {
            await activate()
            const next = afterSwitch(window.location.pathname, window.location.search)
            const current = window.location.pathname + window.location.search

            // React drops transition context across awaits; re-wrap after await.
            startTransition(() => {
              if (next !== current) {
                router.replace(next)
              }
              router.refresh()
              setTarget(null)
            })
            resolve()
          } catch (error) {
            setTarget(null)
            reject(error)
          }
        })
      })
    },
    [router],
  )

  const value = React.useMemo(
    () => ({ pending, switchWorkspace }),
    [pending, switchWorkspace],
  )

  return (
    <WorkspaceSwitchContext.Provider value={value}>
      {children}
    </WorkspaceSwitchContext.Provider>
  )
}
