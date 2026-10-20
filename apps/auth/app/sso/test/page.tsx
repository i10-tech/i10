import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { TestIdp } from "./test-idp"

export const metadata: Metadata = { title: "Test SSO · i10" }

export const dynamic = "force-dynamic"

/**
 * The TEST engine's stand-in for an IdP (#337). Development only: a
 * production build answers 404 here, and the API refuses the assertion unless
 * its own test engine is on (identity/test-engine.ts).
 *
 * ⚠ DELIBERATELY PLAIN. It is a developer's tool for driving the bridge end
 * to end, not a screen anybody else sees, so it gets no design of its own.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>
}) {
  if (process.env.NODE_ENV === "production") notFound()
  const { state } = await searchParams
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 pt-24 pb-12">
      <div className="w-full max-w-sm">
        <TestIdp state={typeof state === "string" ? state : ""} />
      </div>
    </main>
  )
}
