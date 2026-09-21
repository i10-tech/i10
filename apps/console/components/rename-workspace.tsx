"use client"

import * as React from "react"
import { useOrganization } from "@clerk/nextjs"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"
import { Spinner } from "@repo/ui/components/spinner"
import { renameWorkspace } from "@/lib/actions"
import { useSyncedState } from "@/lib/react"

/**
 * Renaming the workspace, and updating the one thing on screen that shows it.
 *
 * ⚠ IT USED TO END IN `router.refresh()`, WHICH IS A RE-RENDER OF EVERY SERVER
 * COMPONENT ON THE PAGE FOR ONE STRING. The settings tree, the shell, the rail
 * — all re-fetched and reconciled a beat after Save, which reads as the page
 * blinking. The action no longer revalidates either; see `renameWorkspace`.
 *
 * ⚠ AND THE NAME IN THE RAIL IS CLERK'S, NOT OURS, SO A REFRESH WOULD NOT HAVE
 * FIXED IT ANYWAY. `WorkspaceBar` renders Clerk's `<OrganizationSwitcher>`,
 * which reads its own client-side store — re-rendering our server tree leaves
 * it showing the old name until Clerk happens to refetch. The rename reaches
 * Clerk on the server (`clerk.organizations.updateOrganization`), so the fix
 * is to tell Clerk's client to re-read the organization it already has.
 */
export function RenameWorkspace({
  current,
  clerkEnabled,
}: {
  current: string
  /**
   * ⚠ PASSED FROM THE SERVER, THE SAME WAY `WorkspaceBar` TAKES IT. Clerk's
   * hooks throw outside a `<ClerkProvider>`, and the provider is only mounted
   * when a publishable key exists — so the hook has to live in a child that
   * is not rendered at all in the fallback.
   */
  clerkEnabled: boolean
}) {
  const router = useRouter()
  // ⚠ FOLLOWS THE SERVER VALUE WHEN IT CHANGES. Without that, saving leaves the
  // input holding what you typed while the rest of the page has re-rendered
  // from the server — fine until somebody renames it in another tab, at which
  // point this field silently disagrees with the heading above it.
  const [name, setName] = useSyncedState(current)
  const [pending, setPending] = React.useState(false)

  /*
   * ⚠ A REF RATHER THAN STATE, BECAUSE NOTHING RENDERS DIFFERENTLY FOR IT.
   * The child below hands its reload function up on mount; storing that in
   * state would re-render this form every time Clerk's organization object
   * changed identity, for a value only an event handler ever reads.
   */
  const reloadOrganization = React.useRef<(() => Promise<void>) | null>(null)

  /*
   * ⚠ THE CHILD HANDS THE FUNCTION OVER RATHER THAN WRITING INTO A REF WE
   * PASS DOWN. The compiler refuses the second shape — a ref arriving as a
   * prop is somebody else's value and mutating it is exactly the kind of
   * cross-component write it exists to stop — so the write happens here, in
   * the component that owns the ref.
   */
  const holdReload = React.useCallback((reload: () => Promise<void>) => {
    reloadOrganization.current = reload
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending || !name.trim() || name.trim() === current) return

    setPending(true)
    const result = await renameWorkspace(name.trim())

    if (!result.ok) {
      setPending(false)
      toast.error("Could not rename the workspace", { description: result.error })
      return
    }

    /*
     * ⚠ AWAITED BEFORE THE BUTTON COMES BACK, so the rail has the new name by
     * the time the form looks finished. It is one request against Clerk's
     * client and it is the only thing left to do.
     */
    await reloadOrganization.current?.()
    setPending(false)

    /*
     * ⚠ THE FALLBACK STILL REFRESHES, BECAUSE NOTHING ELSE CAN UPDATE IT. With
     * no Clerk key the rail renders `tenant.name` from the server, and that
     * value only changes when the server renders again. It is the local
     * review path, not a deployment anybody uses.
     */
    if (!clerkEnabled) router.refresh()

    toast.success("Workspace renamed")
  }

  return (
    <>
      <form onSubmit={submit} className="flex max-w-md items-center gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          aria-label="Workspace name"
        />
        <Button
          type="submit"
          disabled={pending || !name.trim() || name.trim() === current}
        >
          {pending && <Spinner />}
          Save
        </Button>
      </form>

      {clerkEnabled && <OrganizationReload onReady={holdReload} />}
    </>
  )
}

/**
 * Hands a "re-read the organization" function up to the form.
 *
 * ⚠ ITS OWN COMPONENT SO THE HOOK IS CONDITIONAL WITHOUT A CONDITIONAL HOOK.
 * `useOrganization` throws outside a `<ClerkProvider>` and hooks cannot be
 * called behind an `if`; rendering the component behind one is the same
 * decision, legally expressed.
 *
 * ⚠ IT RENDERS NOTHING. The name it refreshes is drawn by Clerk's own switcher
 * in the rail, several components away — this exists only to reach it.
 */
function OrganizationReload({
  onReady,
}: {
  onReady: (reload: () => Promise<void>) => void
}) {
  const { organization } = useOrganization()

  React.useEffect(() => {
    onReady(async () => {
      // ⚠ `reload()` REFETCHES THE RESOURCE AND CLERK'S STORE NOTIFIES EVERY
      // COMPONENT BOUND TO IT, which is how the switcher in the rail changes
      // without this one knowing it exists.
      await organization?.reload()
    })
  }, [organization, onReady])

  return null
}
