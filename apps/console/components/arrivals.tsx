"use client"

import * as React from "react"
import { useClerk } from "@clerk/nextjs"
import { useRouter } from "next/navigation"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { Button } from "@repo/ui/components/button/button"
import { MotionItem, MotionList, clerkReason } from "@/components/account/shared"
import { myArrivals, type Arrival } from "@/lib/actions"
import { announceWorkspacesChanged } from "@/lib/workspace-name"
import { toastError } from "@/lib/toast"

/**
 * "You joined Acme" (#326): what happened at sign-up, on onboarding for
 * somebody with no workspace active.
 *
 * ⚠ AUTO-JOIN HAPPENS BEFORE THEY SEE ANYTHING, SO THIS IS WHERE THEY ARE
 * TOLD. The `user.created` webhook added them to every workspace whose rule
 * for their verified address is auto-join; asking here also runs it again in
 * case the webhook is still on its way (it is idempotent). Continue opens the
 * workspace; the set-up form below stays for somebody who would rather make
 * their own as well.
 *
 * ⚠ A FULL WORKSPACE IS SAID PLAINLY: a request was filed for its admins, and
 * nothing else is needed from them.
 */
export function Arrivals({ className }: { className?: string }) {
  const clerk = useClerk()
  const router = useRouter()
  const [list, setList] = React.useState<Arrival[] | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  React.useEffect(() => {
    void myArrivals().then((result) => {
      setList(result.ok ? result.data.data : [])
      // A workspace they were just added to belongs in the switcher too.
      if (result.ok && result.data.data.some((a) => a.outcome === "joined"))
        announceWorkspacesChanged()
    })
  }, [])

  if (!list || list.length === 0) return null

  async function open(arrival: Arrival) {
    setBusy(arrival.organization_id)
    try {
      await clerk.setActive({ organization: arrival.organization_id })
      router.push("/")
      router.refresh()
    } catch (error) {
      toastError(`Could not open ${arrival.name}`, clerkReason(error))
      setBusy(null)
    }
  }

  function createOwn() {
    const input = document.getElementById("workspace-name")
    input?.scrollIntoView({ block: "center", behavior: "smooth" })
    input?.focus({ preventScroll: true })
  }

  return (
    <div className={className}>
      <MotionList>
        {list.map((arrival) => (
          <MotionItem key={arrival.organization_id}>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4">
              <span className="flex min-w-0 items-center gap-3">
                <Avatar
                  name={arrival.name}
                  src={arrival.image_url ?? undefined}
                  className="rounded-lg"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {arrival.outcome === "joined"
                      ? `You joined ${arrival.name}`
                      : `${arrival.name} is full right now`}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {arrival.outcome === "joined"
                      ? "Your email address let you in automatically. Continue to open it, or create your own workspace below."
                      : "We've asked its admins to add you. You can create your own workspace in the meantime."}
                  </span>
                </span>
              </span>
              {arrival.outcome === "joined" && (
                <span className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={createOwn}>
                    Create your own workspace
                  </Button>
                  <Button
                    size="sm"
                    loading={busy === arrival.organization_id}
                    disabled={busy !== null}
                    onClick={() => void open(arrival)}
                  >
                    Continue
                  </Button>
                </span>
              )}
            </div>
          </MotionItem>
        ))}
      </MotionList>
    </div>
  )
}
