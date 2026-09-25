"use client"

import * as React from "react"

/**
 * Where somebody is in a sign-in or sign-up, kept so a reload lands them back
 * on the same step.
 *
 * ⚠ `sessionStorage`, NOT THE URL, AND NOT A COOKIE. The URL is the address of
 * the page, not of a step — `?step=passkey` leaked into history, into shared
 * links and into the address bar somebody was reading while they typed. A
 * cookie is shared by every tab, so two sign-ins in two tabs would overwrite
 * each other. `sessionStorage` is exactly one tab's memory: it survives a
 * reload and a round trip to Google or GitHub, and it is gone when the tab is.
 *
 * ⚠ ONLY WHAT WAS TYPED IN THE CLEAR, NEVER A SECRET. Names, the email address
 * and which step it was. Passwords, codes, TOTP secrets and backup codes are
 * never written: storage is readable by any script on the origin, and each of
 * those can be asked for again or re-issued by Clerk. The ATTEMPT itself —
 * the half that makes a code or a password land on something — lives in
 * Clerk's client, which already survives a reload.
 *
 * ⚠ AND IT IS FORGOTTEN ON THE WAY OUT. `leaveFor` in _lib/finish.ts is the one
 * exit every successful flow takes, and it calls `forgetFlow`, so a finished
 * sign-in never comes back as a half-finished one. An abandoned one expires
 * after `STALE_MS`, which is longer than anybody reads an email for and
 * shorter than Clerk keeps an attempt alive.
 */

import { PREFIX, TOUCHED } from "./resume-keys"

const STALE_MS = 30 * 60 * 1000

function stale(): boolean {
  const touched = Number(window.sessionStorage.getItem(TOUCHED) ?? 0)
  return Date.now() - touched > STALE_MS
}

function read<T>(key: string): T | undefined {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key)
    if (raw === null) return undefined
    if (stale()) {
      forgetFlow()
      return undefined
    }
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function write<T>(key: string, value: T, initial: T): void {
  try {
    const storage = window.sessionStorage
    // ⚠ THE STARTING VALUE IS REMOVED, NOT STORED. An untouched form must leave
    // nothing behind, or the next visit would be hidden while it "resumed"
    // nothing — see `HIDE_WHILE_RESUMING` in ./resume-keys.
    if (JSON.stringify(value) === JSON.stringify(initial)) {
      storage.removeItem(PREFIX + key)
      if (
        !Array.from({ length: storage.length }, (_, i) => storage.key(i)).some(
          (k) => k !== TOUCHED && k?.startsWith(PREFIX),
        )
      ) {
        storage.removeItem(TOUCHED)
      }
      return
    }
    storage.setItem(PREFIX + key, JSON.stringify(value))
    storage.setItem(TOUCHED, String(Date.now()))
  } catch {
    // Private mode or a full quota: the flow still works, it just will not
    // survive a reload — which is what it did before this file existed.
  }
}

/** Drops every step of every flow in this tab. */
export function forgetFlow(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i)
      if (key?.startsWith(PREFIX)) keys.push(key)
    }
    for (const key of keys) window.sessionStorage.removeItem(key)
  } catch {
    // Nothing stored, or nothing we can reach.
  }
}

/**
 * Whether stored steps may be read yet.
 *
 * ⚠ FALSE DURING THE SERVER RENDER AND HYDRATION, TRUE AFTER. The server has no
 * `sessionStorage`, so a form that read it in its first render would hydrate
 * different markup from what was sent — React discards the lot and warns.
 */
const Live = React.createContext(false)

const noop = () => () => {}
const isClient = () => true
const isServer = () => false

/**
 * The client half of `ResumeBoundary` — see _components/resume-boundary.tsx.
 *
 * ⚠ IT REMOUNTS ITS CHILDREN ONCE, BEFORE THE FIRST PAINT, AND THAT IS THE
 * MECHANISM. The server render and hydration use every field's starting value;
 * `live` then flips, the keyed wrapper remounts, and each
 * `useResumable` reads storage in its initialiser. Restoring by `setState`
 * instead would change `step` after `StepStage` had mounted, and it would
 * animate the restore as though somebody had pressed Continue.
 *
 * ⚠ PER FLOW, NOT IN THE LAYOUT. The SSO callback and the consent page do their
 * work in mount effects, and remounting those would run the work twice.
 */
export function ResumeRemount({ children }: { children: React.ReactNode }) {
  // ⚠ `useSyncExternalStore` WITH A `false` SERVER SNAPSHOT, the pattern
  // _lib/last-used.ts uses: false for the server render and hydration, true
  // straight after, with no effect setting state to get there.
  const live = React.useSyncExternalStore(noop, isClient, isServer)

  return (
    <Live.Provider value={live}>
      <div key={live ? "live" : "static"} data-resume-boundary="">
        {live && <Unhide />}
        {children}
      </div>
    </Live.Provider>
  )
}

/**
 * Shows the flow again once the restored step is in place.
 *
 * ⚠ A FIRST CHILD, NOT AN EFFECT IN THE BOUNDARY, AND THE ORDER IS THE FIX.
 * React runs layout effects — and focuses `autoFocus` inputs — in tree order,
 * children before their parent. From the boundary this ran AFTER the restored
 * step's input had tried to take focus while still `visibility: hidden`, which
 * browsers refuse — so a reload on the name step left the caret nowhere. As the
 * first child it runs before the inputs that follow it.
 */
function Unhide() {
  React.useLayoutEffect(() => {
    document.documentElement.removeAttribute("data-auth-resuming")
  }, [])
  return null
}

/**
 * `useState`, remembered across a reload of this tab.
 *
 * @param key unique within the auth app; namespaced by flow, like `signin.stage`.
 */
export function useResumable<T>(
  key: string,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const live = React.useContext(Live)
  const [value, setValue] = React.useState<T>(() =>
    live ? (read<T>(key) ?? initial) : initial,
  )

  // ⚠ THE STARTING VALUE IS CAPTURED ONCE. Callers pass literals and props
  // that are stable in practice; re-reading it every render would make a
  // changed prop look like somebody typing.
  const [start] = React.useState(initial)

  React.useEffect(() => {
    if (live) write(key, value, start)
  }, [live, key, value, start])

  return [value, setValue]
}

/** Whether this render may have restored anything — false until live. */
export function useResumeLive(): boolean {
  return React.useContext(Live)
}
