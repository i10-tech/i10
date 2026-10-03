"use client"

import * as React from "react"
import { emailProblem } from "@repo/ui/checks"
import { EmailInput } from "@repo/ui/components/email-input"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { offerTransfer } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"
import { useStepUp } from "@/lib/step-up"
import { toastDone, toastError } from "@/lib/toast"

/** A key and what its scope becomes once the domain leaves. */
export interface KeyImpact {
  id: string
  name: string
  /** The domains it keeps. Empty means it is revoked. */
  keeps: string[]
}

/**
 * Offering a domain to somebody by email.
 *
 * ⚠ AN OFFER, NOT A MOVE. The domain keeps sending from here until the
 * recipient accepts, and it can be withdrawn until then - but once accepted it
 * is gone from this workspace as surely as if it were deleted. So it carries
 * the delete's friction, in the delete's order: the name typed out, then
 * Clerk's verification prompt, then the request.
 *
 * ⚠ ANY ADDRESS, INCLUDING SOMEBODY IN THIS WORKSPACE OR YOUR OWN. The
 * recipient chooses which of THEIR workspaces it lands in, so an offer to a
 * colleague is how a domain moves into another workspace you share.
 *
 * ⚠ THE KEYS ARE SPELLED OUT BEFORE THE OFFER, BECAUSE NOBODY CAN BE ASKED
 * LATER. Keys stay with this workspace; the ones limited to this domain are
 * revoked when the recipient accepts and the ones shared with other domains
 * lose it. That happens on the recipient's click, when nobody here is looking,
 * so this is the only moment to say it.
 */
export function TransferDomainDialog({
  id,
  name,
  keys = [],
  ownEmails = [],
  open,
  onOpenChange,
  onOffered,
}: {
  id: string
  name: string
  /** Live keys whose scope includes this domain. Computed by the page. */
  keys?: KeyImpact[]
  /** The person's own verified addresses, which a transfer may not go to. */
  ownEmails?: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onOffered: () => void
}) {
  const stepUp = useStepUp()
  const [email, setEmail] = React.useState("")

  useResetOnOpen(open, () => setEmail(""))

  /*
   * ⚠ THE SHARED EMAIL CHECK, THEN ONE MORE RULE. A transfer is to another
   * person; offering a domain to yourself would be accepting your own offer.
   * The API refuses it as well - this is the early, friendly half.
   */
  const own = new Set(ownEmails.map((e) => e.toLowerCase()))
  const recipientProblem = (value: string) =>
    emailProblem(value) ??
    (own.has(value.trim().toLowerCase())
      ? "That is your own address. Offer it to someone else."
      : null)
  const recipientOk = recipientProblem(email) === null && email.trim() !== ""

  const revoked = keys.filter((k) => k.keeps.length === 0)
  const narrowed = keys.filter((k) => k.keeps.length > 0)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Transfer ${name}?`}
      description="We will email them an offer. The domain moves with its records and verification, so nothing changes in your DNS - and it stops sending from this workspace once they accept."
      confirmLabel="Send offer"
      confirmWord={name}
      ready={recipientOk}
      initialFocus="transfer-email"
      onConfirm={async () => {
        if (!recipientOk) return false
        if (!(await stepUp())) return false

        const result = await offerTransfer(id, email.trim())
        if (!result.ok) {
          toastError("Could not offer the domain", { description: result.error })
          return false
        }

        toastDone(`Offer sent to ${result.data.recipient_email}`, {
          description: result.data.emailed
            ? "It stays here until they accept. You can withdraw it until then."
            : "We could not email them, so they will only see it if they already have an i10 account - on their Domains page.",
          duration: result.data.emailed ? 6000 : 12_000,
        })
        onOffered()
        return true
      }}
    >
      <EmailInput
        id="transfer-email"
        label="Email address"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        check={recipientProblem}
        required="Enter the address to offer it to."
        hint="They sign in with it - or sign up - to accept."
      />

      {keys.length > 0 && (
        <div className="space-y-2 rounded-md border border-warning/25 bg-warning/5 p-3">
          <p className="text-sm font-medium">When they accept, your API keys change</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {revoked.map((key) => (
              <li key={key.id}>
                <span className="font-medium text-foreground">{key.name}</span> is
                revoked - it only sends from {name}.
              </li>
            ))}
            {narrowed.map((key) => (
              <li key={key.id}>
                <span className="font-medium text-foreground">{key.name}</span> will
                only send from <span className="font-mono">{key.keeps.join(", ")}</span>
                , not <span className="font-mono">{name}</span>.
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Keys that can send from any domain keep working for your other domains. Keys
            never move with a domain.
          </p>
        </div>
      )}
    </ConfirmDialog>
  )
}
