"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import { ConnectProviderButton } from "@/components/connect-provider-button"
import { publishDnsRecords } from "@/lib/actions"
import type { ConflictingRecord, DnsConnection } from "@/lib/types"

/**
 * "Publish these for me."
 *
 * ⚠ THIS IS THE BUTTON THAT MAKES DELEGATION WORTH HAVING. Three delegated names
 * is still six NS records typed by hand into somebody else's dashboard, and a
 * record typed into the wrong field looks exactly like one that has not
 * propagated — which is the single most expensive support conversation this
 * product has. Where we hold a credential for the provider that hosts the
 * domain, none of it needs typing.
 *
 * ⚠ IT ASKS BEFORE IT DELETES, AND THE FIRST PRESS NEVER WRITES WHEN SOMETHING
 * IS IN THE WAY. Anybody who has configured DMARC has a TXT record at exactly
 * the name delegation takes over. Removing it is usually right and is never ours
 * to decide silently, so the API answers 409 with the list, this shows it, and
 * the second press carries the confirmation.
 */
export function PublishRecords({
  domainId,
  connection,
  providerSlug,
  providerName,
}: {
  domainId: string
  /** `null` when this workspace has not connected the provider yet. */
  connection: DnsConnection | null
  /** The registry slug. Required: it is what the API matches an adapter on. */
  providerSlug: string
  providerName: string
}) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const [conflicts, setConflicts] = React.useState<ConflictingRecord[] | null>(null)

  async function publish(replaceConflicts: boolean) {
    if (pending || !connection) return
    setPending(true)

    const result = await publishDnsRecords({
      domainId,
      provider: connection.provider,
      replaceConflicts,
    })

    setPending(false)

    if (!result.ok) {
      /*
       * ⚠ A 409 IS THE PROTOCOL, NOT A FAILURE. The API writes nothing and
       * returns what stands in the way; treating it as an error toast would
       * leave somebody with a button that reports a problem and offers no way
       * through it.
       */
      if (result.status === 409 && !replaceConflicts) {
        // ⚠ NARROWED, NOT CAST. `body` is the API's own JSON and is data.
        const listed = result.body?.conflicts
        setConflicts(Array.isArray(listed) ? (listed as ConflictingRecord[]) : [])
        return
      }

      toast.error("Could not publish the records", { description: result.error })
      return
    }

    setConflicts(null)

    const created = result.data.created.length
    const removed = result.data.removed.length
    toast.success(
      created === 0
        ? "Everything was already published"
        : `Published ${created} records`,
      {
        description:
          removed > 0
            ? `${removed} conflicting records were removed. Verification usually follows within minutes.`
            : "Verification usually follows within minutes.",
      },
    )
    router.refresh()
  }

  if (!connection) {
    return <ConnectProviderButton slug={providerSlug} providerName={providerName} />
  }

  return (
    <>
      <Button size="sm" onClick={() => publish(false)} disabled={pending}>
        {pending ? <Spinner /> : <Wand2 />}
        Publish these for me
      </Button>

      <Dialog
        open={conflicts !== null}
        onOpenChange={(open) => !open && setConflicts(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Some records are in the way</DialogTitle>
            <DialogDescription>
              {/*
               * ⚠ THE EXPLANATION IS WHY IT IS SAFE, NOT A WARNING. These
               * records stop being used the moment the delegation exists —
               * whatever is published at a delegated name in the parent zone is
               * unreachable — so the honest framing is that they are already
               * obsolete, not that we are about to break something.
               */}
              Publishing means removing these first. Once {providerName} delegates these
              names to us they stop being used anyway, because a delegated name is
              answered by whoever holds the delegation.
            </DialogDescription>
          </DialogHeader>

          <ul className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-3">
            {(conflicts ?? []).map((conflict, index) => (
              <li key={`${conflict.name}-${index}`} className="text-xs">
                <span className="font-mono font-medium">{conflict.type}</span>{" "}
                <span className="font-mono">{conflict.name}</span>
                <p className="mt-0.5 font-mono break-all text-muted-foreground">
                  {conflict.value}
                </p>
              </li>
            ))}
          </ul>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setConflicts(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => publish(true)}
              disabled={pending}
            >
              {pending && <Spinner />}
              Remove them and publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
