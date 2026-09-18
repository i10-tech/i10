import Link from "next/link"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import { Separator } from "@repo/ui/components/separator"
import { Skeleton } from "@repo/ui/components/skeleton"
import { PageFrame } from "@/components/page-frame"
import { SidebarNav } from "@/components/sidebar-nav"
import { CommandMenu } from "@/components/command-menu"
import { MobileNav } from "@/components/mobile-nav"
import { UsageRail } from "@/components/usage-rail"
import { WorkspaceBar } from "@/components/workspace-bar"
import { AccountBar } from "@/components/account-bar"
import { TenantNotReady } from "@/components/tenant-not-ready"
import { Wordmark } from "@/components/wordmark"
import { tryApi } from "@/lib/api"
import { hasSkippedOnboarding } from "@/lib/onboarding-skip"
import type { Me } from "@/lib/types"

/**
 * The console shell.
 *
 * ⚠ A SERVER COMPONENT, AND THE THREE CLIENT ISLANDS INSIDE IT ARE THE ONLY
 * JAVASCRIPT THE CHROME COSTS. The sidebar needs `usePathname`, the mobile
 * drawer needs open state, and the command menu needs a keydown listener.
 * Everything else — the workspace bar, the usage rail, the wordmark — renders
 * on the server and ships as markup.
 *
 * ⚠ AND THE ONBOARDING REDIRECT LIVES HERE RATHER THAN IN THE MIDDLEWARE.
 * Deciding it in middleware would mean an API round trip on every navigation,
 * including on static assets that slip past the matcher, and the answer depends
 * on the tenant's plan and their domains — which middleware would have to fetch
 * with no session helpers and no error boundary. Here it is one call that the
 * layout already needs for the workspace name.
 *
 * ⚠ NOTHING UNDER THIS LAYOUT IS EVER PRERENDERED, AND `dynamic` BELOW IS WHERE
 * THAT IS DECLARED. Every page here reads a Clerk session and renders one
 * tenant's data; a statically generated shell would either be built with no
 * session — and fail — or, far worse, be built with one and served to everybody.
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
   * the Clerk webhook that provisions the tenant has not landed yet — a window
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
     * in the segment, including the ones that would have worked — and it loses
     * the retry button that an error boundary gets for free.
     */
    throw new Error(me.error.message)
  }

  // ⚠ THE FLAG DECIDES THE REDIRECT AND NOTHING ELSE. `/onboarding` is outside
  // this layout precisely so it stays reachable when this fires — see
  // docs/decisions/console.md §4. A guard that ran there too would be a loop.
  //
  // ⚠ AND THE SKIP IS CHECKED HERE, BECAUSE THIS REDIRECT IS WHAT IT OVERRIDES.
  // Without it "Skip to the console" was a link to a page that immediately sent
  // people back, which is indistinguishable from a broken button. See
  // lib/onboarding-skip.ts for why this is a cookie and not a stored fact.
  if (me.data.onboarding.should_onboard && !(await hasSkippedOnboarding())) {
    redirect("/onboarding")
  }

  // See WorkspaceBar: Clerk's hooks throw outside a provider, and the provider
  // is only mounted when a key exists.
  const clerkEnabled = Boolean(process.env.CLERK_PUBLISHABLE_KEY)

  return (
    <div className="flex min-h-dvh">
      {/*
       * ⚠ `sticky` WITH `h-dvh`, NOT `fixed`. A fixed rail is removed from flow,
       * so the main column needs a matching left margin — two numbers that have
       * to agree, and do not, the first time somebody changes the width. Sticky
       * keeps it in flow: the flexbox does the arithmetic.
       */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-sidebar lg:flex">
        <div className="flex h-14 items-center px-4">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Wordmark />
          </Link>
        </div>

        <Separator />

        <div className="px-2 py-2">
          <WorkspaceBar
            tenant={me.data.tenant}
            plan={me.data.billing.plan}
            clerkEnabled={clerkEnabled}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <SidebarNav />
        </div>

        {/*
         * ⚠ THE USAGE METER IS PINNED TO THE BOTTOM OF THE RAIL, VISIBLE ON
         * EVERY SCREEN, AND THAT IS A PRODUCT DECISION RATHER THAN A LAYOUT
         * ONE. Metering that only appears on a billing page is metering nobody
         * looks at until they are refused a send. It is also the only
         * persistent home for the upgrade button.
         *
         * ⚠ IN ITS OWN SUSPENSE BOUNDARY so a slow meter read cannot hold up
         * the navigation. The rail renders, the number arrives.
         */}
        <div className="mt-auto space-y-1 border-t p-2">
          <Suspense fallback={<Skeleton className="h-16 w-full rounded-md" />}>
            <UsageRail />
          </Suspense>

          {/*
           * ⚠ THE PERSON, AT THE FOOT OF THE RAIL, BELOW THE WORKSPACE'S USAGE.
           * It used to share the top row with the organization switcher, which
           * gave a control somebody touches monthly the same prominence as the
           * one that changes which workspace's data is on every page. The
           * reading order now matches the questions: which workspace (top),
           * where to go (middle), what it is costing and who I am (bottom).
           */}
          {clerkEnabled && <AccountBar />}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav
          tenant={me.data.tenant}
          plan={me.data.billing.plan}
          clerkEnabled={clerkEnabled}
        />
        {/*
         * ⚠ THE FRAME IS INSIDE THE COLUMN AND OUTSIDE THE PAGE, so the rail,
         * the workspace bar and the mobile header stay perfectly still while the
         * content changes. A transition that moved the chrome as well would be a
         * page load with extra steps — the whole value of an app shell is that
         * most of the screen does not go anywhere.
         */}
        <PageFrame>{children}</PageFrame>
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
