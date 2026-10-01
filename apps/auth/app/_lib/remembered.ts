"use client"

import { useSyncExternalStore } from "react"
import { SAVED_COUNT_COOKIE, SAVED_LIMIT } from "./remembered-cookie"

/**
 * The accounts this device has signed in to, for the cards on the sign-in page
 * (#192).
 *
 * ⚠ OURS, NOT CLERK'S, BECAUSE CLERK'S MULTI-SESSION IS A DIFFERENT THING.
 * Multi-session keeps several ACTIVE sessions on one client; what this shows is
 * accounts that are signed OUT - the session expired or they pressed sign out -
 * which Clerk forgets entirely. There is nothing to ask it for.
 *
 * ⚠ ONLY WHAT THE CARD DRAWS: the address, a display name and the URL of
 * their profile photo. Never a token,
 * a session id or a user id, so this list is worth nothing to anybody who
 * reads it out of the browser except the fact it is honest about - which
 * accounts have used this device. That fact is why each entry can be
 * forgotten on its own.
 *
 * ⚠ `localStorage` ON THE AUTH ORIGIN, unlike the resumable flow state in
 * ./resume.tsx, which is per-tab `sessionStorage`. A remembered account is
 * meant to outlive the tab; a half-finished flow is not.
 */

export interface RememberedAccount {
  email: string
  name: string | null
  /** Their uploaded profile photo, or null for the letter. Older entries lack it. */
  imageUrl?: string | null
  /**
   * How this account last signed in on this device: `password`, `passkey`, or
   * an SSO strategy like `oauth_google`. Decides the card's icon (a provider's
   * logo, or the profile photo) and what pressing the card does.
   */
  method?: string | null
  /**
   * ⚠ THE ACCOUNT THAT SIGNED IN MOST RECENTLY, AND AT MOST ONE ENTRY HAS IT.
   * A flag rather than "the first card", because forgetting the first card
   * must not promote the second to "Last used" - it was not.
   */
  last?: boolean
}

const KEY = "i10_remembered_accounts"
/** Enough to cover a person with a work and a personal account and a spare. */
const LIMIT = SAVED_LIMIT
/** Same-tab writes do not fire `storage`, so this tells our own hook. */
const CHANGED = "i10:remembered-accounts"

interface ClerkUserLike {
  fullName?: string | null
  imageUrl?: string
  hasImage?: boolean
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
  /*
   * ⚠ THE COUNT ALSO GOES IN A COOKIE, AND ONLY THE COUNT. The server cannot
   * read localStorage, so the page it renders had no room for the cards and
   * everything under them jumped down when they appeared after hydration. The
   * sign-in page reads this and renders that many skeleton cards in their
   * place. A number, never an address: the cookie rides along with every
   * request to this origin.
   */
  writeSavedCount(accounts.length)
  window.dispatchEvent(new Event(CHANGED))
}

/**
 * Keep the cookie's count in step with storage. Exported for the one-time
 * sync on a device that saved accounts before the cookie existed.
 */
export function writeSavedCount(count: number): void {
  document.cookie =
    count > 0
      ? `${SAVED_COUNT_COOKIE}=${count}; path=/; max-age=31536000; samesite=lax`
      : `${SAVED_COUNT_COOKIE}=; path=/; max-age=0; samesite=lax`
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
export function rememberSignedInAccount(method: string | null): void {
  const user = (window as { Clerk?: { user?: ClerkUserLike | null } }).Clerk?.user
  const email = user?.primaryEmailAddress?.emailAddress
  if (!email) return
  const all = parse(readRaw())
  const before = all.find(
    (account) => account.email.toLowerCase() === email.toLowerCase(),
  )
  const rest = all
    .filter((account) => account !== before)
    .map((account) => ({ ...account, last: false }))
  save(
    [
      {
        email,
        name: user?.fullName?.trim() || null,
        // ⚠ ONLY A PHOTO THEY UPLOADED. Without one Clerk's `imageUrl` is a
        // generated placeholder, and the letter says more than that does.
        imageUrl: user?.hasImage ? (user.imageUrl ?? null) : null,
        // A resumed flow with no recorded attempt keeps what we knew before.
        method: method ?? before?.method ?? null,
        last: true,
      },
      ...rest,
    ].slice(0, LIMIT),
  )
}

/** "Forget this account": one card, nothing else. */
export function forgetAccount(email: string): void {
  save(parse(readRaw()).filter((account) => account.email !== email))
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
