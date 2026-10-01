"use client"

import { X } from "lucide-react"
import { Avatar, AvatarFallback } from "@repo/ui/components/avatar"
import {
  forgetAccount,
  stopRemembering,
  useRememberedAccounts,
} from "../_lib/remembered"

/**
 * The accounts this device has used, as cards above the email box (#192).
 *
 * Pressing one runs the same lookup the email box does, with the address
 * filled in, so it lands on that account's password, passkey or code step.
 *
 * ⚠ THE EMAIL BOX STAYS UNDERNEATH, ALWAYS. The cards are a shortcut, not a
 * gate: "use another account" is simply the field that was already there, and
 * somebody signing in on a friend's laptop never has to dismiss anything to
 * reach it.
 *
 * ⚠ ONE LETTER, NOT A PHOTO. The avatar is the first letter of the name or
 * address. A profile image would have to be stored here and fetched from
 * Clerk's image host on every visit to a signed-out page, which is a request
 * that says who used this device to a third party, for decoration.
 */
export function RememberedAccounts({
  onPick,
  disabled,
}: {
  onPick: (email: string) => void
  disabled?: boolean
}) {
  const accounts = useRememberedAccounts()
  if (accounts.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Accounts used on this device" className="flex flex-col gap-2">
        {accounts.map((account) => (
          <li key={account.email} className="relative">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(account.email)}
              className="flex h-14 w-full items-center gap-3 rounded-2xl border bg-transparent ps-3 pe-12 text-start transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-accent focus-visible:border-ring focus-visible:outline-none disabled:opacity-50 dark:bg-input/25 dark:hover:bg-input/50"
            >
              <Avatar className="size-8">
                <AvatarFallback className="text-xs font-medium">
                  {(account.name ?? account.email).charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="flex min-w-0 flex-col">
                {account.name && (
                  <span className="truncate text-sm font-medium">{account.name}</span>
                )}
                <span
                  className={
                    account.name
                      ? "truncate text-xs text-muted-foreground"
                      : "truncate text-sm"
                  }
                >
                  {account.email}
                </span>
              </span>
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => forgetAccount(account.email)}
              aria-label={`Forget ${account.email} on this device`}
              title="Forget this account"
              className="absolute end-3 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      {/*
       * ⚠ THE OPT-OUT SITS WITH THE LIST, where somebody who minds being
       * remembered is looking at the evidence of it. A setting elsewhere would
       * be one nobody signed out can reach.
       */}
      <button
        type="button"
        onClick={stopRemembering}
        className="self-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Don&apos;t remember accounts on this device
      </button>
    </div>
  )
}
