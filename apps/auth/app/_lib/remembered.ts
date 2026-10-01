"use client"

import { useSyncExternalStore } from "react"

/**
 * The accounts this device has signed in to, for the cards on the sign-in page
 * (#192).
 *
 * ⚠ OURS, NOT CLERK'S, BECAUSE CLERK'S MULTI-SESSION IS A DIFFERENT THING.
 * Multi-session keeps several ACTIVE sessions on one client; what this shows is
 * accounts that are signed OUT - the session expired or they pressed sign out -
 * which Clerk forgets entirely. There is nothing to ask it for.
 *
 * ⚠ ONLY WHAT THE CARD DRAWS: the address and a display name. Never a token,
 * a session id or a user id, so this list is worth nothing to anybody who
 * reads it out of the browser except the fact it is honest about - which
 * accounts have used this device. That fact is why it can be switched off
 * (`stopRemembering`) and each entry forgotten on its own.
 *
 * ⚠ `localStorage` ON THE AUTH ORIGIN, unlike the resumable flow state in
 * ./resume.tsx, which is per-tab `sessionStorage`. A remembered account is
 * meant to outlive the tab; a half-finished flow is not.
 */

export interface RememberedAccount {
  email: string
  name: string | null
}

const KEY = "i10_remembered_accounts"
const OFF = "i10_remember_accounts_off"
/** Enough to cover a person with a work and a personal account and a spare. */
const LIMIT = 4
/** Same-tab writes do not fire `storage`, so this tells our own hook. */
const CHANGED = "i10:remembered-accounts"

interface ClerkUserLike {
  fullName?: string | null
  primaryEmailAddress?: { emailAddress: string } | null
}

function readRaw(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "[]"
  } catch {
    return "[]"
  }
}

function parse(raw: string): RememberedAccount[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is RememberedAccount =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as RememberedAccount).email === "string",
    )
  } catch {
    return []
  }
}

function save(accounts: RememberedAccount[]): void {
  try {
    if (accounts.length === 0) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, JSON.stringify(accounts))
  } catch {
    // Storage is blocked: the cards are a convenience, the sign-in is not.
  }
  window.dispatchEvent(new Event(CHANGED))
}

function off(): boolean {
  try {
    return window.localStorage.getItem(OFF) === "1"
  } catch {
    return true
  }
}

/**
 * Put whoever just signed in at the top of the list.
 *
 * ⚠ CALLED FROM `leaveFor`, the one exit every successful flow takes, for the
 * same reason the "last used" badge is promoted there: a sixth flow added
 * later cannot forget to call it. By then `finalize` has made the session, so
 * clerk-js has the user loaded and the address is read from it rather than
 * from whatever was typed - which, after an SSO round trip, was nothing.
 */
export function rememberSignedInAccount(): void {
  if (off()) return
  const user = (window as { Clerk?: { user?: ClerkUserLike | null } }).Clerk?.user
  const email = user?.primaryEmailAddress?.emailAddress
  if (!email) return
  const rest = parse(readRaw()).filter(
    (account) => account.email.toLowerCase() !== email.toLowerCase(),
  )
  save([{ email, name: user?.fullName?.trim() || null }, ...rest].slice(0, LIMIT))
}

/** "Forget this account": one card, nothing else. */
export function forgetAccount(email: string): void {
  save(parse(readRaw()).filter((account) => account.email !== email))
}

/** The opt-out: forget every account and stop remembering new ones. */
export function stopRemembering(): void {
  try {
    window.localStorage.setItem(OFF, "1")
  } catch {
    // Nothing stored means nothing to show, which is the point anyway.
  }
  save([])
}

/*
 * ⚠ THE SNAPSHOT IS CACHED BY ITS RAW STRING. `useSyncExternalStore` compares
 * snapshots with `Object.is`, and parsing on every call returns a new array
 * each time, which React reads as the store changing on every render - an
 * infinite loop, not a slow one.
 */
let cachedRaw: string | null = null
let cached: RememberedAccount[] = []

function snapshot(): RememberedAccount[] {
  const raw = readRaw()
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cached = parse(raw)
  }
  return cached
}

const EMPTY: RememberedAccount[] = []

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange)
  window.addEventListener(CHANGED, onChange)
  return () => {
    window.removeEventListener("storage", onChange)
    window.removeEventListener(CHANGED, onChange)
  }
}

/**
 * The remembered accounts, most recent first.
 *
 * ⚠ EMPTY ON THE SERVER AND DURING HYDRATION, then the real list. Reading
 * `localStorage` while rendering would draw the cards in the browser and not on
 * the server, which React reports as a mismatch and fixes by throwing the
 * markup away - see the same pattern in ./last-used.ts.
 */
export function useRememberedAccounts(): RememberedAccount[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}
