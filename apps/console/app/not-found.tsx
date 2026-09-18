import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@repo/ui/components/button"

export const metadata: Metadata = { title: "Not found" }

/**
 * The 404 for a URL that matches no route at all.
 *
 * ⚠ THIS IS A DIFFERENT PAGE FROM `(app)/not-found.tsx`, AND BOTH ARE NEEDED.
 * That one is rendered by `notFound()` inside the dashboard shell — a domain id
 * that does not exist — so it keeps the sidebar and reads as "this record is
 * missing". This one catches a URL that matched nothing in the route tree, when
 * there may be no session and no workspace to put a sidebar around. Without it
 * Next serves its own built-in 404: unstyled Times New Roman on white, in dark
 * mode, with no way back.
 *
 * ⚠ THE COPY SAYS NOTHING ABOUT WHY, FOR THE SAME REASON THE OTHER ONE DOES
 * NOT. Row level security makes another workspace's id indistinguishable from
 * one that never existed, and both arrive here. "You do not have access to
 * this" would confirm the id is real, which turns the address bar into an
 * oracle for enumerating other people's records.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      {/*
       * ⚠ THE NUMBER IS DECORATION AND IS HIDDEN FROM SCREEN READERS. Read
       * aloud before the heading it is just "four zero four", which delays the
       * sentence that actually says what happened.
       */}
      <p
        aria-hidden
        className="font-mono text-6xl font-medium text-muted-foreground/25 tabular"
      >
        404
      </p>

      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          We could not find that page
        </h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          The link may be out of date, or the page may belong to a workspace you are not
          signed in to.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button asChild>
          <Link href="/">Go to the dashboard</Link>
        </Button>
        <Button asChild variant="ghost">
          <a href="https://docs.i10.tech" target="_blank" rel="noreferrer">
            Read the docs
          </a>
        </Button>
      </div>
    </main>
  )
}
