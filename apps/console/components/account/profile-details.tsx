"use client"

import * as React from "react"
import type {
  EmailAddressResource,
  ExternalAccountResource,
  OAuthStrategy,
  UserResource,
} from "@clerk/shared/types"
import { Mail, TriangleAlert } from "lucide-react"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { VerifiedSeal } from "@repo/ui/components/i10/verified-seal"
import {
  AppleIcon,
  GitHubIcon,
  GoogleIcon,
} from "@repo/ui/components/i10/provider-icons"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { DropdownMenuItem } from "@repo/ui/components/i10/menu"
import { EmailInput } from "@repo/ui/components/i10/email-input"
import { emailProblem } from "@repo/ui/checks"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { OtpField, OTP_LENGTH } from "@repo/ui/components/i10/otp-field"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { StepStage } from "@repo/ui/components/i10/step-stage"
import {
  AddAction,
  useFollowOpen,
  MotionItem,
  MotionList,
  ProfileBlock,
  ProfileRow,
  clerkReason,
} from "@/components/account/shared"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { RowMenu } from "@/components/list/row-menu"
import { PhotoField } from "@/components/photo-field"
import { ResendCode, useCodeSend } from "@repo/ui/components/i10/code-send"
import { useReverify } from "@/lib/step-up"
import { toastDone, toastError } from "@/lib/toast"

/**
 * "Profile details" - the first block of Clerk's `<UserProfile />`: the profile
 * (photo and name), email addresses and connected accounts, ours (2026-10-12).
 *
 * ⚠ EVERY CHANGE GOES THROUGH CLERK'S USER RESOURCE, as the panel's did -
 * `user.update`, `user.createEmailAddress`, `user.createExternalAccount`. The
 * data is still Clerk's; only the drawing is ours.
 */
export function ProfileDetails({
  user,
  providers,
}: {
  user: UserResource
  /** The OAuth strategies this instance has switched on, from its environment. */
  providers: { strategy: string; name: string }[]
}) {
  return (
    <ProfileBlock title="Profile details">
      <ProfileRow label="Profile">
        <ProfileEditor user={user} />
      </ProfileRow>
      <ProfileRow label="Email addresses">
        <Emails user={user} />
      </ProfileRow>
      {providers.length > 0 && (
        <ProfileRow label="Connected accounts">
          <ConnectedAccounts user={user} providers={providers} />
        </ProfileRow>
      )}
    </ProfileBlock>
  )
}

// ── Profile ──────────────────────────────────────────────────────────────────

/**
 * Clerk's profile row: the avatar and name, and "Update profile" opening the
 * form in place - photo upload and remove, first and last name.
 */
function ProfileEditor({ user }: { user: UserResource }) {
  const [open, setOpen] = React.useState(false)
  const [first, setFirst] = React.useState(user.firstName ?? "")
  const [last, setLast] = React.useState(user.lastName ?? "")
  const [saving, setSaving] = React.useState(false)
  const follow = useFollowOpen<HTMLFormElement>(open)
  const name = user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "You"

  function begin() {
    setFirst(user.firstName ?? "")
    setLast(user.lastName ?? "")
    setOpen(true)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      await user.update({ firstName: first.trim(), lastName: last.trim() })
      toastDone("Profile updated")
      setOpen(false)
    } catch (error) {
      toastError("Could not update your profile", clerkReason(error))
    } finally {
      setSaving(false)
    }
  }

  async function upload(chosen: File) {
    try {
      await user.setProfileImage({ file: chosen })
      toastDone("Photo updated")
      // A saved photo is a finished edit, as a saved name is: the card closes.
      setOpen(false)
    } catch (error) {
      toastError("Could not upload that photo", clerkReason(error))
      throw error
    }
  }

  async function removePhoto() {
    try {
      await user.setProfileImage({ file: null })
    } catch (error) {
      toastError("Could not remove the photo", clerkReason(error))
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <Avatar
            name={name}
            src={user.hasImage ? user.imageUrl : undefined}
            size="lg"
          />
          <span className="truncate text-sm font-medium">{name}</span>
        </span>
        {!open && (
          <Button variant="ghost" size="sm" onClick={begin}>
            Update profile
          </Button>
        )}
      </div>

      {/* ⚠ IN PLACE, AS CLERK'S DID - the row opens into its own form. */}
      <Reveal show={open} spacing="pt-5">
        <form ref={follow} onSubmit={save} className="scroll-mb-6 rounded-2xl border">
          {/*
           * ⚠ THE WHOLE CARD IS THE DROP ZONE (2026-10-12): drop an image
           * anywhere on it, crop, zoom and turn it, and the square it shows is
           * what Clerk's `setProfileImage` receives. The photo saves on its
           * own, so it never wakes the Save button - that is for the name.
           */}
          <PhotoField
            name={name}
            src={user.hasImage ? user.imageUrl : undefined}
            onUpload={upload}
            onRemove={removePhoto}
            className="flex flex-col gap-7 p-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FloatingInput
                id="profile-first-name"
                label="First name"
                value={first}
                onChange={(event) => setFirst(event.target.value)}
                autoComplete="given-name"
              />
              <FloatingInput
                id="profile-last-name"
                label="Last name"
                value={last}
                onChange={(event) => setLast(event.target.value)}
                autoComplete="family-name"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={saving}
                // Only a changed name wakes it; the photo saves on its own.
                disabled={
                  !first.trim() ||
                  (first.trim() === (user.firstName ?? "") &&
                    last.trim() === (user.lastName ?? ""))
                }
              >
                Save
              </Button>
            </div>
          </PhotoField>
        </form>
      </Reveal>
    </div>
  )
}

// ── Email addresses ──────────────────────────────────────────────────────────

/**
 * Clerk's email addresses row: each address with "Primary" or "Unverified",
 * a menu to set it as primary, verify it or remove it, and "+ Add email
 * address" opening the add-then-verify form in place.
 */
function Emails({ user }: { user: UserResource }) {
  const reverify = useReverify()
  const [adding, setAdding] = React.useState(false)
  const [verifying, setVerifying] = React.useState<EmailAddressResource | null>(null)
  const [removing, setRemoving] = React.useState<EmailAddressResource | null>(null)
  // What the dialog shows while it closes, after `removing` is cleared.
  const [shown, setShown] = React.useState<EmailAddressResource | null>(null)
  const primaryId = user.primaryEmailAddressId

  const emails = [...user.emailAddresses].sort((a, b) =>
    a.id === primaryId ? -1 : b.id === primaryId ? 1 : 0,
  )

  /** Another verified address that can take over as primary, if any. */
  const successor = (email: EmailAddressResource) =>
    emails.find(
      (other) => other.id !== email.id && other.verification?.status === "verified",
    )

  /*
   * ⚠ ANY ADDRESS CAN GO WHEN THERE IS ANOTHER (2026-10-12). Clerk refuses to
   * remove a primary, so the next verified address is made primary first.
   * When there is no other verified one, Remove says so instead of removing:
   * verify another address first. An account is never left with no verified
   * address to sign in with.
   */
  const removable = emails.length > 1

  function askToRemove(email: EmailAddressResource) {
    if (email.id === primaryId && successor(email) === undefined) {
      toastError("Verify another address first", {
        description: `${email.emailAddress} is your only verified address. Verify another one, and it becomes your primary when you remove this.`,
      })
      return
    }
    setShown(email)
    setRemoving(email)
  }

  async function makePrimary(email: EmailAddressResource) {
    try {
      const done = await reverify(() =>
        user.update({ primaryEmailAddressId: email.id }),
      )
      if (done) toastDone(`${email.emailAddress} is now your primary address`)
    } catch (error) {
      toastError("Could not change your primary address", clerkReason(error))
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <MotionList>
        {emails.map((email) => {
          const verified = email.verification?.status === "verified"
          return (
            <MotionItem key={email.id}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  {/* Clerk's envelope before each address. */}
                  <Mail aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm">{email.emailAddress}</span>
                  {verified && <VerifiedSeal />}
                  {/* Green, as Clerk's "Primary" was. */}
                  {email.id === primaryId && (
                    <Badge size="sm" tone="success">
                      Primary
                    </Badge>
                  )}
                  {!verified && (
                    <Badge
                      size="sm"
                      tone="warning"
                      icon={<TriangleAlert aria-hidden />}
                    >
                      Unverified
                    </Badge>
                  )}
                </span>
                <RowMenu visible label={email.emailAddress}>
                  {verified && email.id !== primaryId && (
                    <DropdownMenuItem onSelect={() => void makePrimary(email)}>
                      Set as primary
                    </DropdownMenuItem>
                  )}
                  {!verified && (
                    <DropdownMenuItem
                      onSelect={() => {
                        setVerifying(email)
                        setAdding(true)
                      }}
                    >
                      Complete verification
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-danger"
                    disabled={!removable}
                    onSelect={() => askToRemove(email)}
                  >
                    Remove
                  </DropdownMenuItem>
                </RowMenu>
              </div>
            </MotionItem>
          )
        })}
      </MotionList>

      <Reveal show={adding} spacing="pt-3">
        <AddEmail
          user={user}
          resume={verifying}
          onDone={() => {
            setAdding(false)
            setVerifying(null)
          }}
        />
      </Reveal>
      {!adding && (
        <div>
          <AddAction onClick={() => setAdding(true)}>Add email address</AddAction>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove email address"
        // Typed to confirm, with the copy chip, as every delete here asks.
        confirmWord={shown?.emailAddress}
        description={
          shown && shown.id === primaryId
            ? `${shown.emailAddress} will be removed, and ${successor(shown)?.emailAddress ?? "another address"} becomes your primary address.`
            : `${shown?.emailAddress ?? "This address"} will be removed from your account, and you will no longer be able to sign in with it.`
        }
        confirmLabel="Remove"
        doneLabel="Removed"
        onConfirm={async () => {
          if (!removing) return false
          try {
            const next = removing.id === primaryId ? successor(removing) : undefined
            const done = await reverify(async () => {
              if (next) await user.update({ primaryEmailAddressId: next.id })
              return removing.destroy()
            })
            return done !== null
          } catch (error) {
            toastError("Could not remove that address", clerkReason(error))
            return false
          }
        }}
      />
    </div>
  )
}

/**
 * Clerk's add-email form: the address, then the six-digit code sent to it, as
 * two steps of one card - the second slides in where the first was.
 */
function AddEmail({
  user,
  resume,
  onDone,
}: {
  user: UserResource
  /** An existing unverified address to verify, rather than a new one. */
  resume: EmailAddressResource | null
  onDone: () => void
}) {
  const reverify = useReverify()
  const [address, setAddress] = React.useState("")
  const [pending, setPending] = React.useState<EmailAddressResource | null>(null)
  const [code, setCode] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [accepted, setAccepted] = React.useState(false)
  // Mounted as it opens: follow it into view.
  const follow = useFollowOpen<HTMLDivElement>(true)

  // Resuming an unverified address goes straight to its code.
  const [resumed, setResumed] = React.useState<string | null>(null)
  if (resume && resume.id !== resumed) {
    setResumed(resume.id)
    setPending(resume)
    setCode("")
    setError(null)
  }
  /*
   * ⚠ ONE CODE A MINUTE PER ADDRESS, HELD BY THE API (2026-10-12). "Complete
   * verification" sends one as it opens, "Add" sends one with the new
   * address, and "Send a new code" stays greyed with the seconds left until
   * the minute is up. Reopening inside it sends nothing. See lib/code-send.tsx.
   */
  const codes = useCodeSend(pending ? `email:${pending.id}` : null)
  const sendRef = React.useRef(codes.send)
  React.useEffect(() => {
    sendRef.current = codes.send
  })
  React.useEffect(() => {
    if (!resume) return
    void sendRef
      .current(
        () => resume.prepareVerification({ strategy: "email_code" }),
        `email:${resume.id}`,
      )
      .catch((error: unknown) => setError(clerkReason(error)))
  }, [resume])

  function reset() {
    setJustAdded(null)
    setAddress("")
    setPending(null)
    setCode("")
    setError(null)
    setAccepted(false)
    onDone()
  }

  /*
   * ⚠ THE SHARED EMAIL CHECK, THEN ONE MORE RULE (2026-10-14): an address
   * already on the account, verified or not, is refused here rather than by
   * Clerk after a round trip. Add stays off until the address passes both.
   */
  /*
   * ⚠ LESS THE ADDRESS THIS FORM JUST ADDED. Clerk puts it on the account the
   * moment Add is pressed, while this step is still on screen sending its
   * code - so without this the address the person just added was refused
   * under the field as already being theirs.
   */
  const [justAdded, setJustAdded] = React.useState<string | null>(null)
  const onAccount = new Set(
    user.emailAddresses
      .map((e) => e.emailAddress.toLowerCase())
      .filter((e) => e !== justAdded),
  )
  const addressProblem = (value: string) =>
    emailProblem(value) ??
    (onAccount.has(value.trim().toLowerCase())
      ? "That address is already on your account."
      : null)
  const addressOk = address.trim() !== "" && addressProblem(address) === null

  async function add(event: React.FormEvent) {
    event.preventDefault()
    if (!addressOk) return
    setBusy(true)
    setError(null)
    try {
      const created = await reverify(() =>
        user.createEmailAddress({ email: address.trim() }),
      )
      if (!created) return
      setJustAdded(created.emailAddress.toLowerCase())
      await codes.send(
        () => created.prepareVerification({ strategy: "email_code" }),
        `email:${created.id}`,
      )
      setPending(created)
    } catch (error) {
      setError(clerkReason(error))
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    if (!pending || code.length < OTP_LENGTH) return
    setBusy(true)
    setError(null)
    try {
      await pending.attemptVerification({ code })
      setAccepted(true)
      // Long enough to see the boxes turn green, as on sign-in.
      window.setTimeout(() => {
        toastDone(`${pending.emailAddress} ${resume ? "verified" : "added"}`)
        reset()
      }, 650)
    } catch (error) {
      setError(clerkReason(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={follow} className="scroll-mb-6 rounded-2xl border p-4">
      <StepStage step={pending ? "code" : "address"}>
        {pending ? (
          <form
            noValidate
            className="flex flex-col gap-7"
            onSubmit={(event) => {
              event.preventDefault()
              void verify()
            }}
          >
            <p className="text-sm text-muted-foreground">
              Enter the code we sent to{" "}
              <span className="text-foreground">{pending.emailAddress}</span>.
            </p>
            <OtpField
              value={code}
              onChange={(next) => {
                setError(null)
                setCode(next)
              }}
              onComplete={() => void verify()}
              state={error ? "invalid" : "idle"}
              hint={error}
              verified={accepted}
              autoFocus
            />
            <div className="flex justify-between gap-2">
              <ResendCode
                remaining={codes.remaining}
                sending={codes.sending}
                onClick={() =>
                  void codes
                    .send(() => pending.prepareVerification({ strategy: "email_code" }))
                    .then(
                      (sent) => sent && toastDone("We sent another code"),
                      (error: unknown) =>
                        toastError("Could not send a new code", clerkReason(error)),
                    )
                }
              />
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={reset}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  loading={busy}
                  disabled={code.length < OTP_LENGTH}
                >
                  Verify
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <form noValidate onSubmit={add} className="flex flex-col gap-7">
            <p className="text-sm text-muted-foreground">
              You will need to verify this address before you can use it.
            </p>
            <EmailInput
              id="add-email"
              label="Email address"
              value={address}
              onChange={(event) => {
                setError(null)
                setAddress(event.target.value)
              }}
              refused={error ?? undefined}
              check={addressProblem}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={reset}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={!addressOk}>
                Add
              </Button>
            </div>
          </form>
        )}
      </StepStage>
    </div>
  )
}

// ── Connected accounts ───────────────────────────────────────────────────────

const PROVIDER_ICONS: Record<
  string,
  React.ComponentType<React.ComponentProps<"svg">>
> = {
  oauth_google: GoogleIcon,
  oauth_github: GitHubIcon,
  oauth_apple: AppleIcon,
}

/**
 * Clerk's connected accounts row, one line per provider this instance offers:
 * its mark and name; the linked account's address once connected; and the
 * state Clerk showed - connected (a menu to remove it), disconnected (an
 * account that was linked and whose link has lapsed: "Reconnect"), or not
 * connected ("Connect").
 *
 * ⚠ CONNECTING LEAVES THE PAGE, AS CLERK'S DID. The provider's consent screen
 * is a redirect; Clerk brings the browser back here with the account linked.
 */
function ConnectedAccounts({
  user,
  providers,
}: {
  user: UserResource
  providers: { strategy: string; name: string }[]
}) {
  const reverify = useReverify()
  const [leaving, setLeaving] = React.useState<string | null>(null)
  const [removing, setRemoving] = React.useState<{
    account: ExternalAccountResource
    name: string
  } | null>(null)
  const back = () => `${window.location.origin}/account`

  async function go(url: URL | null | undefined, strategy: string) {
    if (url) {
      window.location.assign(url.toString())
      return
    }
    setLeaving((now) => (now === strategy ? null : now))
  }

  async function connect(strategy: string) {
    setLeaving(strategy)
    try {
      const account = await reverify(() =>
        user.createExternalAccount({
          strategy: strategy as OAuthStrategy,
          redirectUrl: back(),
        }),
      )
      await go(account?.verification?.externalVerificationRedirectURL, strategy)
    } catch (error) {
      toastError("Could not connect that account", clerkReason(error))
      setLeaving(null)
    }
  }

  async function reconnect(account: ExternalAccountResource, strategy: string) {
    setLeaving(strategy)
    try {
      const again = await reverify(() => account.reauthorize({ redirectUrl: back() }))
      await go(again?.verification?.externalVerificationRedirectURL, strategy)
    } catch (error) {
      toastError("Could not reconnect that account", clerkReason(error))
      setLeaving(null)
    }
  }

  return (
    <div className="flex flex-col">
      <MotionList>
        {providers.map((provider) => {
          const found = user.externalAccounts.find(
            (candidate) => `oauth_${candidate.provider}` === provider.strategy,
          )
          const status = found?.verification?.status
          /*
           * ⚠ "DISCONNECTED" ONLY FOR A LINK THAT WAS REALLY MADE AND HAS SINCE
           * LAPSED (2026-10-12). Pressing Connect creates the link before the
           * redirect, and one that never finished - backed out of, refused -
           * stays behind expired or failed. It used to read as "Disconnected",
           * over a second line saying "Connected" because it had no address to
           * show. What tells the two apart is what the provider handed over: a
           * link that was made carries the provider's own id for the person
           * (and usually their address); an attempt that never finished has
           * neither. That reads as not connected, and Connect resumes it.
           */
          const made = Boolean(found?.providerUserId || found?.emailAddress)
          const lapsed = found !== undefined && status !== "verified" && made
          const account = found && (status === "verified" || lapsed) ? found : undefined
          const Icon = PROVIDER_ICONS[provider.strategy]
          return (
            <MotionItem key={provider.strategy}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border">
                    {Icon ? <Icon className="size-4" aria-hidden /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm">
                      {provider.name}
                      {lapsed && (
                        <Badge size="sm" tone="warning">
                          Disconnected
                        </Badge>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {account
                        ? account.emailAddress ||
                          account.username ||
                          (lapsed ? "Needs reconnecting" : "Connected")
                        : "Not connected"}
                    </span>
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  {!account ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={leaving === provider.strategy}
                      disabled={leaving !== null}
                      // An unfinished earlier attempt is resumed, not duplicated.
                      onClick={() =>
                        void (found
                          ? reconnect(found, provider.strategy)
                          : connect(provider.strategy))
                      }
                    >
                      Connect
                    </Button>
                  ) : lapsed ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={leaving === provider.strategy}
                      disabled={leaving !== null}
                      onClick={() => void reconnect(account, provider.strategy)}
                    >
                      Reconnect
                    </Button>
                  ) : null}
                  {account && (
                    <RowMenu visible label={provider.name}>
                      <DropdownMenuItem
                        className="text-danger"
                        onSelect={() => setRemoving({ account, name: provider.name })}
                      >
                        Remove
                      </DropdownMenuItem>
                    </RowMenu>
                  )}
                </span>
              </div>
            </MotionItem>
          )
        })}
      </MotionList>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? "connected account"}`}
        description={`${removing?.name ?? "This account"} will be removed, and you will no longer be able to sign in with it.`}
        confirmLabel="Remove"
        doneLabel="Removed"
        onConfirm={async () => {
          if (!removing) return false
          try {
            return (await reverify(() => removing.account.destroy())) !== null
          } catch (error) {
            toastError("Could not remove that account", clerkReason(error))
            return false
          }
        }}
      />
    </div>
  )
}
