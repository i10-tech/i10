"use client"

import * as React from "react"
import { useClerk, useSession } from "@clerk/nextjs"
import { isClerkAPIResponseError } from "@clerk/nextjs/errors"
import type {
  PasskeyResource,
  SessionWithActivitiesResource,
  TOTPResource,
  UserResource,
} from "@clerk/shared/types"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Download, Smartphone } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { Checkbox } from "@repo/ui/components/checkbox/checkbox"
import { CopyButton } from "@repo/ui/components/copy-button/copy-button"
import { DropdownMenuItem } from "@repo/ui/components/i10/menu"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { OtpField, OTP_LENGTH } from "@repo/ui/components/i10/otp-field"
import {
  DeviceLaptopIcon,
  DeviceMobileIcon,
} from "@repo/ui/components/i10/device-icons"
import { PasskeyCue } from "@repo/ui/components/i10/passkey-cue"
import { PasskeyIcon } from "@repo/ui/components/i10/passkey-icons"
import { PasswordInput } from "@repo/ui/components/i10/password-input"
import { PasswordRules } from "@repo/ui/components/i10/password-rules"
import { QrCode } from "@repo/ui/components/i10/qr-code"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { StepStage } from "@repo/ui/components/i10/step-stage"
import { TextMorph } from "@repo/ui/components/text-morph/text-morph"
import { createPasswordRules } from "@repo/ui/components/password-strength/password-strength"
import {
  AddAction,
  useFollowOpen,
  MotionItem,
  MotionList,
  ProfileBlock,
  ProfileRow,
  clerkReason,
  shortDate,
} from "@/components/account/shared"
import { ConfirmDialog, confirmWordFor } from "@/components/confirm-dialog"
import { DeletionWarning } from "@/components/deletion-warning"
import { RowMenu } from "@/components/list/row-menu"
import { verifyPassword } from "@/lib/actions"
import { useReverify } from "@/lib/step-up"
import { toastDone, toastError } from "@/lib/toast"
import type { BillingState } from "@/lib/types"

/**
 * "Security" - the second block of Clerk's `<UserProfile />`: password,
 * passkeys, two-step verification, active devices and deleting the account,
 * ours (2026-10-12). Every sensitive change runs through `useReverify`, which
 * is what Clerk's panel did with its own modal - ours now.
 */
export function Security({
  user,
  minLength,
  passkeys,
  billing,
}: {
  user: UserResource
  /** The instance's password length, from its environment. */
  minLength: number
  /** Whether this instance has passkeys switched on. */
  passkeys: boolean
  billing: BillingState | null
}) {
  return (
    <ProfileBlock title="Security">
      <ProfileRow label="Password">
        <PasswordEditor user={user} minLength={minLength} />
      </ProfileRow>
      {passkeys && (
        <ProfileRow label="Passkeys">
          <Passkeys user={user} />
        </ProfileRow>
      )}
      <ProfileRow label="Two-step verification">
        <TwoStep user={user} />
      </ProfileRow>
      <ProfileRow label="Active devices">
        <Devices user={user} />
      </ProfileRow>
      <ProfileRow label="Delete account">
        <DeleteAccount user={user} billing={billing} />
      </ProfileRow>
    </ProfileBlock>
  )
}

// ── Password ─────────────────────────────────────────────────────────────────

/**
 * Clerk's password row: "Set password" or "Update password" opening the form
 * in place - the new password twice, the checklist, and Clerk's "Sign out of
 * all other devices" box, on by default as Clerk's was.
 */
function PasswordEditor({
  user,
  minLength,
}: {
  user: UserResource
  minLength: number
}) {
  const reverify = useReverify()
  const [open, setOpen] = React.useState(false)
  /*
   * ⚠ EVERY OPEN IS A NEW FORM (2026-10-12). The fields, the confirmed tick,
   * the errors and the eye all start over: a password typed, abandoned with
   * Cancel and found still sitting there on the next open is a password left
   * on screen for whoever opens it next. The key remounts the form, which
   * resets what lives inside the inputs too.
   */
  const [round, setRound] = React.useState(0)
  const [current, setCurrent] = React.useState("")
  const [currentError, setCurrentError] = React.useState<string | null>(null)
  const [confirmed, setConfirmed] = React.useState(false)
  /** The check could not answer (503): Clerk decides at save instead. */
  const [unchecked, setUnchecked] = React.useState(false)
  const [next, setNext] = React.useState("")
  const [again, setAgain] = React.useState("")
  const [others, setOthers] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const rules = React.useMemo(() => createPasswordRules({ minLength }), [minLength])
  const follow = useFollowOpen<HTMLFormElement>(open)
  const asked = React.useRef("")

  function start() {
    setCurrent("")
    setCurrentError(null)
    setConfirmed(false)
    setUnchecked(false)
    setNext("")
    setAgain("")
    setOthers(true)
    setError(null)
    asked.current = ""
    setRound((n) => n + 1)
    setOpen(true)
  }

  function close() {
    setOpen(false)
    // The values go as soon as it closes, not when it next opens.
    setCurrent("")
    setNext("")
    setAgain("")
    asked.current = ""
  }

  /*
   * ⚠ ASKED WHEN THEY LEAVE THE BOX, NOT WHILE THEY TYPE. Every prefix of a
   * password is a wrong password, and each ask spends one of the ten tries the
   * API allows in fifteen minutes. A 503 says nothing either way, so the field
   * stays open and Clerk decides at save, as it always did.
   */
  async function check(value: string) {
    if (!value || confirmed || asked.current === value) return
    asked.current = value
    const result = await verifyPassword(value)
    // Typed over while we were asking: that answer is about another value.
    if (asked.current !== value) return
    if (result.ok) {
      if (result.data.verified) {
        setConfirmed(true)
        document.getElementById("new-password")?.focus()
      } else setCurrentError("That is not your current password.")
    } else if (result.status === 429) setCurrentError(result.error)
    else setUnchecked(true)
  }

  const ready =
    rules.every((rule) => rule.test(next)) &&
    next === again &&
    (!user.passwordEnabled ||
      (confirmed && next !== current) ||
      (unchecked && current !== "" && next !== current))

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!ready) return
    setSaving(true)
    setError(null)
    setCurrentError(null)
    const had = user.passwordEnabled
    try {
      const done = await reverify(() =>
        user.updatePassword({
          ...(had ? { currentPassword: current } : {}),
          newPassword: next,
          signOutOfOtherSessions: others,
        }),
      )
      if (!done) return
      toastDone(had ? "Password updated" : "Password set")
      close()
    } catch (error) {
      /*
       * ⚠ A WRONG CURRENT PASSWORD IS SAID UNDER THAT FIELD, not under the
       * new one - Clerk names the parameter it refused.
       */
      const aboutCurrent =
        isClerkAPIResponseError(error) &&
        error.errors.some(
          (entry) =>
            entry.meta?.paramName === "current_password" ||
            entry.code === "form_password_incorrect",
        )
      if (aboutCurrent) {
        setConfirmed(false)
        setCurrentError(clerkReason(error))
      } else setError(clerkReason(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-sm tracking-widest text-muted-foreground">
          {user.passwordEnabled ? "••••••••••" : "Not set"}
        </span>
        {!open && (
          <Button variant="ghost" size="sm" onClick={start}>
            {user.passwordEnabled ? "Update password" : "Set password"}
          </Button>
        )}
      </div>
      <Reveal show={open} spacing="pt-4">
        <form
          key={round}
          ref={follow}
          noValidate
          onSubmit={save}
          className="flex scroll-mb-6 flex-col gap-7 rounded-2xl border p-4"
        >
          {/*
           * ⚠ THE CURRENT PASSWORD FIRST, WHEN THERE IS ONE. Somebody at an
           * unlocked laptop should not be able to replace it without knowing
           * it; an account that signs in with a provider only has none to ask.
           * Once it is confirmed the eye turns into a green tick and the box
           * locks, leaving the new password and its confirmation open.
           */}
          {user.passwordEnabled && (
            <PasswordInput
              id="current-password"
              label="Current password"
              autoComplete="current-password"
              autoFocus
              value={current}
              verified={confirmed}
              /*
               * ⚠ NO WAITING TONE WHILE IT IS CHECKED. It flashed amber before
               * every answer, so a right password went amber then green; now a
               * right one goes straight to the tick and a wrong one says so once.
               */
              onChange={(event) => {
                setCurrentError(null)
                setUnchecked(false)
                asked.current = ""
                setCurrent(event.target.value)
              }}
              onBlur={(event) => void check(event.currentTarget.value)}
              refused={currentError ?? undefined}
            />
          )}
          <PasswordInput
            id="new-password"
            label="New password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => {
              setError(null)
              setNext(event.target.value)
            }}
            refused={error ?? undefined}
            reserveHint="open"
            /*
             * ⚠ NOT THE SAME AS THE CURRENT ONE (2026-10-12). Clerk accepts it
             * and nothing changes, which reads as "updated" while the old
             * password - the one being replaced for a reason - still works.
             * Said only once the current one is CONFIRMED (the green tick):
             * before that, matching a wrong guess is not "your current one".
             */
            check={(value) =>
              confirmed && value === current
                ? "Choose a password different from your current one."
                : null
            }
          />
          <PasswordRules value={next} rules={rules} className="-mt-1" />
          <PasswordInput
            id="confirm-password"
            label="Confirm new password"
            autoComplete="new-password"
            value={again}
            onChange={(event) => setAgain(event.target.value)}
            check={(value) => (value === next ? null : "Those passwords do not match.")}
          />
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={others}
              onCheckedChange={(value) => setOthers(value === true)}
            />
            <span>
              Sign out of all other devices
              <span className="block text-xs text-muted-foreground">
                Every device that used your old password will need to sign in again.
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={saving}
              /*
               * ⚠ OFF UNTIL EVERY FIELD IS GREEN (2026-10-12): the current
               * password confirmed with its tick, every rule met, the two new
               * ones matching and different from the current.
               */
              disabled={!ready}
            >
              Save
            </Button>
          </div>
        </form>
      </Reveal>
    </div>
  )
}

// ── Passkeys ─────────────────────────────────────────────────────────────────

/**
 * Clerk's passkeys row: each passkey with when it was made and last used, a
 * menu to rename or remove it, and "+ Add a passkey" - which raises the same
 * passkey screen sign-up shows while the device makes it.
 */
function Passkeys({ user }: { user: UserResource }) {
  const reverify = useReverify()
  const [making, setMaking] = React.useState(false)
  const [renaming, setRenaming] = React.useState<PasskeyResource | null>(null)
  const [name, setName] = React.useState("")
  const [removing, setRemoving] = React.useState<PasskeyResource | null>(null)

  async function add() {
    setMaking(true)
    try {
      const made = await reverify(() => user.createPasskey())
      if (made) toastDone("Passkey added")
    } catch (error) {
      const cancelled = /NotAllowed|cancel|abort/i.test(
        String((error as Error)?.name ?? error),
      )
      if (!cancelled) toastError("Could not add a passkey", clerkReason(error))
    } finally {
      setMaking(false)
    }
  }

  /*
   * ⚠ THE LAST WAY IN STAYS, AND WE SAY WHY BEFORE CLERK DOES (2026-10-12).
   * Clerk refuses to delete a user's last IDENTIFICATION - something you can
   * type or present to sign in: a verified email, phone or username, a
   * connected account, or a passkey. A password is not one; it rides on an
   * identifier, so with only an unverified address it has nothing to attach
   * to. Clerk's own message ("You cannot delete your last identification")
   * names a rule, not a remedy.
   */
  function askToRemove(passkey: PasskeyResource) {
    const others =
      user.emailAddresses.filter((e) => e.verification?.status === "verified").length +
      user.phoneNumbers.filter((p) => p.verification?.status === "verified").length +
      (user.username ? 1 : 0) +
      user.externalAccounts.filter((a) => a.verification?.status === "verified")
        .length +
      user.passkeys.filter((p) => p.id !== passkey.id).length
    if (others === 0) {
      toastError("This passkey is your only way to sign in", {
        description: user.passwordEnabled
          ? "Your password needs a verified email address to sign in with. Verify one under Profile, then remove this passkey."
          : "Verify an email address or connect an account under Profile, then remove this passkey.",
      })
      return
    }
    setRemoving(passkey)
  }

  async function rename(event: React.FormEvent) {
    event.preventDefault()
    if (!renaming) return
    try {
      await renaming.update({ name: name.trim() })
      setRenaming(null)
    } catch (error) {
      toastError("Could not rename that passkey", clerkReason(error))
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <MotionList>
        {user.passkeys.map((passkey) => (
          <MotionItem key={passkey.id}>
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <PasskeyIcon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm">
                    {passkey.name ?? "Passkey"}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Created {shortDate(passkey.createdAt)}
                    {passkey.lastUsedAt
                      ? ` · Last used ${shortDate(passkey.lastUsedAt)}`
                      : ""}
                  </span>
                </span>
              </span>
              <RowMenu visible label={passkey.name ?? "Passkey"}>
                <DropdownMenuItem
                  onSelect={() => {
                    setName(passkey.name ?? "")
                    setRenaming(passkey)
                  }}
                >
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-danger"
                  onSelect={() => askToRemove(passkey)}
                >
                  Remove
                </DropdownMenuItem>
              </RowMenu>
            </div>
            <Reveal show={renaming?.id === passkey.id} spacing="pt-3">
              <form onSubmit={rename} className="flex items-end gap-2">
                <FloatingInput
                  id={`passkey-name-${passkey.id}`}
                  label="Name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  containerClassName="flex-1"
                  autoFocus
                />
                <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!name.trim()}>
                  Save
                </Button>
              </form>
            </Reveal>
          </MotionItem>
        ))}
      </MotionList>
      <div>
        <AddAction onClick={() => void add()} loading={making}>
          Add a passkey
        </AddAction>
      </div>
      <PasskeyCue open={making} mode="create" />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove passkey"
        description={`${removing?.name ?? "This passkey"} will be removed, and you will no longer be able to sign in with it.`}
        confirmLabel="Remove"
        doneLabel="Removed"
        // ⚠ ITS NAME, TYPED (2026-10-13): a sign-in method, removed for good.
        confirmWord={confirmWordFor([removing?.name])}
        onConfirm={async () => {
          if (!removing) return false
          try {
            return (await reverify(() => removing.delete())) !== null
          } catch (error) {
            toastError("Could not remove that passkey", clerkReason(error))
            return false
          }
        }}
      />
    </div>
  )
}

// ── Two-step verification ────────────────────────────────────────────────────

/**
 * Clerk's two-step verification row: the authenticator app (add: scan the QR
 * code or copy the key, enter its code, save the backup codes; remove), and
 * backup codes (regenerate). The add flow is three steps of one card.
 */
function TwoStep({ user }: { user: UserResource }) {
  const reverify = useReverify()
  /*
   * ⚠ THE PASSWORD EDITOR'S SKELETON, LINE FOR LINE (2026-10-12): one line
   * with the state on the left and the action on the right, the action
   * stepping aside while the card is open; the card in a `Reveal` with the
   * same spacing, keyed per open, followed into view by the same hook on
   * `open`. Two-step had grown its own shape - a list that swapped rows as
   * setup finished - and it moved like a different component.
   *
   * ⚠ AND FINISHING CHANGES WORDS, NOT LAYOUT. While the card is open the
   * line still reads as not set up, so verifying cannot reshape the row under
   * the card; when it folds away the line's words change in place.
   */
  const [open, setOpen] = React.useState(false)
  const [round, setRound] = React.useState(0)
  const [removing, setRemoving] = React.useState(false)
  const [regenerated, setRegenerated] = React.useState<string[] | null>(null)
  // The last codes shown, kept through the fold after "I saved them".
  const [shownCodes, setShownCodes] = React.useState<string[] | null>(null)
  if (regenerated && regenerated !== shownCodes) setShownCodes(regenerated)
  const [regenerating, setRegenerating] = React.useState(false)
  /*
   * ⚠ THE LINE CHANGES ONLY ONCE THE CARD HAS FOLDED AWAY (2026-10-12).
   * Measured: the card closes on the same curve as the password editor's,
   * but in the same frame the line above swapped its words, gained a badge
   * and a menu, and the backup codes line opened below - three things moving
   * at once, so the card seemed to vanish while the row reshuffled. Now
   * "I saved them" closes the card exactly as Cancel does, and `folded`
   * (from the Reveal's own end) lets the rest change after.
   */
  const [folded, setFolded] = React.useState(true)
  const follow = useFollowOpen<HTMLDivElement>(open)
  const on = user.totpEnabled && !open && folded

  function start() {
    setRound((n) => n + 1)
    setFolded(false)
    setOpen(true)
  }

  async function regenerate() {
    setRegenerating(true)
    try {
      const made = await reverify(() => user.createBackupCode())
      if (made) setRegenerated(made.codes)
    } catch (error) {
      toastError("Could not make new backup codes", clerkReason(error))
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className={on ? undefined : "text-muted-foreground"}>
            <TextMorph>{on ? "Authenticator app" : "Not set up"}</TextMorph>
          </span>
          {on && (
            <Badge size="sm" tone="info">
              Default
            </Badge>
          )}
        </span>
        {/* Nothing on the right while the card folds: the line changes once, after. */}
        {!open &&
          folded &&
          (on ? (
            <RowMenu visible label="Authenticator app">
              <DropdownMenuItem
                className="text-danger"
                onSelect={() => setRemoving(true)}
              >
                Remove
              </DropdownMenuItem>
            </RowMenu>
          ) : (
            <Button variant="ghost" size="sm" onClick={start}>
              Set up
            </Button>
          ))}
      </div>
      <Reveal show={open} spacing="pt-4" onClosed={() => setFolded(true)}>
        {round > 0 && (
          <AddTotp key={round} ref={follow} user={user} onDone={() => setOpen(false)} />
        )}
      </Reveal>

      {/* Backup codes: a second line, once there are some. */}
      <Reveal show={user.backupCodeEnabled && !open && folded} spacing="pt-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">Backup codes</span>
          <Button
            variant="ghost"
            size="sm"
            loading={regenerating}
            onClick={() => void regenerate()}
          >
            Regenerate
          </Button>
        </div>
        {/*
         * ⚠ THE CARD STAYS WHILE IT FOLDS (2026-10-12). It was drawn only while
         * `regenerated` held codes, and "I saved them" cleared them - so the
         * card was deleted on the click (measured: gone 19ms in) and the fold
         * that followed closed an empty gap. `shownCodes` keeps the last set
         * on screen until the Reveal has closed over it.
         */}
        <Reveal show={regenerated !== null} spacing="pt-4">
          {shownCodes && (
            <BackupCodes
              framed
              email={user.primaryEmailAddress?.emailAddress ?? null}
              codes={shownCodes}
              onDone={() => setRegenerated(null)}
            />
          )}
        </Reveal>
      </Reveal>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove two-step verification"
        // Typed to confirm, with the copy chip, as every delete here asks.
        confirmWord="Delete"
        description="Your account will no longer ask for a code from your authenticator app when you sign in."
        confirmLabel="Remove"
        doneLabel="Removed"
        onConfirm={async () => {
          try {
            return (await reverify(() => user.disableTOTP())) !== null
          } catch (error) {
            toastError("Could not remove two-step verification", clerkReason(error))
            return false
          }
        }}
      />
    </div>
  )
}

/**
 * Clerk's add-authenticator flow: scan or type the key, enter the code, save
 * the backup codes - two steps of one card.
 *
 * ⚠ THE SCAN STEP IS THERE ON THE PRESS (2026-10-12). It used to open on
 * "Preparing a code…" for as long as Clerk took to mint the secret, then
 * swap to the real step and jump in height. Now the step is drawn at once
 * at its final size - the QR's square and the key's chip held by
 * placeholders - and the code and key fade in where they sit when Clerk
 * answers. Nothing moves but the placeholder's shimmer.
 */
function AddTotp({
  user,
  onDone,
  ref,
}: {
  user: UserResource
  onDone: () => void
  /** The parent's follow-into-view ref, as the password form takes it. */
  ref?: React.Ref<HTMLDivElement>
}) {
  const reverify = useReverify()
  const reduced = useReducedMotion() ?? false
  const [totp, setTotp] = React.useState<TOTPResource | null>(null)
  const [codes, setCodes] = React.useState<string[] | null>(null)
  const [code, setCode] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [accepted, setAccepted] = React.useState(false)
  const started = React.useRef(false)
  const keyRow = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (started.current) return
    started.current = true
    void reverify(() => user.createTOTP()).then(
      (made) => (made ? setTotp(made) : onDone()),
      (error: unknown) => {
        toastError("Could not start two-step verification", clerkReason(error))
        onDone()
      },
    )
  }, [reverify, user, onDone])

  async function verify() {
    if (!totp || code.length < OTP_LENGTH || busy) return
    setBusy(true)
    setError(null)
    try {
      const verified = await user.verifyTOTP({ code })
      setAccepted(true)
      window.setTimeout(() => setCodes(verified.backupCodes ?? []), 650)
    } catch (error) {
      setError(clerkReason(error))
    } finally {
      setBusy(false)
    }
  }

  // The secret arriving: a soft fade and focus-pull where the placeholder was.
  const arrive = {
    initial: reduced
      ? { opacity: 0 }
      : { opacity: 0, filter: "blur(6px)", scale: 0.98 },
    animate: { opacity: 1, filter: "blur(0px)", scale: 1 },
    transition: { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const },
  }

  return (
    <div ref={ref} className="scroll-mb-6 rounded-2xl border p-4">
      <StepStage step={codes ? "codes" : "scan"}>
        {!codes ? (
          <form
            noValidate
            className="flex flex-col gap-7"
            onSubmit={(event) => {
              event.preventDefault()
              void verify()
            }}
          >
            <p className="text-sm text-muted-foreground">
              Scan this with your authenticator app, or enter the key by hand. Then type
              the six digits it shows.
            </p>
            <div className="flex flex-col items-center gap-3">
              {/* The QR's own size, so the card is final from the first frame. */}
              <div className="relative size-44">
                <AnimatePresence initial={false}>
                  {totp ? (
                    <motion.div key="qr" className="absolute inset-0" {...arrive}>
                      <QrCode
                        value={totp.uri ?? ""}
                        title="Two-step verification setup code"
                      />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="qr-wait"
                      className="absolute inset-0"
                      exit={{ opacity: 0, transition: { duration: 0.16 } }}
                    >
                      <SkeletonBlock className="size-full rounded-xl" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <div className="flex h-8 items-center gap-1">
                {totp ? (
                  <motion.div
                    ref={keyRow}
                    className="flex items-center gap-1"
                    {...arrive}
                  >
                    {/*
                     * The key copies when it is clicked, through the copy
                     * button beside it, so the same tick answers either way.
                     */}
                    <code
                      onClick={() => keyRow.current?.querySelector("button")?.click()}
                      className="cursor-pointer rounded-pill bg-muted px-3 py-1 font-mono text-xs tracking-wider break-all transition-colors duration-(--duration-fast) hover:bg-accent"
                    >
                      {totp.secret}
                    </code>
                    <CopyButton
                      value={totp.secret ?? ""}
                      label="Copy key"
                      iconOnly
                      variant="plain"
                    />
                  </motion.div>
                ) : (
                  <SkeletonBlock className="h-6 w-64 rounded-pill" />
                )}
              </div>
            </div>
            <OtpField
              value={code}
              onChange={(next) => {
                setError(null)
                setCode(next)
              }}
              onComplete={() => void verify()}
              label="Code from your app"
              state={error ? "invalid" : "idle"}
              hint={error}
              verified={accepted}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onDone}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={busy}
                disabled={!totp || code.length < OTP_LENGTH}
              >
                Verify
              </Button>
            </div>
          </form>
        ) : (
          <BackupCodes
            codes={codes}
            email={user.primaryEmailAddress?.emailAddress ?? null}
            onDone={() => {
              toastDone("Two-step verification is on")
              onDone()
            }}
          />
        )}
      </StepStage>
    </div>
  )
}

/** A tick that draws itself in green, as Arc's copy button confirms. */
function DrawnTick({ reduced }: { reduced: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="text-success"
    >
      <motion.path
        d="M4 12l5 5L20 6"
        initial={reduced ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{
          pathLength: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: 0.05 },
          opacity: { duration: 0.01, delay: 0.05 },
        }}
      />
    </svg>
  )
}

/**
 * Clerk's backup codes step: the codes, copy all, and the one-time warning.
 *
 * ⚠ THE SAME CARD AS EVERY OTHER STEP HERE (2026-10-12): the sentence on
 * top, the content, the actions on the right with the 28px rhythm between
 * them. Inside the setup card it draws no border of its own - that was a
 * card inside a card; regenerated on its own row, it is the card, and
 * follows itself into view as the others do.
 */
function BackupCodes({
  codes,
  email,
  onDone,
  framed = false,
}: {
  codes: string[]
  /** Printed on the PDF, so a saved sheet says whose codes these are. */
  email: string | null
  onDone: () => void
  framed?: boolean
}) {
  const follow = useFollowOpen<HTMLDivElement>(framed)
  const [saved, setSaved] = React.useState<"idle" | "saving" | "saved">("idle")
  const reduced = useReducedMotion() ?? false

  async function save() {
    setSaved("saving")
    try {
      // Loaded on the press: pdf-lib and the fonts are not on the page before.
      const { saveBackupCodesPdf } = await import("@/lib/backup-codes-pdf")
      const outcome = await saveBackupCodesPdf({ codes, email })
      if (outcome === "cancelled") return setSaved("idle")
      setSaved("saved")
      // Back to the button after a beat, as the copy button's tick does.
      window.setTimeout(() => setSaved("idle"), 2400)
    } catch (error) {
      setSaved("idle")
      toastError("Could not save the PDF", clerkReason(error))
    }
  }

  return (
    <div
      ref={framed ? follow : undefined}
      className={framed ? "scroll-mb-6 rounded-2xl border p-4" : undefined}
    >
      <div className="flex flex-col gap-7">
        <p className="text-sm text-muted-foreground">
          Save these somewhere safe. Each signs you in once if you lose your device, and
          this is the only time they are shown.
        </p>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl bg-muted/50 px-4 py-3 font-mono text-sm tabular-nums">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          {/*
           * Loading until the file is actually saved, then the download
           * arrow turns into a green tick, drawn the way the copy button's is.
           */}
          <Button
            variant="secondary"
            loading={saved === "saving"}
            onClick={() => saved === "idle" && void save()}
          >
            {saved === "saved" ? (
              <DrawnTick reduced={reduced} />
            ) : (
              <Download aria-hidden />
            )}
            {saved === "saved" ? "Saved" : "Save as PDF"}
          </Button>
          <CopyButton value={codes.join("\n")} label="Copy all" />
          <Button onClick={onDone}>I saved them</Button>
        </div>
      </div>
    </div>
  )
}

// ── Active devices ───────────────────────────────────────────────────────────

/**
 * Clerk's active devices row: every signed-in session with its browser,
 * device, address and place, "This device" on the current one, and "Sign out
 * of device" on the others.
 */
function Devices({ user }: { user: UserResource }) {
  const { session: current } = useSession()
  const reverify = useReverify()
  const [sessions, setSessions] = React.useState<
    SessionWithActivitiesResource[] | null
  >(null)
  const load = React.useCallback(() => {
    void user.getSessions().then(setSessions, () => setSessions([]))
  }, [user])
  React.useEffect(load, [load])

  async function signOut(session: SessionWithActivitiesResource) {
    try {
      const done = await reverify(() => session.revoke())
      if (done) setSessions((list) => list?.filter((s) => s.id !== session.id) ?? null)
    } catch (error) {
      toastError("Could not sign that device out", clerkReason(error))
    }
  }

  /*
   * ⚠ A SKELETON OF A DEVICE ROW, NOT "LOADING DEVICES…" (2026-10-12): the
   * same picture box and four 20px lines in the same wrappers the real row
   * uses, so the device that arrives takes its place without anything below
   * moving. There is always at least this device.
   */
  if (!sessions)
    return (
      <ul className="flex flex-col" aria-busy="true" aria-label="Loading devices">
        <li>
          <div className="py-1.5">
            <div className="flex items-start gap-4 py-1.5">
              <SkeletonBlock className="mt-1 size-12 shrink-0 rounded-lg" />
              <span className="flex min-w-0 flex-col gap-1">
                {["w-28", "w-36", "w-44", "w-32"].map((width) => (
                  <span key={width} className="flex h-5 items-center">
                    <SkeletonBlock className={`h-3.5 ${width} rounded-md`} />
                  </span>
                ))}
              </span>
            </div>
          </div>
        </li>
      </ul>
    )

  const ordered = [...sessions].sort((a, b) =>
    a.id === current?.id ? -1 : b.id === current?.id ? 1 : 0,
  )
  return (
    <MotionList>
      {ordered.map((session) => {
        const activity = session.latestActivity
        const place = [activity?.city, activity?.country].filter(Boolean).join(", ")
        return (
          <MotionItem key={session.id}>
            {/* Clerk's layout: the device drawn, then four quiet lines. */}
            <div className="flex items-start justify-between gap-3 py-1.5">
              <span className="flex min-w-0 items-start gap-4">
                <DeviceArt mobile={activity?.isMobile === true} />
                <span className="min-w-0 space-y-1 text-sm leading-5">
                  <span className="flex items-center gap-2 font-medium">
                    {activity?.deviceType ||
                      (activity?.isMobile ? "Mobile" : "Computer")}
                    {session.id === current?.id && (
                      <Badge size="sm" tone="success" className="font-normal">
                        This device
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate text-muted-foreground">
                    {[activity?.browserName, activity?.browserVersion]
                      .filter(Boolean)
                      .join(" ")}
                  </span>
                  <span className="block truncate text-muted-foreground">
                    {activity?.ipAddress}
                    {place ? ` (${place})` : ""}
                  </span>
                  <span className="block text-muted-foreground">
                    {whenActive(session.lastActiveAt)}
                  </span>
                </span>
              </span>
              {session.id !== current?.id && (
                <RowMenu visible label={activity?.deviceType ?? "Device"}>
                  <DropdownMenuItem
                    className="text-danger"
                    onSelect={() => void signOut(session)}
                  >
                    Sign out of device
                  </DropdownMenuItem>
                </RowMenu>
              )}
            </div>
          </MotionItem>
        )
      })}
    </MotionList>
  )
}

/** Clerk's "Today at 5:31 PM", "Yesterday at 10:28 PM", "Oct 3 at 2:10 PM". */
function whenActive(date: Date): string {
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  if (days === 0) return `Today at ${time}`
  if (days === 1) return `Yesterday at ${time}`
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`
}

/** Clerk's own device pictures, at the size its panel drew them. */
function DeviceArt({ mobile }: { mobile: boolean }) {
  return mobile ? (
    <DeviceMobileIcon aria-hidden className="mt-0.5 h-10 w-12 shrink-0" />
  ) : (
    <DeviceLaptopIcon aria-hidden className="mt-1 h-12 w-12 shrink-0" />
  )
}

// ── Delete account ───────────────────────────────────────────────────────────

/**
 * Clerk's delete row: "Delete account", confirmed by typing - as Clerk's
 * dialog asked for "Delete account" - and the step-up before it goes.
 *
 * ⚠ SIGNED OUT ONTO THE SIGN-IN PAGE AFTERWARDS, by us rather than by Clerk's
 * panel. The sign-in page then clears this account's saved card - it asks
 * which saved accounts still exist, and this one no longer does.
 */
function DeleteAccount({
  user,
  billing,
}: {
  user: UserResource
  billing: BillingState | null
}) {
  const clerk = useClerk()
  const reverify = useReverify()
  const [open, setOpen] = React.useState(false)
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        Delete your account and all its associated data.
      </p>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        Delete account
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete account"
        description="Your account and everything in it will be deleted. This cannot be undone."
        confirmLabel="Delete account"
        doneLabel="Deleted"
        confirmWord="Delete account"
        onConfirm={async () => {
          try {
            const done = await reverify(() => user.delete())
            if (done === null) return false
            /*
             * ⚠ THE NAVIGATION IS OURS, NOT `signOut`'s (2026-10-13). Deleting
             * the user ends its session, and Clerk's `signOut` opens with
             * `if (!this.client || !this.session) return` - so its
             * `redirectUrl` never fired and the page sat on the dialog until a
             * refresh. Any other signed-in session is still signed out; then
             * a real page load of `/`, which the middleware sends to sign-in.
             */
            await clerk.signOut().catch(() => {})
            window.location.replace("/")
            return true
          } catch (error) {
            toastError("Could not delete your account", clerkReason(error))
            return false
          }
        }}
      >
        {/*
         * ⚠ THE CONSEQUENCES, ONLY WHEN SOMEBODY MEANS TO DELETE (2026-10-12).
         * They sat above the whole account page, a red box over a name and a
         * password; they belong where the decision is made.
         */}
        <DeletionWarning billing={billing} scope="account" />
      </ConfirmDialog>
    </div>
  )
}
