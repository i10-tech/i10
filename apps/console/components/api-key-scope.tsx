"use client"

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import { Checkbox } from "@repo/ui/components/checkbox"
import { Label } from "@repo/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { GrowHeight } from "@repo/ui/components/grow-height"
import { Reveal } from "@repo/ui/components/reveal"
import { Spinner } from "@repo/ui/components/spinner"
import { updateApiKeyScope } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

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
  id,
  value,
  onChange,
  domains,
  disabled,
}: {
  id: string
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

  function toggle(name: string, on: boolean) {
    const next = new Set(chosen)
    if (on) next.add(name)
    else next.delete(name)
    // ⚠ IN THE WORKSPACE'S ORDER, not click order, so the saved list and the
    // list on screen read the same way round.
    onChange(domains.map((d) => d.name).filter((n) => next.has(n)))
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Sending domains</Label>
      <Select
        value={restricted ? "some" : "any"}
        onValueChange={(next) => onChange(next === "any" ? null : [...chosen])}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any domain</SelectItem>
          {/*
           * ⚠ GREYED RATHER THAN HIDDEN WHEN THERE IS NOTHING TO PICK. Hiding it
           * would make the restriction look like a feature that does not exist;
           * shown and disabled, it says what is missing.
           */}
          <SelectItem value="some" disabled={domains.length === 0}>
            {domains.length === 0
              ? "Specific domain - you have no domains added"
              : specific}
          </SelectItem>
        </SelectContent>
      </Select>

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
        <ul className="space-y-2">
          {domains.map((domain) => (
            <li key={domain.id}>
              <label className="flex h-14 cursor-pointer items-center gap-3 rounded-pill border border-input px-6 transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-muted/30 dark:bg-input/25">
                <Checkbox
                  checked={chosen.has(domain.name)}
                  onCheckedChange={(on) => toggle(domain.name, on === true)}
                  disabled={disabled}
                />
                <span className="truncate font-mono text-sm">{domain.name}</span>
              </label>
            </li>
          ))}
        </ul>
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
      toast.error("Could not change the scope", { description: result.error })
      return
    }

    toast.success(
      scope
        ? `${apiKey.name} can now only send from ${scope.join(", ")}`
        : `${apiKey.name} can send from any domain`,
    )
    onOpenChange(false)
  }

  return (
    <Dialog open={apiKey !== null} onOpenChange={pending ? () => {} : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Scope for {apiKey?.name}</DialogTitle>
          <DialogDescription>
            Restricting a key limits what a leak of it can do. The key itself does not
            change, so nothing needs redeploying.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <ApiKeyScopeField
            id="scope-domain"
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
            type="button"
            onClick={save}
            // ⚠ DISABLED WHEN NOTHING CHANGED, so the button cannot be a
            // no-op request that still fires a success toast.
            disabled={pending || unchanged || !scopeComplete(scope)}
          >
            {pending && <Spinner />}
            Save scope
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
