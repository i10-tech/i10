"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ArrowRight, X } from "lucide-react"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { SkeletonBlock as Skeleton } from "@repo/ui/components/i10/skeleton-block"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { goneAccounts } from "../_lib/devices"
import {
  dropAccounts,
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
  const reduce = useReducedMotion() ?? false
  // Whether this visit has shown any cards: the list stays mounted after the
  // last one is forgotten, so that one can leave as the others do.
  const [listed, setListed] = useState(false)
  if (hydrated && accounts.length > 0 && !listed) setListed(true)

  /*
   * ⚠ A CARD FOR A DELETED ACCOUNT GOES UP IN SMOKE (2026-10-12). Deleting
   * an account signs its owner out onto this page - where its card was still
   * waiting. The page asks once which saved accounts still exist (only ones
   * this browser holds a secret for; see /api/devices/check), lets the card
   * be seen for a moment, so the change is something that happens rather than
   * something missing, then dissolves it: it drains of colour, blurs and
   * rises away, and the cards below close the gap.
   */
  const [vanishing, setVanishing] = useState<ReadonlySet<string>>(() => new Set())
  const checked = useRef(false)
  useEffect(() => {
    if (!listed || checked.current) return
    checked.current = true
    const shown = performance.now()
    let alive = true
    let timer = 0
    void goneAccounts().then((gone) => {
      if (!alive || gone.length === 0) return
      const wait = Math.max(0, SEEN_FOR_MS - (performance.now() - shown))
      timer = window.setTimeout(() => {
        setVanishing(new Set(gone.map((email) => email.toLowerCase())))
        dropAccounts(gone)
      }, wait)
    })
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [listed])

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

  if (!listed) return null

  /*
   * ⚠ A FORGOTTEN ACCOUNT FOLDS AWAY, AND THE PAGE FOLLOWS IT (2026-10-12).
   * It used to vanish in one frame, and the email box and everything under it
   * jumped up by a card - or, for the last one, by a card and the gap. Now
   * each card's height, its 8px below and (for the last) the group's gap
   * collapse on Arc's panel spring while it fades, so the box glides up.
   *
   * ⚠ WHICH IS WHY THE GAPS ARE PADDING, NOT `gap`. A flex gap belongs to no
   * child, so it cannot shrink with one: each card carries its own 8px, the
   * spacer after the list carries the rest of the group's gap, and the
   * negative margin hands the group's own gap back so the sum is unchanged.
   */
  const panel = { ...motionTokens.spring.smooth }
  const fade = {
    duration: motionTokens.duration.standard,
    ease: [...motionTokens.ease.enter] as [number, number, number, number],
  }
  const blur = `blur(${motionTokens.blur.subtle}px)`

  return (
    <div className="-mb-7">
      <ul aria-label="Accounts used on this device" className="flex flex-col">
        <AnimatePresence initial={!reduce} custom={vanishing}>
          {accounts.map((account) => (
            <motion.li
              key={account.email}
              // ⚠ NOT CLIPPED: a card is all but transparent by the time its
              // row closes, and a clip would cut the smoke off as it rises.
              className="group relative pb-2"
              // ⚠ IN FROM ITS SKELETON: the same box, so only the content fades.
              initial={{ opacity: 0, filter: blur }}
              animate={{
                opacity: 1,
                filter: "blur(0px)",
                height: "auto",
                transitionEnd: { filter: "none" },
              }}
              variants={{
                exit: (gone: ReadonlySet<string>) =>
                  reduce
                    ? { opacity: 0, height: 0, transition: { duration: 0 } }
                    : gone.has(account.email.toLowerCase())
                      ? SMOKE
                      : {
                          opacity: 0,
                          height: 0,
                          filter: blur,
                          transition: {
                            height: panel,
                            opacity: {
                              duration: motionTokens.duration.fast,
                              ease: STANDARD,
                            },
                            filter: { duration: motionTokens.duration.fast },
                          },
                        },
              }}
              exit="exit"
              transition={
                reduce
                  ? { duration: 0 }
                  : { opacity: fade, filter: fade, height: panel }
              }
            >
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
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <motion.div
        aria-hidden
        initial={false}
        animate={{ height: accounts.length > 0 ? 20 : 0 }}
        transition={reduce ? { duration: 0 } : panel}
      />
    </div>
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
    <Avatar
      name={account.name ?? account.email}
      src={account.imageUrl || undefined}
      size="sm"
      className="shrink-0"
    />
  )
}

/** How long a deleted account's card is seen before it goes. */
const SEEN_FOR_MS = 900

const STANDARD = [...motionTokens.ease.standard] as [number, number, number, number]
const ENTER = [...motionTokens.ease.enter] as [number, number, number, number]
const DRIFT = [0.4, 0, 0.2, 1] as [number, number, number, number]

/**
 * Smoke: the card drains of colour, blurs and rises as it fades, and only
 * once it is mostly gone does its row close - so it vanishes in place first,
 * then the page closes over where it was.
 */
const SMOKE = {
  opacity: 0,
  y: -10,
  scale: 1.03,
  filter: "grayscale(1) blur(10px)",
  height: 0,
  transition: {
    opacity: { duration: motionTokens.duration.considered, ease: DRIFT },
    filter: { duration: motionTokens.duration.considered, ease: DRIFT },
    y: { duration: motionTokens.duration.considered, ease: ENTER },
    scale: { duration: motionTokens.duration.considered, ease: ENTER },
    height: { ...motionTokens.spring.smooth, delay: 0.32 },
  },
}

const noop = () => () => {}
const isClient = () => true
const isServer = () => false
