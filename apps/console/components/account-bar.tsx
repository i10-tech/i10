"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowUpRight,
  House,
  ListChecks,
  LogOut,
  Moon,
  Settings,
  Sun,
  SunMoon,
  UserRound,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useClerk, useUser } from "@clerk/nextjs"
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar"
import { Badge } from "@repo/ui/components/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { Skeleton } from "@repo/ui/components/skeleton"
import { cn } from "cn"
import type { PlanSummary } from "@/lib/types"
import { useMounted } from "@/lib/react"

/**
 * The foot of the rail: who you are, the workspace's plan, and its usage, in
 * one row.
 *
 *   [avatar] First name [Free]                (ring)
 *   └──────── opens the account menu ──────┘  └ opens the limits ┘
 *
 * ⚠ TWO TARGETS IN ONE ROW, SIDE BY SIDE, NEVER NESTED. The person half opens
 * the account menu; the ring is its own button and opens the sending limits. A
 * button inside a button is invalid HTML and a click on the ring would open
 * both. There is no "..." any more: the whole person half IS the menu's
 * trigger, so a separate affordance for it was a second way to say the same
 * thing.
 *
 * ⚠ THE FIRST NAME, NOT THE EMAIL. The row is 240px with a badge and a ring in
 * it; an address truncated to "mohamed@exam…" identifies nobody. The full
 * address is the first line of the menu, where there is room for it.
 *
 * ⚠ THE PLAN BADGE LIVES HERE, AND ONLY HERE. It used to sit beside the
 * organization switcher at the top of the rail; it moved down to stand next to
 * the usage it explains (decided 2026-09-29). It is the workspace's plan, not
 * the person's - but "Free" beside a ring at 90% is the sentence that makes the
 * ring make sense.
 *
 * ⚠ OUR MENU RATHER THAN CLERK'S `<UserButton />`. Clerk's offers manage
 * account, switch account and sign out - none of the things people reach for
 * here (settings, appearance, the set-up flow, the homepage). The identity is
 * still Clerk's (`useUser`) and so is signing out; what is ours is the list.
 */
export interface AccountBarProps {
  plan: PlanSummary | null
  /**
   * The usage ring, rendered by the server (usage-rail.tsx) and passed in as a
   * slot, so the meter read stays on the server and streams in by itself.
   */
  usage?: React.ReactNode
  /**
   * ⚠ CLERK'S HOOKS THROW OUTSIDE A `<ClerkProvider>`, and the provider is only
   * mounted when a publishable key exists. Without one (preview mode, a laptop
   * with no identity provider) the row renders from `fallbackEmail` and the
   * menu has no "Log out", because there is no session to end.
   */
  clerkEnabled: boolean
  fallbackEmail?: string | null
}

export function AccountBar({ clerkEnabled, ...props }: AccountBarProps) {
  return clerkEnabled ? <ClerkAccountBar {...props} /> : <StaticAccountBar {...props} />
}

function ClerkAccountBar({ plan, usage }: Omit<AccountBarProps, "clerkEnabled">) {
  const { isLoaded, user } = useUser()
  const { signOut } = useClerk()

  /*
   * ⚠ A SKELETON RATHER THAN NOTHING, BECAUSE THIS IS PINNED TO THE BOTTOM OF A
   * FIXED RAIL. Rendering nothing until Clerk loads lets the row above it drop
   * and jump back - movement that is only noticeable because it happens on
   * every navigation.
   */
  if (!isLoaded) return <Skeleton className="h-8 w-full rounded-md" />
  if (!user) return null

  const email = user.primaryEmailAddress?.emailAddress ?? null
  return (
    <AccountRow
      name={firstName(user.firstName, user.username, email)}
      email={email}
      imageUrl={user.imageUrl}
      plan={plan}
      usage={usage}
      /*
       * ⚠ `redirectUrl` IS THE CONSOLE ROOT, NOT THE AUTH APP. Clerk clears
       * the session and then navigates; sending somebody straight to
       * `/sign-in` would skip the middleware that decides where an
       * unauthenticated visitor belongs, which is the one place that decision
       * is made.
       */
      onSignOut={() => void signOut({ redirectUrl: "/" })}
    />
  )
}

function StaticAccountBar({
  plan,
  usage,
  fallbackEmail,
}: Omit<AccountBarProps, "clerkEnabled">) {
  const email = fallbackEmail ?? null
  return (
    <AccountRow
      name={firstName(null, null, email)}
      email={email}
      imageUrl={null}
      plan={plan}
      usage={usage}
    />
  )
}

/**
 * What to call somebody in a 100px space.
 *
 * ⚠ THE ORDER IS "WHAT THEY TOLD US THEY ARE CALLED" FIRST. Clerk's first name
 * when they gave one; their username when they chose one; otherwise the part
 * of their address before the @, which is at least theirs and at least short.
 * "Account" only when there is nothing at all, which should not happen for a
 * signed-in person.
 */
export function firstName(
  first: string | null | undefined,
  username: string | null | undefined,
  email: string | null | undefined,
): string {
  const given = first?.trim()
  if (given) return given
  const handle = username?.trim()
  if (handle) return handle
  const local = email?.split("@")[0]?.trim()
  if (local) return local
  return "Account"
}

function AccountRow({
  name,
  email,
  imageUrl,
  plan,
  usage,
  onSignOut,
}: {
  name: string
  email: string | null
  imageUrl: string | null
  plan: PlanSummary | null
  usage?: React.ReactNode
  onSignOut?: () => void
}) {
  return (
    /*
     * ⚠ TWO 32px TARGETS, 4px APART, AND THE TRIGGER'S RIGHT PADDING IS 4px.
     * Equal heights so their hover fills are the same shape side by side; the
     * gap so the fills never touch and read as one lumpy control. Padding, gap
     * and the ring's inset used to stack to ~21px between badge and ring
     * against 8px on the left; now it is ~15px, and the ring sits 15px from the
     * rail's edge, mirroring the avatar's 16px.
     */
    <div className="flex items-center gap-1">
      {/*
       * ⚠ `modal={false}`, LIKE THE USAGE POPOVER BESIDE IT. Radix menus are
       * modal by default: the rest of the page stops taking the pointer while
       * one is open, so the first click elsewhere only closes the menu. The
       * two surfaces open from the same row and must behave the same - an
       * outside click closes this one AND lands where it was aimed.
       */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          className={cn(
            "flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pr-1 pl-2",
            "text-left transition-colors duration-(--duration-instant) ease-(--ease-linear)",
            "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar focus-visible:outline-none",
            "data-[state=open]:bg-sidebar-accent",
          )}
          aria-label={`Account menu for ${name}`}
        >
          <Avatar className="size-6 shrink-0">
            {imageUrl && <AvatarImage src={imageUrl} alt="" />}
            {/* ⚠ A LETTER, NOT AN ICON. Two people at the same company with no
                avatar are two identical grey circles; the initial is the only
                thing that tells them apart at this size. */}
            <AvatarFallback className="text-2xs">
              {name.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 truncate text-sm font-medium">{name}</span>
          {plan && (
            /*
             * ⚠ PUSHED TO THE RIGHT EDGE OF THE TRIGGER, beside the ring. Left
             * next to a short name it left an empty tail inside the hover fill,
             * which read as a gap in the row; at the edge the badge and the
             * ring sit together, the two halves of "your plan, your usage".
             */
            <Badge
              variant="secondary"
              // ⚠ `bg-track`, NOT `secondary`: secondary is 0.97 on a
              // near-white rail and 0.20 on a black one, so the badge had no
              // visible ground in either theme. The track's translucent wash
              // reads on both, the same as the empty ring beside it.
              className="ms-auto shrink-0 bg-track px-1.5 py-0 text-2xs text-foreground/80"
              title={`${plan.name} plan`}
            >
              {plan.name}
            </Badge>
          )}
        </DropdownMenuTrigger>

        {/*
         * ⚠ IT OPENS UPWARDS. The trigger is the last row of a full-height
         * rail, so there is nothing below it - a menu anchored downwards would
         * be clipped by the viewport and Radix would flip it anyway, one frame
         * later and visibly.
         */}
        <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-56">
          {email && (
            <>
              <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
                {email}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}

          <DropdownMenuItem asChild>
            <Link href="/account">
              <UserRound />
              My profile
            </Link>
          </DropdownMenuItem>
          {/*
           * ⚠ SETTINGS MOVED HERE FROM THE RAIL. It was a group of one under the
           * daily destinations, and the rail now has to fit without scrolling.
           * ⌘K still finds it (lib/nav.ts).
           */}
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <Settings />
              Settings
            </Link>
          </DropdownMenuItem>

          <AppearanceRow />

          <DropdownMenuSeparator />

          <DropdownMenuItem asChild>
            {/*
             * ⚠ `rel="noreferrer"` WITH `target="_blank"`: without `noopener`
             * the opened page gets a handle on this one through
             * `window.opener`. Modern browsers imply it; the attribute makes it
             * true rather than assumed.
             */}
            <a href="https://i10.tech" target="_blank" rel="noreferrer">
              <House />
              Homepage
              <ArrowUpRight className="ms-auto size-3.5 text-muted-foreground" />
            </a>
          </DropdownMenuItem>

          {/*
           * ⚠ THE SET-UP FLOW IS REACHABLE FOR EVER, ON PURPOSE. It re-runs
           * after an upgrade off the free plan, and somebody adding their second
           * domain a year later wants exactly that screen - see the note at the
           * top of app/onboarding/page.tsx.
           */}
          <DropdownMenuItem asChild>
            <Link href="/onboarding">
              <ListChecks />
              Onboarding
            </Link>
          </DropdownMenuItem>

          {onSignOut && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
                <LogOut />
                Log out
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {usage}
    </div>
  )
}

/**
 * Light and dark, inline, without leaving the menu.
 *
 * ⚠ IT IS NOT A `DropdownMenuItem`, AND THAT IS DELIBERATE. An item closes the
 * menu when it is chosen, and a theme toggle that shuts the menu makes trying
 * the other one a second trip. This is a row that happens to live in a menu.
 *
 * ⚠ AND `system` IS NOT OFFERED HERE, BUT IT IS REPRESENTED. What this row
 * shows while the preference is `system` is the theme that preference RESOLVED
 * to (`resolvedTheme`), so exactly one side is always lit, and it is the side
 * matching what is on screen. The full picker, including System, is on the
 * appearance page.
 */
function AppearanceRow() {
  const { resolvedTheme, setTheme } = useTheme()
  // ⚠ SEE `ThemePicker`: `useTheme()` cannot know the stored preference on the
  // server, so marking a side selected before hydration is a mismatch React
  // resolves by discarding the markup.
  const mounted = useMounted()

  return (
    <div className="flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm">
      <span className="flex items-center gap-2">
        {/* The same 16px, muted, as the icons on the items around it. */}
        <SunMoon className="size-4 text-muted-foreground" aria-hidden />
        Appearance
      </span>
      <div
        className="flex items-center gap-0.5 rounded-full bg-muted/60 p-0.5"
        role="radiogroup"
        aria-label="Appearance"
      >
        {(
          [
            { value: "light", icon: Sun, label: "Light" },
            { value: "dark", icon: Moon, label: "Dark" },
          ] as const
        ).map((option) => {
          const selected = mounted && resolvedTheme === option.value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.label}
              onClick={() => setTheme(option.value)}
              className={cn(
                "grid size-6 cursor-pointer place-items-center rounded-full transition-colors",
                "duration-(--duration-instant) ease-(--ease-linear)",
                selected
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <option.icon className="size-3.5" />
            </button>
          )
        })}
      </div>
    </div>
  )
}
