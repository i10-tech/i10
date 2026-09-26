"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useOrganizationList } from "@clerk/nextjs"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { Spinner } from "@repo/ui/components/spinner"
import { acceptTransfer, declineTransfer } from "@/lib/actions"
import type { IncomingTransfer } from "@/lib/types"

/**
 * Answering an offer: which workspace it lands in, then yes or no.
 *
 * ⚠ THE DESTINATION IS CHOSEN HERE, NOT BY THE SENDER. The offer is to a
 * person, and a person can be in several workspaces — including the sender's,
 * which the API has already left out of the list because the domain is there.
 *
 * ⚠ AND AFTER ACCEPTING, THE CONSOLE SWITCHES TO THAT WORKSPACE. Otherwise the
 * next page is the old workspace's domain list, without the domain they just
 * took, which reads as the accept having failed.
 */
export function AcceptTransfer({
  offer,
  clerkEnabled,
}: {
  offer: IncomingTransfer
  clerkEnabled: boolean
}) {
  const router = useRouter()
  const initial =
    offer.workspaces.find((w) => w.current)?.id ?? offer.workspaces[0]?.id ?? ""
  const [workspace, setWorkspace] = React.useState(initial)
  const [busy, setBusy] = React.useState<"accept" | "decline" | null>(null)
  const [landed, setLanded] = React.useState<{ org: string; domain: string } | null>(
    null,
  )

  const chosen = offer.workspaces.find((w) => w.id === workspace) ?? null

  async function accept() {
    if (!chosen || busy) return
    setBusy("accept")
    const result = await acceptTransfer(offer.id, chosen.id)
    if (!result.ok) {
      setBusy(null)
      toast.error("Could not accept the domain", { description: result.error })
      return
    }
    toast.success(`${offer.domain_name} is now in ${chosen.name}`)
    if (chosen.current || !clerkEnabled) {
      router.push(`/domains/${result.data.domain_id}`)
    } else {
      setLanded({ org: chosen.id, domain: result.data.domain_id })
    }
  }

  async function decline() {
    if (busy) return
    setBusy("decline")
    const result = await declineTransfer(offer.id)
    if (!result.ok) {
      setBusy(null)
      toast.error("Could not decline", { description: result.error })
      return
    }
    toast("Declined", { description: `${offer.domain_name} stays where it is.` })
    router.push("/domains")
  }

  if (offer.workspaces.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The domain is already in the only workspace you belong to. Create another
        workspace, then open this page again to take it there.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="transfer-destination" className="text-sm font-medium">
          Add it to
        </label>
        <Select value={workspace} onValueChange={setWorkspace} disabled={busy !== null}>
          <SelectTrigger id="transfer-destination" className="w-full">
            <SelectValue placeholder="Choose a workspace" />
          </SelectTrigger>
          <SelectContent>
            {offer.workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
                {w.current ? " (current)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={decline} disabled={busy !== null}>
          {busy === "decline" && <Spinner />}
          Decline
        </Button>
        <Button onClick={accept} disabled={!chosen || busy !== null}>
          {busy === "accept" && <Spinner />}
          Accept domain
        </Button>
      </div>

      {landed && (
        <SwitchWorkspace
          org={landed.org}
          onDone={() => router.push(`/domains/${landed.domain}`)}
        />
      )}
    </div>
  )
}

/**
 * ⚠ ITS OWN COMPONENT BECAUSE CLERK'S HOOKS THROW OUTSIDE A PROVIDER, and the
 * provider is only mounted when Clerk is configured. It is rendered only when
 * `clerkEnabled` said so.
 */
function SwitchWorkspace({ org, onDone }: { org: string; onDone: () => void }) {
  const { isLoaded, setActive } = useOrganizationList()
  const started = React.useRef(false)

  React.useEffect(() => {
    if (!isLoaded || started.current) return
    started.current = true
    // ⚠ A FAILED SWITCH STILL NAVIGATES. The domain is in the workspace either
    // way; the worst case is landing in the old one, where the switcher is.
    void setActive({ organization: org }).finally(onDone)
  }, [isLoaded, setActive, org, onDone])

  return null
}
