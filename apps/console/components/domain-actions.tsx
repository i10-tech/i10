"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontal, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Checkbox } from "@repo/ui/components/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { deleteDomain, revokeApiKey } from "@/lib/actions"
import { useStepUp } from "@/lib/step-up"

/**
 * ⚠ DELETING A DOMAIN STOPS ITS MAIL, SO IT ASKS FOR THE NAME. This is not
 * ceremony: the domain list is a table of similar-looking rows and the delete
 * is in a menu next to them. Typing the name is the difference between losing a
 * staging domain and losing production — and it is the only confirmation that
 * actually requires reading which row you are on.
 *
 * ⚠ AND IT ASKS ABOUT THE KEYS THAT ONLY WORKED HERE, BECAUSE NOTHING ELSE
 * EVER WILL. A key restricted to this domain becomes, the moment the domain
 * goes, a live credential that can send from nothing — it does not fail, it
 * does not warn, it simply sits in somebody's environment being valid. The
 * person deleting the domain is the only one who will ever be in a position to
 * connect the two, and this is the only moment they are in it.
 *
 * ⚠ AN UNRESTRICTED KEY IS NOT MENTIONED, DELIBERATELY. It works perfectly well
 * for every other domain, so offering to revoke it would be offering to break
 * something unrelated — and a prompt that appears whether or not it is relevant
 * is a prompt people stop reading.
 *
 * ⚠ AND IT ASKS THE PERSON TO PROVE THEMSELVES FIRST. Typing the name proves
 * they read which row they are on; it does not prove they are the customer.
 * A session cookie lives for days, so the two questions are different and this
 * is the one worth asking of a borrowed laptop. See lib/step-up.ts — and note
 * the API refuses the delete on its own, so this is the prompt rather than the
 * protection.
 */
export function DomainActions({
  id,
  name,
  scopedKeys = [],
}: {
  id: string
  name: string
  /**
   * The live keys that can ONLY send from this domain.
   *
   * ⚠ FILTERED BY THE PAGE, NOT HERE, so this component never has to know how
   * a scope is spelled. See the domain page — it reads `domain` off each key,
   * which the API derives from `scopes`.
   */
  scopedKeys?: { id: string; name: string }[]
}) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [confirming, setConfirming] = React.useState(false)
  /*
   * ⚠ IT DEFAULTS TO REVOKING THEM, WHICH IS THE OPPOSITE OF THE USUAL RULE
   * FOR A DESTRUCTIVE CHECKBOX. The alternative — leaving them — is the one
   * that ends with a valid credential nobody can use and nobody remembers why
   * they made. Anybody who wants to keep a key for a domain they are about to
   * re-add can untick it, and the label says exactly what it will do.
   */
  const [alsoRevoke, setAlsoRevoke] = React.useState(true)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Domain actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 />
            Delete domain
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${name}?`}
        description="Mail can no longer be sent from this domain, and its DNS records stop being served if it was delegated. Messages already sent keep their history."
        confirmLabel="Delete domain"
        confirmWord={name}
        onConfirm={async () => {
          /*
           * ⚠ PROVED ONCE, BEFORE ANY OF IT, RATHER THAN PER CALL. The prompt
           * works by replaying the request it refused, and this flow is up to
           * three requests — replaying it half-done would try to revoke keys
           * that are already revoked and report a failure for work that
           * succeeded. `stepUp` asks against a route that does nothing, so
           * retrying it costs nothing. See lib/step-up.ts.
           *
           * ⚠ AND `false` LEAVES THE DIALOG OPEN WITH NOTHING DESTROYED, which
           * is the right answer to somebody closing the verification prompt.
           */
          if (!(await stepUp())) return false

          /*
           * ⚠ THE KEYS GO FIRST, AND THE ORDER IS THE SAFE ONE RATHER THAN THE
           * TIDY ONE. If the domain delete fails after the keys are revoked,
           * somebody has a working domain and some dead keys — annoying, and
           * fixable by creating new ones. The other order risks a deleted
           * domain and live keys still pointing at it, which is the exact state
           * this is here to prevent.
           */
          if (alsoRevoke) {
            for (const key of scopedKeys) {
              const revoked = await revokeApiKey(key.id)
              if (!revoked.ok) {
                toast.error(`Could not revoke ${key.name}`, {
                  description: revoked.error,
                })
                return false
              }
            }
          }

          const result = await deleteDomain(id)
          if (!result.ok) {
            toast.error("Could not delete the domain", { description: result.error })
            return false
          }

          toast.success(`${name} deleted`, {
            description:
              alsoRevoke && scopedKeys.length > 0
                ? `${scopedKeys.length === 1 ? "Its key was" : `Its ${scopedKeys.length} keys were`} revoked.`
                : undefined,
          })
          router.push("/domains")
          return true
        }}
      >
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
                  ? "Also revoke the key that only sends from this domain"
                  : `Also revoke the ${scopedKeys.length} keys that only send from this domain`}
              </span>
              <span className="block text-xs text-muted-foreground">
                {/*
                 * ⚠ THE KEYS ARE NAMED. "One key" is an abstraction somebody
                 * has to go and resolve in another tab before they can answer;
                 * "production-api" is the thing they recognise, and naming it
                 * is what makes the checkbox answerable without leaving.
                 */}
                {scopedKeys.map((key) => key.name).join(", ")} — leaving{" "}
                {scopedKeys.length === 1 ? "it" : "them"} means a live key that can send
                from nothing.
              </span>
            </span>
          </label>
        )}
      </ConfirmDialog>
    </>
  )
}
