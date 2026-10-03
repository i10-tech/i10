"use client"

import { useEffect, useSyncExternalStore } from "react"
import { ArrowRight, X } from "lucide-react"
import { Skeleton } from "@repo/ui/components/skeleton"
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar"
import {
  forgetAccount,
  useRememberedAccounts,
  writeSavedCount,
  type RememberedAccount,
} from "../_lib/remembered"
import { LastUsedBadge } from "./last-used-badge"
import { LOCAL_ICONS } from "./oauth-buttons"

/**
 * The accounts this device has used, as cards above the email box (#192).
 *
 * Pressing one continues the way that account last signed in: an SSO account
 * starts that provider, anything else runs the email lookup with the address
 * filled in and lands on its password, passkey or code step.
 *
 * ⚠ THE EMAIL BOX STAYS UNDERNEATH, ALWAYS. The cards are a shortcut, not a
 * gate: "use another account" is simply the field that was already there.
 *
 * ⚠ THE ICON SAYS HOW THEY GET IN. An account that signs in with Google shows
 * Google's logo, because pressing it goes to Google; one that signs in with a
 * password or passkey shows their photo, or their initial without one.
 *
 * ⚠ AN ARROW AT REST, THE × ONLY ON HOVER OR FOCUS, SLIDING OUT BESIDE THE
 * CARD rather than inside it. A visible × on every card
 * puts "forget" one slip away from "continue" for the common case, and makes
 * a list of shortcuts look like a list of things to dismiss. The arrow says
 * the card is the action; the × is there for whoever goes looking for it.
 */
export function RememberedAccounts({
  onPick,
  disabled,
  expected = 0,
}: {
  onPick: (account: RememberedAccount) => void
  disabled?: boolean
  /**
   * How many cards the server was told to expect (a cookie - see
   * _lib/remembered-cookie.ts). Rendered as skeletons until the real list is
   * readable, so nothing below moves when the cards arrive.
   */
  expected?: number
}) {
  const accounts = useRememberedAccounts()
  const hydrated = useSyncExternalStore(noop, isClient, isServer)

  // A device that saved accounts before the cookie existed gets it now.
  useEffect(() => {
    if (hydrated && accounts.length !== expected) writeSavedCount(accounts.length)
  }, [hydrated, accounts.length, expected])

  /*
   * ⚠ SKELETONS UNTIL HYDRATION, AT THE CARDS' EXACT HEIGHT. The list lives
   * in localStorage, which neither the server nor the hydrating render can
   * read; without these the page painted, then the cards pushed the email box
   * and everything under it down by 64px each.
   */
  if (!hydrated) {
    if (expected === 0) return null
    return (
      <div aria-hidden="true" className="flex flex-col gap-2">
        {Array.from({ length: expected }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-2xl" />
        ))}
      </div>
    )
  }

  if (accounts.length === 0) return null

  return (
    <ul aria-label="Accounts used on this device" className="flex flex-col gap-2">
      {accounts.map((account) => (
        <li key={account.email} className="group relative">
          <div className="flex h-14 items-center rounded-2xl border transition-colors duration-(--duration-instant) ease-(--ease-linear) focus-within:border-ring hover:bg-accent">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(account)}
              aria-label={`Continue as ${account.email}`}
              className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-2xl ps-4 pe-4 text-start outline-none disabled:opacity-50"
            >
              <AccountIcon account={account} />
              <span className="min-w-0 truncate text-sm">{account.email}</span>
              {account.last && <LastUsedBadge className="ms-auto" />}
              <ArrowRight
                aria-hidden="true"
                className={`size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground ${account.last ? "" : "ms-auto"}`}
              />
            </button>
            {/*
             * Phones: no hover and no room beside the card, so the × opens a
             * slot inside it instead (focus or tap-hold reveals it).
             */}
            <div className="w-0 shrink-0 overflow-hidden transition-[width] duration-(--duration-dismiss) ease-(--ease-quint-out) group-focus-within:w-11 sm:hidden">
              <ForgetButton account={account} disabled={disabled} />
            </div>
          </div>
          {/*
           * ⚠ OUTSIDE THE CARD, SLIDING OUT FROM ITS EDGE (sm and up). The card
           * keeps its full width and its arrow never moves; the × is a
           * separate thing you reach for, not part of the option.
           *
           * ⚠ THE WRAPPER STARTS FLUSH WITH THE CARD AND PADS THE GAP, so the
           * pointer crossing the 8px between them never leaves the `li` and
           * the × does not vanish on the way to it.
           */}
          <div className="pointer-events-none absolute inset-y-0 left-full hidden items-center ps-2 opacity-0 transition-[opacity,translate] duration-(--duration-dismiss) ease-(--ease-quint-out) -translate-x-2 group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 sm:flex">
            <ForgetButton account={account} disabled={disabled} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function ForgetButton({
  account,
  disabled,
}: {
  account: RememberedAccount
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => forgetAccount(account.email)}
      aria-label={`Forget ${account.email} on this device`}
      title="Forget this account"
      className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
    >
      <X aria-hidden="true" className="size-4" />
    </button>
  )
}

function AccountIcon({ account }: { account: RememberedAccount }) {
  const Provider = account.method ? LOCAL_ICONS[account.method] : undefined
  if (Provider) {
    return (
      <span className="grid size-8 shrink-0 place-items-center">
        <Provider aria-hidden="true" className="size-5" />
      </span>
    )
  }
  return (
    <Avatar className="size-8 shrink-0">
      {account.imageUrl && <AvatarImage src={account.imageUrl} alt="" />}
      <AvatarFallback className="text-xs font-medium">
        {(account.name ?? account.email).charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
}

const noop = () => () => {}
const isClient = () => true
const isServer = () => false
