"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowLeft, type LucideIcon } from "lucide-react"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
  type Variants,
} from "motion/react"
import { cn } from "cn"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { StatusDot } from "@repo/ui/components/i10/status"
import type { Attention } from "@/lib/types"
import { readDomainAttention } from "@/lib/attention"
import { useDestinationPathname } from "@/lib/pending-navigation"
import { useResetWhen } from "@/lib/react"
import { inSettings, isActive, NAV, SETTINGS_NAV, type NavGroup } from "@/lib/nav"

/**
 * The left rail.
 *
 * ⚠ A CLIENT COMPONENT ONLY BECAUSE OF `usePathname`, AND THAT IS THE WHOLE
 * REASON. Everything else about it is static. Rendering the whole shell on the
 * client to get an active state would ship the navigation, the icons and the
 * workspace switcher as JavaScript on every page; this way the layout around it
 * stays a server component and only the highlight costs anything.
 *
 * ⚠ THE ACTIVE ITEM IS A FILLED ROW, NOT A LEFT BORDER OR A COLOURED LABEL.
 * A border shifts the text by however many pixels wide it is unless every other
 * row carries a transparent one, which is the kind of detail that gets lost in
 * a refactor and produces a nav that twitches as you move through it. A
 * background fill changes nothing about layout.
 *
 * ⚠ AND THAT FILL IS ONE ELEMENT THAT MOVES, NOT A CLASS THAT SWITCHES ROWS.
 * It is the cheapest shared-element transition in the product: `layoutId` makes
 * Motion treat the highlight on the old row and the highlight on the new one as
 * the same object, so it travels between them instead of blinking out here and
 * in there. It is also the only thing on screen that reliably survives a
 * navigation, which makes it the one place the eye can hold onto while the page
 * underneath is replaced.
 */
export function SidebarNav({
  groups,
  /**
   * What needs somebody to act, streamed in after the rail has rendered - see
   * `AttentionMark`. Null when it could not be read.
   */
  attention,
}: {
  groups?: NavGroup[]
  attention?: Promise<Attention["domains"] | null>
}) {
  // The click's destination, so the highlight lands with the skeleton.
  const pathname = useDestinationPathname()

  /*
   * ⚠ THE RAIL SWAPS RATHER THAN THE PAGE GROWING A SECOND COLUMN. Settings
   * used to render its own narrow nav inside the content area, so on a settings
   * page the screen carried two vertical lists of links a few pixels apart -
   * one for the console, one for settings - and the eye had to work out which
   * of them it was reading. Replacing the rail keeps exactly one navigation on
   * screen at a time, and the back link is what the main rail's continued
   * presence used to provide.
   *
   * ⚠ DECIDED FROM THE PATH, IN THE ONE COMPONENT THAT ALREADY KNOWS IT. The
   * shell is a server component and cannot read the pathname; threading it down
   * as a prop would mean the layout re-rendering on every navigation. This
   * component is already a client component for the active highlight, so the
   * branch is free.
   */
  const settings = groups === undefined && inSettings(pathname)
  const shown = groups ?? (settings ? SETTINGS_NAV : NAV)
  const nav = React.useRef<HTMLElement>(null)
  const pill = useActivePill(nav, `${pathname}|${settings}`)

  return (
    <nav
      ref={nav}
      className="relative flex flex-col gap-4 px-2 py-1"
      aria-label={settings ? "Settings" : "Primary"}
      onKeyDown={moveFocus}
    >
      {/*
       * ⚠ ONE FILL FOR THE WHOLE RAIL, MOVED BY A CSS TRANSFORM, SO IT RUNS ON
       * THE COMPOSITOR (2026-11-09). It used to be a `layoutId` span per row,
       * driven frame by frame from JavaScript; the highlight now starts at the
       * click, and the commit that follows holds the main thread for 100ms or
       * more in dev, so the spring jumped 40px in one frame. A transform
       * transition keeps moving while the page renders. Painted first, so the
       * rows' labels sit above it.
       */}
      <span
        ref={pill}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 rounded-[10px] bg-sidebar-accent opacity-0"
      />
      {settings && (
        /*
         * ⚠ "Back to the dashboard" RATHER THAN A BARE ARROW. An arrow alone in a
         * sidebar reads as "collapse", and somebody who clicks it expecting a
         * narrower rail and lands on the overview has lost their place. It also
         * has to be the first focusable thing in the rail, so keyboard users
         * reach the way out before the eight settings pages.
         */
        <Link
          href="/"
          className={cn(
            "flex h-7 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
            "duration-(--duration-instant) ease-(--ease-linear)",
            "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
          )}
        >
          <ArrowLeft className="size-4 shrink-0" />
          <span className="truncate">Back to the dashboard</span>
        </Link>
      )}

      {shown.map((group, i) => (
        <div key={group.label ?? `group-${i}`} className="flex flex-col gap-0.5">
          {group.label && (
            <h2 className="px-2 pt-1 pb-1 text-xs text-muted-foreground">
              {group.label}
            </h2>
          )}
          {group.items
            .filter((item) => !item.hidden)
            .map((item) => {
              const active = isActive(pathname, item)
              const Icon = item.icon

              return (
                <MotionLink
                  key={item.href}
                  href={item.href}
                  // ⚠ `aria-current="page"` IS THE ACCESSIBLE HALF OF THE
                  // HIGHLIGHT. The background fill tells a sighted person where
                  // they are; without this a screen reader reads twelve
                  // identical links.
                  aria-current={active ? "page" : undefined}
                  /*
                   * ⚠ THE GESTURE STATE LIVES ON THE ROW, NOT ON THE ICON, AND
                   * THAT IS WHAT MAKES THE WHOLE ROW THE TARGET. Motion
                   * propagates a variant name down to any child that declares
                   * the same variant, so hovering anywhere on the link - the
                   * label, the padding, the far right edge - runs the icon's
                   * animation. Putting `whileHover` on the icon itself would
                   * mean it only fired on a 16px square.
                   */
                  initial={false}
                  whileHover="hover"
                  whileTap="tap"
                  className={cn(
                    // ⚠ `isolate` IS WHAT KEEPS THE TRAVELLING FILL BEHIND THE
                    // LABEL AND IN FRONT OF THE RAIL. It gives the row its own
                    // stacking context, so the highlight's `-z-10` puts it
                    // under this row's text rather than under the sidebar
                    // itself, where it would simply be invisible.
                    // ⚠ 28px ROWS, NOT 32, SO THE RAIL FITS A LAPTOP WITHOUT
                    // SCROLLING (decided 2026-09-29). Thirteen rows at 32px
                    // overflowed a 700px-tall window by 40px; at 28 they fit
                    // with room, and still clear the 24px minimum target.
                    "group relative isolate flex h-[30px] items-center gap-2.5 rounded-[10px] px-2.5 text-sm",
                    // ⚠ COLOUR ONLY, SO `--ease-linear` IS CORRECT HERE. The
                    // motion rules reserve eased curves for things that MOVE;
                    // a linear ramp on a background is exactly what Base's
                    // fifth timing row is for.
                    "transition-colors duration-(--duration-instant) ease-(--ease-linear)",
                    active
                      ? "font-medium text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                  )}
                >
                  <NavIcon icon={Icon} active={active} />
                  <span className="truncate">{item.label}</span>
                  {item.href === "/domains" && attention && (
                    <React.Suspense fallback={null}>
                      <AttentionMark attention={attention} />
                    </React.Suspense>
                  )}
                </MotionLink>
              )
            })}
        </div>
      ))}
    </nav>
  )
}

/**
 * ⚠ `motion.create(Link)` RATHER THAN A `motion.div` WRAPPED AROUND ONE. An
 * extra element between the list and the anchor would either break the flex
 * column's spacing or need its own display rules to not; forwarding the props
 * onto Next's own component keeps the DOM exactly as it was and keeps
 * prefetching, `aria-current` and the router intact.
 */
const MotionLink = motion.create(Link)

/**
 * ⚠ STIFF AND HEAVILY DAMPED, WHICH IS WHAT MAKES IT UNNOTICEABLE. The brief
 * for these is that somebody feels the interface respond without registering an
 * animation; at `stiffness: 500` the icon has finished before a deliberate
 * glance reaches it, and `damping: 30` leaves a trace of overshoot so it reads
 * as a physical nudge rather than a state flip.
 */
const ICON_SPRING: Transition = { type: "spring", stiffness: 500, damping: 30 }

/**
 * Places the rail's fill on the active row, and moves it there when that row
 * changes. Returns the fill's ref.
 *
 * ⚠ ABOUT 300ms ON THE CONSOLE'S ENTER CURVE, as the spring it replaced: long
 * enough to follow from "Overview" to "Settings", finished before the page's
 * content arrives. The first placement, and the swap to the settings rail, land
 * without travel: there is no previous row on screen to come from.
 */
function useActivePill(nav: React.RefObject<HTMLElement | null>, key: string) {
  const pill = React.useRef<HTMLSpanElement>(null)
  const placed = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    const el = pill.current
    const row = nav.current?.querySelector<HTMLElement>('a[aria-current="page"]')
    if (!el) return
    if (!row) {
      el.style.opacity = "0"
      placed.current = null
      return
    }
    const rail = placed.current?.split("|")[1]
    const travel = placed.current !== null && rail === key.split("|")[1]
    el.style.transition = travel
      ? "transform 300ms var(--ease-enter), height 300ms var(--ease-enter)"
      : "none"
    el.style.width = `${row.offsetWidth}px`
    el.style.height = `${row.offsetHeight}px`
    el.style.transform = `translate(${row.offsetLeft}px, ${row.offsetTop}px)`
    el.style.opacity = "1"
    placed.current = key
  }, [nav, key])
  return pill
}

/**
 * ⚠ NOTHING ON HOVER, A PRESS ON TAP (2026-10-03). The icon used to grow and
 * lift a pixel under the pointer; the row's fill already answers a hover, and
 * an icon that hops on every pass down the rail is motion without meaning. The
 * small press on tap stays - it is the confirmation that the click landed.
 */
const ICON_VARIANTS: Variants = {
  hover: { scale: 1 },
  tap: { scale: 0.92 },
}

function NavIcon({ icon: Icon, active }: { icon: LucideIcon; active: boolean }) {
  return (
    <motion.span
      variants={ICON_VARIANTS}
      transition={ICON_SPRING}
      // ⚠ `inline-flex` AND NOT A BARE SPAN. A transform on an inline element
      // is ignored, so without this the whole thing silently does nothing.
      className="inline-flex shrink-0"
    >
      <Icon
        className={cn("size-4", active ? "text-foreground" : "text-muted-foreground")}
      />
    </motion.span>
  )
}

/**
 * ↑ and ↓ move between the rail's rows, Home and End to the ends.
 *
 * ⚠ ON TOP OF TAB, NOT INSTEAD OF IT. Every row stays in the tab order, so
 * nothing about the rail changes for somebody who tabs; the arrows are the
 * faster path for somebody already in it, the way a menu behaves.
 */
function moveFocus(event: React.KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"]
  if (!keys.includes(event.key) || event.altKey || event.metaKey || event.ctrlKey)
    return
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)"),
  )
  const at = rows.indexOf(document.activeElement as HTMLElement)
  if (at === -1) return
  event.preventDefault()
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : (at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length
  rows[next]?.focus()
}

/**
 * A dot on "Domains" while anything there needs somebody (#158 follow-up):
 * a domain not yet verified or whose proof went missing, an incoming transfer
 * offer, or a reputation finding or pause.
 *
 * ⚠ A DOT, NOT A COUNT BADGE. A number in a pill is the loud chip #145 is
 * removing; the question the rail answers is "is there something to look at",
 * and the domains page says what. Red only for a pause, which stops mail;
 * everything else is amber.
 *
 * ⚠ STREAMED, SO THE RAIL NEVER WAITS FOR IT. The count reads Clerk for the
 * transfer offers; a slow answer must not hold up the navigation, so the
 * layout passes the unresolved promise and the dot arrives when it does.
 *
 * ⚠ THE WORDS ARE IN THE DOM. A dot alone is invisible to a screen reader and
 * to anybody who cannot tell amber from grey.
 *
 * ⚠ IT ASKS AGAIN ON EVERY PAGE CHANGE (2026-10-13). The layout's answer is
 * read once: Next keeps the layout across navigations, so deleting a pending
 * domain and landing on /domains left the dot lit until a full reload. The
 * layout's answer still wins whenever the layout does re-render.
 */
function AttentionMark({
  attention,
}: {
  attention: Promise<Attention["domains"] | null>
}) {
  const initial = React.use(attention)
  const [a, setA] = React.useState(initial)
  useResetWhen(initial, () => setA(initial))

  /*
   * ⚠ ON MOUNT TOO, NOT ONLY ON A CHANGE. Settings swaps the rail for its own
   * list, so the mark unmounts there and comes back with the layout's old
   * answer; asking on mount is what keeps that answer from being shown again.
   */
  const pathname = usePathname()
  React.useEffect(() => {
    let stale = false
    void readDomainAttention()
      .then((next) => {
        if (!stale && next) setA(next)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [pathname])

  /*
   * ⚠ IT COMES AND GOES WITH MOTION (2026-10-13), now that it can change
   * while the page is open: a dot that blinked out after a delete read as a
   * glitch rather than as the thing being resolved. Opacity only with reduced
   * motion.
   */
  const reduce = useReducedMotion()
  const shown = a !== null && a.total > 0
  const reasons = a
    ? [
        a.unverified > 0 && `${a.unverified} not verified`,
        a.proof_missing > 0 && `${a.proof_missing} losing verification`,
        a.transfers > 0 &&
          `${a.transfers} transfer ${a.transfers === 1 ? "offer" : "offers"}`,
        a.reputation === "held" && "sending on hold",
        a.reputation === "paused" && "sending paused",
        a.reputation === "at_risk" && "sending at risk",
      ].filter(Boolean)
    : []
  return (
    <AnimatePresence>
      {shown && (
        <motion.span
          key="attention"
          className="ml-auto flex items-center"
          title={reasons.join(", ")}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={
            reduce
              ? { opacity: 0, transition: { duration: motionTokens.duration.exit } }
              : {
                  opacity: 0,
                  scale: 0.4,
                  transition: { duration: motionTokens.duration.exit },
                }
          }
          transition={
            reduce
              ? { duration: motionTokens.duration.fast }
              : motionTokens.spring.snappy
          }
        >
          <StatusDot
            tone={
              a?.reputation === "paused" || a?.reputation === "held"
                ? "danger"
                : "warning"
            }
            className="size-2"
          />
          <span className="sr-only">Needs attention: {reasons.join(", ")}</span>
        </motion.span>
      )}
    </AnimatePresence>
  )
}
