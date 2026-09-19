"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
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
import { Label } from "@repo/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { Spinner } from "@repo/ui/components/spinner"
import { updateApiKeyScope } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

/**
 * Which domain a key may send from.
 *
 * ⚠ THE ANSWER IS "EVERY DOMAIN" OR "ONE DOMAIN", AND THAT IS NOT A
 * SIMPLIFICATION OF A MULTI-SELECT. A key restricted to two of four domains is
 * a thing nobody asks for and everybody mis-reads in a list; two keys say the
 * same thing and can be revoked separately, which is the point of restricting
 * them at all. The column underneath holds an array anyway, so an operator can
 * do something cleverer by hand without this needing to grow a control for it.
 *
 * ⚠ AND IT IS A DOMAIN NAME RATHER THAN AN ID. The API validates the name
 * against the workspace's own domains, and a name survives being read aloud, put
 * in a runbook, or compared against an environment variable. An id survives
 * none of those.
 *
 * ⚠ `ALL` IS A SENTINEL BECAUSE RADIX REFUSES AN EMPTY `SelectItem` VALUE — it
 * uses the empty string internally to mean "nothing selected", so an item with
 * that value throws. It never leaves this file; the caller sees `null`.
 */

const ALL = "__all__"

export interface ScopeDomain {
  id: string
  name: string
}

export function ApiKeyScopeField({
  id,
  value,
  onChange,
  domains,
  disabled,
}: {
  id: string
  /** `null` is every domain. */
  value: string | null
  onChange: (domain: string | null) => void
  domains: ScopeDomain[]
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Sending domain</Label>
      <Select
        value={value ?? ALL}
        onValueChange={(next) => onChange(next === ALL ? null : next)}
        disabled={disabled || domains.length === 0}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All domains</SelectItem>
          {domains.map((domain) => (
            <SelectItem key={domain.id} value={domain.name} className="font-mono">
              {domain.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <p className="text-xs text-muted-foreground">
        {/*
         * ⚠ THE SENTENCE NAMES THE LIMIT OF THE LIMIT. A restricted key still
         * reads everything the workspace can read — messages, contacts, its own
         * list of keys — and somebody who believed otherwise would be handing it
         * to a third party. What it cannot do is send as another domain, and it
         * cannot manage keys at all, which is what stops it widening itself.
         */}
        {domains.length === 0
          ? "Add a domain first and you will be able to restrict a key to it."
          : value === null
            ? "This key can send from any domain you have verified, now or later."
            : `This key can only send from ${value}. It can still read everything else in the workspace, and it cannot create or revoke keys.`}
      </p>
    </div>
  )
}

/**
 * Changing the scope of a key that is already deployed.
 *
 * ⚠ IT IS NOT A CONFIRMATION DIALOG, AND IT DELIBERATELY DOES NOT WARN. Both
 * directions are reversible — narrow it, find out something broke, widen it
 * back — and the action it needs to be easy is narrowing. A "are you sure"
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
  apiKey: { id: string; name: string; domain: string | null } | null
  domains: ScopeDomain[]
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [domain, setDomain] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  /*
   * ⚠ SEEDED FROM THE KEY EACH TIME THE DIALOG OPENS, NOT ONCE. The same
   * component serves every row, so without this the second key somebody opens
   * shows the first one's scope — and the Save button would then quietly apply
   * it.
   */
  useResetOnOpen(apiKey !== null, () => setDomain(apiKey?.domain ?? null))

  async function save() {
    if (!apiKey || pending) return
    setPending(true)
    const result = await updateApiKeyScope(apiKey.id, domain)
    setPending(false)

    if (!result.ok) {
      toast.error("Could not change the scope", { description: result.error })
      return
    }

    toast.success(
      domain
        ? `${apiKey.name} can now only send from ${domain}`
        : `${apiKey.name} can send from any domain`,
    )
    onOpenChange(false)
    router.refresh()
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
            value={domain}
            onChange={setDomain}
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
            disabled={pending || domain === (apiKey?.domain ?? null)}
          >
            {pending && <Spinner />}
            Save scope
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
