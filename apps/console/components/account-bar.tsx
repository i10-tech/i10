"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowUpRight, Moon, MoreHorizontal, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { useClerk, useUser } from "@clerk/nextjs"
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { Skeleton } from "@repo/ui/components/skeleton"
import { cn } from "cn"
import { useMounted } from "@/lib/react"

/**
 * Who you are, at the foot of the rail, with the things you do about it.
 *
 * ⚠ IT USED TO SIT IN THE TOP ROW BESIDE THE ORGANIZATION SWITCHER, AND THE TWO
 * ANSWER DIFFERENT QUESTIONS. The top of the rail says which workspace's data is
 * on screen — switching it changes every number on every page. The bottom says
 * which person is signed in, which changes nothing about the data. Sharing a row
 * gave a monthly control the same prominence as the one that reframes the whole
 * console, and squeezed both into half the width.
 *
 * ⚠ AND IT IS OUR MENU RATHER THAN CLERK'S `<UserButton />`, WHICH IS A CHANGE
 * WORTH JUSTIFYING BECAUSE EVERY OTHER IDENTITY SURFACE HERE IS THEIRS. Clerk's
 * menu offers exactly three things — manage account, switch account, sign out —
 * and none of the four that people actually reach for in this product: the
 * appearance toggle, the set-up flow, the marketing site, and a profile link
 * that stays inside the console. Those were reachable only from a settings page
 * nobody could find. The identity still comes from Clerk (`useUser`) and signing
 * out is still Clerk's (`signOut`); what is ours is the list.
 */
export function AccountBar() {
  const { isLoaded, user } = useUser()
  const { signOut } = useClerk()

  /*
   * ⚠ A SKELETON RATHER THAN NOTHING, BECAUSE THIS IS PINNED TO THE BOTTOM OF A
   * FIXED RAIL. Rendering nothing until Clerk loads lets the usage meter above
   * it drop by thirty-six pixels and jump back — movement that is only
   * noticeable because it happens on every navigation.
   */
  if (!isLoaded) return <Skeleton className="h-9 w-full rounded-md" />
  if (!user) return null

  const label =
    user.primaryEmailAddress?.emailAddress ?? user.fullName ?? "Your account"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
          "text-left transition-colors duration-(--duration-instant) ease-(--ease-linear)",
          "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar focus-visible:outline-none",
          "data-[state=open]:bg-sidebar-accent",
        )}
        aria-label="Account menu"
      >
        <Avatar className="size-6 shrink-0">
          <AvatarImage src={user.imageUrl} alt="" />
          {/* ⚠ A LETTER, NOT AN ICON. Two people at the same company with no
              avatar are two identical grey circles; the initial is the only
              thing that tells them apart at this size. */}
          <AvatarFallback className="text-2xs">
            {label.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {label}
        </span>
        <MoreHorizontal className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>

      {/*
       * ⚠ IT OPENS UPWARDS AND MATCHES THE TRIGGER'S WIDTH. The trigger is the
       * last row of a full-height rail, so there is nothing below it — a menu
       * anchored downwards would be clipped by the viewport and Radix would flip
       * it anyway, one frame later and visibly.
       */}
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <DropdownMenuItem asChild>
          <Link href="/account">My profile</Link>
        </DropdownMenuItem>

        <AppearanceRow />

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          {/*
           * ⚠ `rel="noreferrer"` WITH `target="_blank"`, and it is not
           * ceremony: without `noopener` the opened page gets a handle on this
           * one through `window.opener` and can navigate it somewhere else.
           * Modern browsers imply it for `_blank`, and the attribute is what
           * makes that true rather than assumed.
           */}
          <a href="https://i10.tech" target="_blank" rel="noreferrer">
            Homepage
            <ArrowUpRight className="ms-auto size-3.5 text-muted-foreground" />
          </a>
        </DropdownMenuItem>

        {/*
         * ⚠ THE SET-UP FLOW IS REACHABLE FOR EVER, ON PURPOSE. It re-runs after
         * an upgrade off the free plan, and somebody adding their second domain
         * a year later wants exactly that screen — see the note at the top of
         * app/onboarding/page.tsx. It was reachable only by typing the URL.
         */}
        <DropdownMenuItem asChild>
          <Link href="/onboarding">Onboarding</Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          variant="destructive"
          /*
           * ⚠ `redirectUrl` IS THE CONSOLE ROOT, NOT THE AUTH APP. Clerk clears
           * the session and then navigates; sending somebody straight to
           * `/sign-in` would skip the middleware that decides where an
           * unauthenticated visitor belongs, which is the one place that
           * decision is made.
           */
          onSelect={() => void signOut({ redirectUrl: "/" })}
        >
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Light and dark, inline, without leaving the menu.
 *
 * ⚠ IT IS NOT A `DropdownMenuItem`, AND THAT IS DELIBERATE. An item closes the
 * menu when it is chosen, and a theme toggle that shuts the menu makes trying
 * the other one a second trip. This is a row that happens to live in a menu.
 *
 * ⚠ AND `system` IS NOT OFFERED HERE, BUT IT IS REPRESENTED. Three options need
 * three targets in a 200px row and the third is the one nobody picks
 * deliberately; the full picker, including System, is still on the appearance
 * page. What this row shows while the preference is `system` is the theme that
 * preference RESOLVED to — see `resolvedTheme` below — so the control always has
 * exactly one side lit, and it is the side matching what is on screen.
 */
function AppearanceRow() {
  /*
   * ⚠ `resolvedTheme`, NOT `theme`, AND THE DIFFERENCE WAS A ROW WITH NOTHING
   * LIT UP. `theme` is the stored PREFERENCE, and its default is `"system"` —
   * which is neither of the two values offered here, so a fresh account opened
   * this menu and saw a segmented control with no segment selected. Not wrong
   * exactly, but unreadable: there is no way to tell "no preference" from "this
   * control is broken".
   *
   * `resolvedTheme` is what `system` actually resolved to against
   * `prefers-color-scheme` — always `"light"` or `"dark"` — so the highlight now
   * answers the question the person is really asking, which is "what am I
   * looking at". Somebody on a dark laptop sees Dark lit.
   *
   * ⚠ AND IT KEEPS FOLLOWING THE SYSTEM UNTIL SOMEBODY PRESSES SOMETHING.
   * `resolvedTheme` re-renders when the OS flips at sunset, so the highlight
   * moves with it; pressing either side stores an explicit preference and stops
   * that, which is exactly what reaching for this control means.
   */
  const { resolvedTheme, setTheme } = useTheme()
  // ⚠ SEE `ThemePicker`: `useTheme()` cannot know the stored preference on the
  // server, so marking a side selected before hydration is a mismatch React
  // resolves by discarding the markup.
  const mounted = useMounted()

  return (
    <div className="flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm">
      <span>Appearance</span>
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
