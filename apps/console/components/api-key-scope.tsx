"use client"

import * as React from "react"
import { MultiSelect } from "@repo/ui/components/multi-select/multi-select"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { GrowHeight } from "@repo/ui/components/i10/grow-height"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { updateApiKeyScope } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"
import { toastDone, toastError } from "@/lib/toast"

/**
 * Which domains a key may send from.
 *
 * ⚠ "ANY DOMAIN" OR "SPECIFIC", AND SPECIFIC MAY BE SEVERAL. It used to be
 * one domain, on the argument that two keys say the same thing as one key for
 * two domains. That holds until a key is already deployed somewhere that sends
 * for two products - then the only honest restriction is both, and forcing a
 * choice of one leaves the key unrestricted instead.
 *
 * ⚠ AND IT IS DOMAIN NAMES RATHER THAN IDS. The API validates the names against
 * the workspace's own domains, and a name survives being read aloud, put in a
 * runbook, or compared against an environment variable. An id survives none of
 * those.
 *
 * ⚠ `null` IS EVERY DOMAIN; AN EMPTY LIST IS "RESTRICTED, BUT TO NOTHING YET",
 * which is not saveable. Collapsing the two would turn "I unticked the last
 * box" into "this key can now send as anything".
 */

export interface ScopeDomain {
  id: string
  name: string
}

/** Whether a scope value can be saved. */
export const scopeComplete = (value: string[] | null): boolean =>
  value === null || value.length > 0

export function ApiKeyScopeField({
  value,
  onChange,
  domains,
  disabled,
}: {
  /** `null` is every domain. */
  value: string[] | null
  onChange: (domains: string[] | null) => void
  domains: ScopeDomain[]
  disabled?: boolean
}) {
  const restricted = value !== null
  const chosen = new Set(value ?? [])
  // ⚠ SINGULAR UNTIL THERE IS MORE THAN ONE TO CHOOSE FROM. "Specific domains"
  // over a list of one reads like the list is missing something.
  const specific = domains.length > 1 ? "Specific domains" : "Specific domain"

  return (
    <div className="space-y-2">
      <MorphSelect
        label="Sending domains"
        value={restricted ? "some" : "any"}
        onValueChange={(next) => onChange(next === "any" ? null : [...chosen])}
        disabled={disabled}
        className="w-full"
        items={[
          { value: "any", label: "Any domain" },
          // Greyed rather than hidden when there is nothing to pick: shown
          // and disabled, it says what is missing.
          {
            value: "some",
            label: specific,
            meta: domains.length === 0 ? "No domains yet" : undefined,
            disabled: domains.length === 0,
          },
        ]}
      />

      {/*
       * ⚠ REVEALED, NOT SWAPPED IN, AND ONLY FOR "SPECIFIC". The list opens under
       * the choice that asked for it, so the eye follows the movement down; it
       * is not there at all otherwise. See `Reveal` for the spring.
       */}
      {/*
       * ⚠ `pb-3` IS THE BREATHING ROOM BETWEEN THE LAST DOMAIN AND THE LINE
       * UNDER IT, which otherwise sat tight against the pill like part of it.
       */}
      <Reveal show={restricted} spacing="pt-1 pb-3">
        {/*
         * ⚠ EACH DOMAIN IS ITS OWN PILL, THE SAME SHAPE AND INSET AS THE FIELDS
         * ABOVE, so the options read as controls of the same family rather than
         * a table dropped into a form.
         */}
        <MultiSelect
          label="Domains this key may send from"
          placeholder="Choose domains"
          options={domains.map((d) => ({ value: d.name, label: d.name }))}
          // In the workspace's order, not click order, so the saved list and
          // the list on screen read the same way round.
          value={domains.map((d) => d.name).filter((n) => chosen.has(n))}
          onValueChange={(names) =>
            onChange(domains.map((d) => d.name).filter((n) => names.includes(n)))
          }
          disabled={disabled}
          maxVisible={3}
        />
      </Reveal>

      {/*
       * ⚠ THE LINE CHANGES LENGTH AS DOMAINS ARE TICKED - one short prompt, then
       * a two-line sentence naming them - so it grows on a spring rather than
       * pushing the buttons down in one frame.
       */}
      <GrowHeight>
        <p className="text-xs text-muted-foreground">
          {/*
           * ⚠ NO ERROR COLOUR FOR AN EMPTY PICK. Nothing has gone wrong while
           * somebody is still choosing; the button stays off until one is ticked,
           * and this line says why in the ordinary tone.
           *
           * ⚠ AND IT NAMES THE LIMIT OF THE LIMIT. A restricted key still reads
           * everything the workspace can read, and cannot manage keys at all -
           * which is what stops it widening itself.
           */}
          {domains.length === 0
            ? "Add a domain first and you will be able to restrict a key to it."
            : !restricted
              ? "This key can send from any domain you have verified, now or later."
              : chosen.size === 0
                ? `Choose the ${domains.length > 1 ? "domains" : "domain"} this key may send from.`
                : `This key can only send from ${[...chosen].join(", ")}. It can still read everything else in the workspace, and it cannot create or revoke keys.`}
        </p>
      </GrowHeight>
    </div>
  )
}

/**
 * Changing the scope of a key that is already deployed.
 *
 * ⚠ IT IS NOT A CONFIRMATION DIALOG, AND IT DELIBERATELY DOES NOT WARN. Both
 * directions are reversible - narrow it, find out something broke, widen it
 * back - and the action it needs to be easy is narrowing. A "are you sure"
 * over a change somebody can undo in ten seconds is how confirmations become
 * noise, and the one in front of `Revoke` is the one that has to be read.
 *
 * ⚠ AND THE CHANGE IS IN FORCE WITHIN A MINUTE, NOT IMMEDIATELY. A verified
 * key sits in Redis with its scopes baked in for the cache TTL; the API evicts
 * that entry and treats a failed eviction as an error rather than reporting
 * success, so the only case this sentence covers is the ordinary one. Saying so
 * beats somebody testing it in the first second and concluding it is broken.
 */
export function ApiKeyScopeDialog({
  apiKey,
  domains,
  onOpenChange,
}: {
  apiKey: { id: string; name: string; domains: string[] } | null
  domains: ScopeDomain[]
  onOpenChange: (open: boolean) => void
}) {
  const [scope, setScope] = React.useState<string[] | null>(null)
  const [pending, setPending] = React.useState(false)

  /*
   * ⚠ SEEDED FROM THE KEY EACH TIME THE DIALOG OPENS, NOT ONCE. The same
   * component serves every row, so without this the second key somebody opens
   * shows the first one's scope - and the Save button would then quietly apply
   * it.
   */
  useResetOnOpen(apiKey !== null, () =>
    setScope(apiKey && apiKey.domains.length > 0 ? apiKey.domains : null),
  )

  const saved = apiKey && apiKey.domains.length > 0 ? apiKey.domains : null
  const unchanged =
    (scope === null && saved === null) ||
    (scope !== null && saved !== null && scope.join(",") === saved.join(","))

  async function save() {
    if (!apiKey || pending || !scopeComplete(scope)) return
    setPending(true)
    const result = await updateApiKeyScope(apiKey.id, scope ?? [])
    setPending(false)

    if (!result.ok) {
      toastError("Could not change the scope", { description: result.error })
      return
    }

    toastDone(
      scope
        ? `${apiKey.name} can now only send from ${scope.join(", ")}`
        : `${apiKey.name} can send from any domain`,
    )
    onOpenChange(false)
  }

  return (
    <Dialog open={apiKey !== null} onOpenChange={pending ? () => {} : onOpenChange}>
      <DialogContent
        title={`Scope for ${apiKey?.name ?? "this key"}`}
        description="Restricting a key limits what a leak of it can do. The key itself does not change, so nothing needs redeploying."
        style={{ width: "min(calc(100vw - 2rem), 448px)" }}
      >
        <div className="py-2">
          <ApiKeyScopeField
            value={scope}
            onChange={setScope}
            domains={domains}
            disabled={pending}
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            loading={pending}
            type="button"
            onClick={save}
            // ⚠ DISABLED WHEN NOTHING CHANGED, so the button cannot be a
            // no-op request that still fires a success toast.
            disabled={pending || unchanged || !scopeComplete(scope)}
          >
            Save scope
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
