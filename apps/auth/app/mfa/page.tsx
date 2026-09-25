import type { Metadata } from "next"
import { afterAuthUrl } from "../_lib/redirect"
import { ResumeBoundary } from "../_components/resume-boundary"
import { MfaForm } from "./mfa-form"

export const metadata: Metadata = { title: "Two-step verification · i10" }

export const dynamic = "force-dynamic"

/**
 * The second factor, on its own route.
 *
 * ⚠ IT RE-VALIDATES `redirect_url` RATHER THAN TRUSTING THE PAGE THAT SENT US.
 * The sign-in form forwards the RAW query parameter here, not the destination
 * it already resolved — because a resolved URL travelling through a query
 * string is just an unvalidated URL again, and this page would be the one
 * honouring it. Every page that can finish a sign-in checks the allowlist
 * itself. See _lib/redirect.ts.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>
}) {
  const { redirect_url: raw } = await searchParams
  const after = afterAuthUrl(raw)
  const carry =
    typeof raw === "string" ? `?redirect_url=${encodeURIComponent(raw)}` : ""

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <ResumeBoundary>
          <MfaForm afterAuthUrl={after} signInHref={`/sign-in${carry}`} />
        </ResumeBoundary>
      </div>
    </main>
  )
}
