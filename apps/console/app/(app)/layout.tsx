import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import { Skeleton } from "@repo/ui/components/skeleton"
import { PageFrame } from "@/components/page-frame"
import { RememberedViewsProvider, type View } from "@/components/list/remembered-views"
import { Rail } from "@/components/rail"
import { SendingStatusNotice } from "@/components/sending-status-banner"
import { ClientContext } from "@/components/client-context"
import { SidebarNav } from "@/components/sidebar-nav"
import { CommandMenu } from "@/components/command-menu"
import { MobileNav } from "@/components/mobile-nav"
import { UsageRail } from "@/components/usage-rail"
import { WorkspaceBar } from "@/components/workspace-bar"
import { AccountBar } from "@/components/account-bar"
import { TenantNotReady } from "@/components/tenant-not-ready"
import { tryApi } from "@/lib/api"
import { hasSkippedOnboarding } from "@/lib/onboarding-skip"
import type { Attention, Me } from "@/lib/types"

/**
 * The console shell.
 *
 * ⚠ A SERVER COMPONENT, AND THE THREE CLIENT ISLANDS INSIDE IT ARE THE ONLY
 * JAVASCRIPT THE CHROME COSTS. The sidebar needs `usePathname`, the mobile
 * drawer needs open state, and the command menu needs a keydown listener.
 * Everything else - the workspace bar, the usage rail, the wordmark - renders
 * on the server and ships as markup.
 *
 * ⚠ AND THE ONBOARDING REDIRECT LIVES HERE RATHER THAN IN THE MIDDLEWARE.
 * Deciding it in middleware would mean an API round trip on every navigation,
 * including on static assets that slip past the matcher, and the answer depends
 * on the tenant's plan and their domains - which middleware would have to fetch
 * with no session helpers and no error boundary. Here it is one call that the
 * layout already needs for the workspace name.
 *
 * ⚠ NOTHING UNDER THIS LAYOUT IS EVER PRERENDERED, AND `dynamic` BELOW IS WHERE
 * THAT IS DECLARED. Every page here reads a Clerk session and renders one
 * tenant's data; a statically generated shell would either be built with no
 * session - and fail - or, far worse, be built with one and served to everybody.
 * It is set on the LAYOUT rather than per page so a page added tomorrow
 * inherits it; without it `next build` fails with "couldn't be rendered
 * statically because it used `headers`", which is Next catching the mistake,
 * but only for the pages that happen to touch a header directly.
 */
export const dynamic = "force-dynamic"

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const me = await tryApi<Me>("/console/me")

  /*
   * ⚠ `tenant_not_ready` IS NOT AN ERROR AND MUST NOT RENDER AS ONE. It means
   * the Clerk webhook that provisions the tenant has not landed yet - a window
   * of a second or two on somebody's very first visit. A red error page there
   * is the first thing they ever see of the product, and their response to
   * "you do not have access to this workspace" is to sign up again.
   */
  if (!me.ok && me.error.name === "tenant_not_ready") {
    return <TenantNotReady />
  }

  if (!me.ok) {
    /*
     * ⚠ THROWN, SO `error.tsx` HANDLES IT, RATHER THAN RENDERING AN ERROR HERE.
     * A layout that renders its own failure state renders it around every page
     * in the segment, including the ones that would have worked - and it loses
     * the retry button that an error boundary gets for free.
     */
    throw new Error(me.error.message)
  }

  // ⚠ THE FLAG DECIDES THE REDIRECT AND NOTHING ELSE. `/onboarding` is outside
  // this layout precisely so it stays reachable when this fires - see
  // docs/decisions/console.md §4. A guard that ran there too would be a loop.
  //
  // ⚠ AND THE SKIP IS CHECKED HERE, BECAUSE THIS REDIRECT IS WHAT IT OVERRIDES.
  // Without it "Skip to the console" was a link to a page that immediately sent
  // people back, which is indistinguishable from a broken button. See
  // lib/onboarding-skip.ts for why this is a cookie and not a stored fact.
  if (
    me.data.onboarding.should_onboard &&
    !(await hasSkippedOnboarding(me.data.tenant?.id ?? ""))
  ) {
    redirect("/onboarding")
  }

  // The grid or table each list page was left in, so it renders that way from
  // the first byte instead of switching once the browser has loaded.
  const views = Object.fromEntries(
    (await cookies())
      .getAll()
      .filter(
        (c) =>
          c.name.startsWith("i10-view-") && (c.value === "grid" || c.value === "table"),
      )
      .map((c) => [c.name.slice("i10-view-".length), c.value as View]),
  )

  // See WorkspaceBar: Clerk's hooks throw outside a provider, and the provider
  // is only mounted when a key exists.
  const clerkEnabled = Boolean(process.env.CLERK_PUBLISHABLE_KEY)

  // ⚠ NOT AWAITED. The rail renders now and the mark on "Domains" streams in -
  // see AttentionMark. A failed read is null, which draws no mark.
  const attention = tryApi<Attention>("/console/attention").then((r) =>
    r.ok ? r.data.domains : null,
  )

  return (
    /*
     * ⚠ THE SHELL IS EXACTLY ONE VIEWPORT TALL AND DOES NOT SCROLL. The
     * document scrollbar is gone on purpose: scrolling lives in the page pane
     * (see `PageFrame`), so the rail, the workspace bar and the mobile header
     * cannot travel with the content no matter how far somebody flings it.
     *
     * ⚠ THIS REPLACED A `sticky top-0` RAIL, WHICH IS A WEAKER VERSION OF THE
     * SAME IDEA. Sticky still leaves the whole page on the document scroller,
     * so the rail is only pinned for as long as nothing upstream introduces a
     * scroll container, an overscroll bounce still slides it, and the rail is
     * held in place by a rule that has to keep being true rather than by the
     * box it lives in. A fixed-height shell makes it structural.
     *
     * ⚠ `overflow-hidden` HERE IS WHAT STOPS THE BOUNCE, not a style choice.
     * Without it a flick past the end of the pane rubber-bands the document -
     * the rail lifts off the top edge and drops back - which is precisely the
     * movement this layout is meant to remove.
     */
    <div className="flex h-dvh overflow-hidden">
      {/*
       * ⚠ NO HEIGHT OF ITS OWN: `h-full` DEFERS TO THE SHELL. A rail that
       * declared `h-dvh` a second time would be two numbers that have to agree
       * - and they stop agreeing the first time the shell grows a header.
       */}
      <Rail className="hidden h-full w-60 shrink-0 flex-col border-r bg-sidebar lg:flex">
        {/*
         * ⚠ THE RAIL STARTS WITH THE WORKSPACE, NOT A LOGO (decided
         * 2026-10-01). Which workspace you are in is the first thing worth
         * knowing in here; the mark said only which product, which nobody in
         * the dashboard needs told.
         *
         * ⚠ NO RULE UNDER IT (2026-10-03). It used to line up with a bordered
         * page header and the two drew one bar across the whole screen; the
         * page header is part of the content now, so the rule would be a line
         * to nowhere.
         */}
        <div className="flex items-center px-2 pt-2 pb-1">
          <div className="min-w-0 flex-1">
            <WorkspaceBar tenant={me.data.tenant} clerkEnabled={clerkEnabled} />
          </div>
        </div>

        {/*
         * ⚠ THE RAIL FITS; IT DOES NOT SCROLL. With Settings moved into the
         * account menu and 28px rows, the navigation fits a 700px-tall window,
         * and a rail that scrolls hides its own last items behind a gesture
         * nobody expects to need there (decided 2026-09-29).
         *
         * ⚠ `overflow-y-auto` STAYS, AS THE LAST RESORT, AND ONLY ENGAGES WHEN
         * THE NAV TRULY CANNOT FIT. A fixed height breakpoint was tried and
         * clipped Mailboxes out of reach between the breakpoint and the height
         * the rail actually needs; "scroll only when it overflows" cannot clip.
         * The account row stays pinned either way.
         */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
          <SidebarNav attention={attention} />
        </div>

        {/*
         * ⚠ ONE ROW AT THE FOOT OF THE RAIL: WHO YOU ARE, THE PLAN, AND THE
         * USAGE RING. The ring is visible on every screen, and that is a
         * product decision rather than a layout one: metering that only
         * appears on a billing page is metering nobody looks at until they are
         * refused a send. See components/account-bar.tsx.
         *
         * ⚠ THE RING IN ITS OWN SUSPENSE BOUNDARY, so a slow meter read cannot
         * hold up the rail. The row renders; the ring arrives.
         *
         * ⚠ NO SENDING-HEALTH PILL HERE (#153). Trouble reaches every page
         * through the banner above the content.
         */}
        {/*
         * ⚠ THE SENDING NOTICE LIVES HERE, NOT AS A BAND ACROSS THE PAGE
         * (2026-10-03). It still shows on every screen while sending is in
         * trouble - that rule from #157 stands - but as one line in the rail
         * that leads to the overview, where the full explanation is.
         */}
        <Suspense fallback={null}>
          <SendingStatusNotice className="mx-2 mb-2" />
        </Suspense>

        <div className="mt-auto border-t p-2">
          <AccountBar
            clerkEnabled={clerkEnabled}
            plan={me.data.billing.plan}
            fallbackEmail={me.data.user.email}
            usage={
              <Suspense fallback={<Skeleton className="size-8 shrink-0 rounded-md" />}>
                <UsageRail />
              </Suspense>
            }
          />
        </div>
      </Rail>

      {/*
       * ⚠ `overflow-hidden` ON THE COLUMN, `overflow-y-auto` ON THE PANE
       * INSIDE IT. The column has to refuse to grow before the pane can be
       * asked to scroll: a flex child's default `min-height: auto` lets it
       * stretch to its content instead, and then the shell overflows and
       * nothing scrolls anywhere.
       */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <MobileNav
          tenant={me.data.tenant}
          plan={me.data.billing.plan}
          fallbackEmail={me.data.user.email}
          clerkEnabled={clerkEnabled}
          attention={attention}
          usage={
            <Suspense fallback={<Skeleton className="size-8 shrink-0 rounded-md" />}>
              <UsageRail side="top" />
            </Suspense>
          }
        />
        {/*
         * ⚠ THE FRAME IS INSIDE THE COLUMN AND OUTSIDE THE PAGE, so the rail,
         * the workspace bar and the mobile header stay perfectly still while the
         * content changes. A transition that moved the chrome as well would be a
         * page load with extra steps - the whole value of an app shell is that
         * most of the screen does not go anywhere.
         */}
        {/*
         * ⚠ BELOW THE LARGE BREAKPOINT THERE IS NO RAIL, so the same one-line
         * notice sits under the mobile header instead. Its own boundary with
         * no fallback: it is absent for almost everybody.
         */}
        <Suspense fallback={null}>
          <SendingStatusNotice className="mx-4 mt-3 lg:hidden" />
        </Suspense>
        <ClientContext />
        <PageFrame>
          <RememberedViewsProvider views={views}>{children}</RememberedViewsProvider>
        </PageFrame>
      </div>

      {/*
       * ⚠ RENDERED ONCE, AT THE SHELL, NOT PER PAGE. The command menu binds a
       * global ⌘K listener; one per page would stack listeners on every
       * navigation in a client-side transition and open several dialogs at
       * once.
       */}
      <CommandMenu />
    </div>
  )
}
