"use client"

import * as React from "react"
import { Checkbox } from "@repo/ui/components/checkbox"
import { BULK_CONFIRM_WORD, ConfirmDialog } from "@/components/confirm-dialog"
import { deleteDomain, revokeApiKey } from "@/lib/actions"
import { OUTCOME_HOLD_MS } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import { useStepUp } from "@/lib/step-up"
import { toastError } from "@/lib/toast"

/**
 * The one delete-a-domain conversation, wherever it is started from.
 *
 * ⚠ IT WAS EXTRACTED THE MOMENT THERE WAS A SECOND WAY IN, AND THAT IS THE
 * WHOLE REASON IT IS A COMPONENT. The danger zone on the domain page had all
 * of this inline; adding a row action on the list would have meant a second
 * copy of the step-up call, the revoke-first ordering and the checkbox that
 * defaults to ticked. Two copies of a destructive flow do not stay identical
 * - one of them gets the next fix - and the divergence is invisible until
 * somebody deletes a domain from the list and their scoped keys survive.
 *
 * ⚠ IT OWNS NO TRIGGER. The two callers disagree about what opens it (a
 * labelled button in a red box, an item in a row menu) and about where you are
 * afterwards (the list, or still on the list), and those are the only two
 * things that should differ. Everything that makes the delete safe lives here.
 */
export function DeleteDomainDialog({
  id,
  name,
  scopedKeys = [],
  open,
  onOpenChange,
  onDeleted,
}: {
  id: string
  name: string
  /**
   * The live keys that can ONLY send from this domain.
   *
   * ⚠ FILTERED BY THE CALLER, NOT HERE, so this component never has to know
   * how a scope is spelled. Both callers read `domain` off each key, which the
   * API derives from `scopes`.
   */
  scopedKeys?: { id: string; name: string }[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Called once the "Deleted" tick has been seen - see lib/outcome.ts. A list
   * page passes nothing: the row is already gone behind the dialog.
   */
  onDeleted?: () => void
}) {
  return (
    <DeleteDomainsDialog
      domains={[{ id, name, scopedKeys }]}
      open={open}
      onOpenChange={onOpenChange}
      onDeleted={onDeleted}
    />
  )
}

/**
 * The same conversation for several domains at once - the list's bulk delete.
 *
 * ⚠ ONE COMPONENT, NOT A SECOND COPY. A single delete is this with one domain
 * in it; the step-up, the revoke-first ordering and the keys question are the
 * same code either way, which is the whole reason this file exists.
 *
 * ⚠ THE DOMAINS GO ONE AT A TIME, AND A FAILURE STOPS THERE. There is no bulk
 * endpoint, and a handful is all anybody ticks. What already went is
 * remembered, so pressing the button again after a failure carries on from
 * the domain that failed instead of re-deleting the ones that are gone.
 */
export function DeleteDomainsDialog({
  domains,
  open,
  onOpenChange,
  onDeleted,
}: {
  domains: { id: string; name: string; scopedKeys?: { id: string; name: string }[] }[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const stepUp = useStepUp()
  /*
   * ⚠ IT DEFAULTS TO REVOKING THEM, WHICH IS THE OPPOSITE OF THE USUAL RULE
   * FOR A DESTRUCTIVE CHECKBOX. The alternative - leaving them - is the one
   * that ends with a valid credential nobody can use and nobody remembers why
   * they made. Anybody who wants to keep a key for a domain they are about to
   * re-add can untick it, and the label says exactly what it will do.
   */
  const [alsoRevoke, setAlsoRevoke] = React.useState(true)
  const done = React.useRef(new Set<string>())
  useResetOnOpen(open, () => {
    done.current = new Set()
  })

  const one = domains.length === 1 ? domains[0]! : null
  const scopedKeys = domains.flatMap((d) => d.scopedKeys ?? [])

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={one ? `Delete ${one.name}?` : `Delete ${domains.length} domains?`}
      description={
        one
          ? "Mail can no longer be sent from this domain, and its DNS records stop being served if it was delegated. Messages already sent keep their history."
          : `Mail can no longer be sent from ${domains.map((d) => d.name).join(", ")}, and their DNS records stop being served where they were delegated. Messages already sent keep their history.`
      }
      confirmLabel={one ? "Delete domain" : `Delete ${domains.length} domains`}
      doneLabel="Deleted"
      /*
       * ⚠ DELETING A DOMAIN STOPS ITS MAIL, SO IT ASKS FOR THE NAME. This is
       * not ceremony: typing it is the difference between losing a staging
       * domain and losing production, and it is the only confirmation that
       * requires reading which domain you are actually on. Several at once
       * have no single name, so they take the word every bulk delete takes.
       */
      confirmWord={one ? one.name : BULK_CONFIRM_WORD}
      onConfirm={async () => {
        /*
         * ⚠ PROVED ONCE, BEFORE ANY OF IT, RATHER THAN PER CALL. The prompt
         * works by replaying the request it refused, and this flow is several
         * requests - replaying it half-done would try to revoke keys that are
         * already revoked and report a failure for work that succeeded.
         * `stepUp` asks against a route that does nothing, so retrying it
         * costs nothing. See lib/step-up.ts - and note the API refuses the
         * delete on its own, so this is the prompt rather than the protection.
         *
         * ⚠ AND `false` LEAVES THE DIALOG OPEN WITH NOTHING DESTROYED, which
         * is the right answer to somebody closing the verification prompt.
         */
        if (!(await stepUp())) return false

        for (const domain of domains) {
          if (done.current.has(domain.id)) continue
          /*
           * ⚠ THE KEYS GO FIRST, AND THE ORDER IS THE SAFE ONE RATHER THAN THE
           * TIDY ONE. If the domain delete fails after the keys are revoked,
           * somebody has a working domain and some dead keys - annoying, and
           * fixable by creating new ones. The other order risks a deleted
           * domain and live keys still pointing at it, which is the exact
           * state this is here to prevent.
           */
          if (alsoRevoke) {
            for (const key of domain.scopedKeys ?? []) {
              const revoked = await revokeApiKey(key.id)
              if (!revoked.ok) {
                toastError(`Could not revoke ${key.name}`, revoked.error)
                return false
              }
            }
          }

          const result = await deleteDomain(domain.id)
          if (!result.ok) {
            toastError(`Could not delete ${domain.name}`, result.error)
            return false
          }
          done.current.add(domain.id)
        }

        // ⚠ AFTER THE HOLD, SO THE TICK IS SEEN BEFORE THE PAGE GOES. The
        // detail page navigates away here; leaving at once would take the
        // dialog with it mid-sentence.
        if (onDeleted) setTimeout(onDeleted, OUTCOME_HOLD_MS)
        return true
      }}
    >
      {/*
       * ⚠ IT ASKS ABOUT THE KEYS THAT ONLY WORKED HERE, BECAUSE NOTHING ELSE
       * EVER WILL. A key restricted to a deleted domain becomes a live
       * credential that can send from nothing - it does not fail, it does not
       * warn, it simply sits in somebody's environment being valid. The person
       * deleting the domain is the only one who will ever be in a position to
       * connect the two, and this is the only moment they are in it.
       *
       * ⚠ AN UNRESTRICTED KEY IS NOT MENTIONED, DELIBERATELY. It works
       * perfectly well for every other domain, so offering to revoke it would
       * be offering to break something unrelated.
       */}
      {scopedKeys.length > 0 && (
        <label className="flex cursor-pointer items-start gap-3 rounded-md border border-warning/25 bg-warning/5 p-3">
          <Checkbox
            checked={alsoRevoke}
            onCheckedChange={(next) => setAlsoRevoke(next === true)}
            className="mt-0.5"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium">
              {scopedKeys.length === 1
                ? `Also revoke the key that only sends from ${one ? "this domain" : "these domains"}`
                : `Also revoke the ${scopedKeys.length} keys that only send from ${one ? "this domain" : "these domains"}`}
            </span>
            <span className="block text-xs text-muted-foreground">
              {/*
               * ⚠ THE KEYS ARE NAMED. "One key" is an abstraction somebody has
               * to go and resolve in another tab before they can answer;
               * "production-api" is the thing they recognise.
               */}
              {scopedKeys.map((key) => key.name).join(", ")} - leaving{" "}
              {scopedKeys.length === 1 ? "it" : "them"} means a live key that can send
              from nothing.
            </span>
          </span>
        </label>
      )}
    </ConfirmDialog>
  )
}
