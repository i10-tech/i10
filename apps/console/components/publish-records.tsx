"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { ConnectProviderButton } from "@/components/connect-provider-button"
import { ProviderMark } from "@/components/provider-mark"
import { publishDnsRecords } from "@/lib/actions"
import { useRetained } from "@/lib/react"
import type { ConflictingRecord, DnsConnection } from "@/lib/types"
import { toastDone, toastError } from "@/lib/toast"

/**
 * "Publish these for me."
 *
 * ⚠ THIS IS THE BUTTON THAT MAKES DELEGATION WORTH HAVING. Three delegated names
 * is still six NS records typed by hand into somebody else's dashboard, and a
 * record typed into the wrong field looks exactly like one that has not
 * propagated - which is the single most expensive support conversation this
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
  domainName,
  connection,
  providerSlug,
  providerName,
}: {
  domainId: string
  /** Typed to confirm removing the records in the way. */
  domainName: string
  /** `null` when this workspace has not connected the provider yet. */
  connection: DnsConnection | null
  /** The registry slug. Required: it is what the API matches an adapter on. */
  providerSlug: string
  providerName: string
}) {
  const [pending, setPending] = React.useState(false)
  const [conflicts, setConflicts] = React.useState<ConflictingRecord[] | null>(null)
  // Kept while the dialog animates out, so the list does not empty and
  // collapse the panel on its way out. See `useRetained`.
  const shownConflicts = useRetained(conflicts)

  /** Whether it published. The confirm dialog closes only on `true`. */
  async function publish(replaceConflicts: boolean): Promise<boolean> {
    if (pending || !connection) return false
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
        return false
      }

      toastError("Could not publish the records", { description: result.error })
      return false
    }

    setConflicts(null)

    const created = result.data.created.length
    const removed = result.data.removed.length
    toastDone(
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
    // No refresh: `publishDnsRecords` re-renders this page in its own response,
    // so the record statuses have already changed by the time this toast shows.
    return true
  }

  if (!connection) {
    return (
      <ConnectProviderButton
        slug={providerSlug}
        providerName={providerName}
        // ⚠ "CONNECT" UNTIL IT IS CONNECTED, THEN "PUBLISH RECORDS"
        // (2026-10-03) - the same two words as the add-domain flow.
        className="rounded-full"
      />
    )
  }

  return (
    <>
      {/*
       * ⚠ "PUBLISH RECORDS", WITH THE PROVIDER'S MARK (2026-10-03). The
       * provider is connected, so this writes the records now; the mark says
       * where they will go.
       */}
      <Button
        variant="outline"
        size="sm"
        className="rounded-full"
        onClick={() => publish(false)}
        disabled={pending}
      >
        {pending ? (
          <Spinner />
        ) : (
          <ProviderMark slug={providerSlug} name={providerName} />
        )}
        Publish records
      </Button>

      {/*
       * ⚠ THE SAME CONFIRMATION AS EVERY OTHER DESTRUCTIVE ACTION: THE NAME
       * TYPED OUT. These are records in the customer's own DNS, and removing
       * them is the one thing this button does that nobody can undo from here.
       */}
      <ConfirmDialog
        open={conflicts !== null}
        onOpenChange={(open) => !open && setConflicts(null)}
        title="Some records are in the way"
        description={`Publishing means removing these first. Once ${providerName} delegates these names to us they stop being used anyway, because a delegated name is answered by whoever holds the delegation.`}
        confirmLabel="Remove them and publish"
        confirmWord={domainName}
        onConfirm={() => publish(true)}
      >
        <ul className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-3">
          {(shownConflicts ?? []).map((conflict, index) => (
            <li key={`${conflict.name}-${index}`} className="text-xs">
              <span className="font-mono font-medium">{conflict.type}</span>{" "}
              <span className="font-mono">{conflict.name}</span>
              <p className="mt-0.5 font-mono break-all text-muted-foreground">
                {conflict.value}
              </p>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  )
}
