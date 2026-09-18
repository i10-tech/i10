"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowLeft, type LucideIcon } from "lucide-react"
import { motion, type Transition } from "motion/react"
import { cn } from "cn"
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
   * What makes this rail's highlight its own.
   *
   * ⚠ TWO RAILS EXIST AT ONCE — THE DESKTOP ONE AND THE MOBILE DRAWER — AND A
   * SHARED `layoutId` WOULD MAKE THEM FIGHT. Motion matches the id globally, so
   * two mounted highlights claiming the same one means it tries to morph a
   * 240px rail's pill into a drawer's and back on every render. The scope is a
   * prop rather than a `useId` because it has to be STABLE across navigations:
   * a generated id changes when the tree remounts, and a highlight whose
   * identity changed is a highlight that fades instead of travelling.
   */
  scope = "rail",
}: {
  groups?: NavGroup[]
  scope?: string
}) {
  const pathname = usePathname()

  /*
   * ⚠ THE RAIL SWAPS RATHER THAN THE PAGE GROWING A SECOND COLUMN. Settings
   * used to render its own narrow nav inside the content area, so on a settings
   * page the screen carried two vertical lists of links a few pixels apart —
   * one for the console, one for settings — and the eye had to work out which
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

  return (
    <nav
      className="flex flex-col gap-5 px-2 py-1"
      aria-label={settings ? "Settings" : "Primary"}
    >
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
            "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
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
            <h2 className="px-2 pt-1 pb-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
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
                   * ⚠ THE ROW IS STILL WHAT TRIGGERS THE ICON, THROUGH `group`
                   * BELOW RATHER THAN THROUGH MOTION VARIANTS. It used to be
                   * `whileHover="hover"` here, propagated down to a variant the
                   * icon declared; the icon's gesture is a stylesheet rule now,
                   * and `.group:hover` reaches it from exactly the same place
                   * for exactly the same reason — hovering the label or the far
                   * right edge of the row has to count, not just the 16px
                   * square.
                   */
                  initial={false}
                  className={cn(
                    // ⚠ `isolate` IS WHAT KEEPS THE TRAVELLING FILL BEHIND THE
                    // LABEL AND IN FRONT OF THE RAIL. It gives the row its own
                    // stacking context, so the highlight's `-z-10` puts it
                    // under this row's text rather than under the sidebar
                    // itself, where it would simply be invisible.
                    "group relative isolate flex h-8 items-center gap-2.5 rounded-md px-2 text-sm",
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
                  {active && (
                    <motion.span
                      layoutId={`${scope}-active`}
                      aria-hidden
                      className="absolute inset-0 -z-10 rounded-md bg-sidebar-accent"
                      transition={ACTIVE_SPRING}
                    />
                  )}
                  <NavIcon icon={Icon} active={active} />
                  <span className="truncate">{item.label}</span>
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
 * ⚠ SOFTER AND SLOWER THAN THE ICON'S, BECAUSE THIS ONE TRAVELS A REAL DISTANCE.
 * The icon nudges by a pixel; the highlight crosses up to four hundred of them
 * between "Overview" and "Settings", and a 500-stiffness spring over that
 * distance is a streak rather than a movement. `damping: 34` against
 * `stiffness: 380` lands it in about 300ms with no visible bounce at the end —
 * long enough to follow with the eye, short enough that it has finished before
 * the new page's content arrives.
 */
const ACTIVE_SPRING: Transition = { type: "spring", stiffness: 380, damping: 34 }

/**
 * ⚠ THE ICON DRAWS ITSELF NOW, AND IT REPLACED A TRANSFORM RATHER THAN JOINING
 * ONE. What was here was `scale: 1.12` with a pixel of lift — the glyph treated
 * as a rigid object being nudged, which is perfectly pleasant and is not what
 * anybody means by an icon being alive. What reads that way is the STROKES
 * arriving in order, the way somebody would sketch the shape. See the
 * `[data-draw]` block in @repo/ui/styles/tokens.css for the mechanism.
 *
 * ⚠ AND IT IS CSS, WHICH IS WHY IT SURVIVES EIGHTEEN DIFFERENT GLYPHS WITH NO
 * PER-ICON WORK. Lucide is a stroke-only set drawn in one 24×24 box, so
 * `stroke-dasharray` plus an `nth-child` delay ladder sequences ANY of them.
 * A hand-choreographed version — the bell rocking, the envelope opening — is
 * eighteen bespoke animations and a nineteenth the next time a nav item is
 * added, and the one that gets forgotten is the one that looks broken.
 *
 * ⚠ THE TRIGGER IS THE ROW, NOT THE 16px SQUARE. The parent link carries
 * Tailwind's `group`, and the stylesheet's selector is
 * `.group:hover [data-draw] …` — so hovering the label, the padding, or the far
 * right edge of the row draws the icon. That was the point of the old
 * `whileHover` living on the link too.
 *
 * ⚠ `motion` IS GONE FROM THIS COMPONENT AND THE LINK STILL NEEDS IT. The
 * travelling active highlight above is a `layoutId`, which is Motion's and has
 * no CSS equivalent; only the ICON's gesture moved to the stylesheet.
 */
function NavIcon({ icon: Icon, active }: { icon: LucideIcon; active: boolean }) {
  return (
    <span
      data-draw
      // ⚠ `inline-flex` AND NOT A BARE SPAN. It keeps the glyph from picking up
      // the row's line box, which is what made it sit a pixel low.
      className="inline-flex shrink-0"
    >
      <Icon
        className={cn("size-4", active ? "text-foreground" : "text-muted-foreground")}
      />
    </span>
  )
}
