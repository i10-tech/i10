import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@repo/ui/components/button"
import { AcceptTransfer } from "@/components/accept-transfer"
import { Wordmark } from "@/components/wordmark"
import { tryApi } from "@/lib/api"
import { formatExact } from "@/lib/format"
import type { IncomingTransfer } from "@/lib/types"

export const metadata: Metadata = { title: "Domain transfer" }

// ⚠ PER REQUEST: it reads a session and an offer addressed to that person.
export const dynamic = "force-dynamic"

/**
 * The page an offer's email links to.
 *
 * ⚠ OUTSIDE THE `(app)` GROUP, LIKE ONBOARDING, AND FOR THE SAME REASON. That
 * layout sends a new account to `/onboarding` — and somebody who signed up
 * BECAUSE of this email would be sent there and never see the offer they came
 * for. Here they answer it first; set-up can wait.
 */
export default async function TransferPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const result = await tryApi<IncomingTransfer>(
    `/console/transfers/${encodeURIComponent(id)}`,
  )
  const clerkEnabled = Boolean(process.env.CLERK_PUBLISHABLE_KEY)

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <Wordmark />

        {result.ok ? (
          <div className="space-y-6 rounded-xl border p-6">
            <div className="space-y-2">
              <h1 className="text-lg font-semibold">
                {result.data.offered_by} wants to transfer{" "}
                <span className="font-mono">{result.data.domain_name}</span> to you
              </h1>
              <p className="text-sm text-muted-foreground">
                From the {result.data.from_workspace} workspace. It arrives with its DNS
                records and verification, so nothing changes at its DNS provider, and it
                can send from the workspace you choose as soon as you accept. This offer
                expires on {formatExact(result.data.expires_at)}.
              </p>
            </div>
            <AcceptTransfer offer={result.data} clerkEnabled={clerkEnabled} />
          </div>
        ) : (
          <div className="space-y-4 rounded-xl border p-6">
            <h1 className="text-lg font-semibold">
              {result.error.name === "tenant_not_ready"
                ? "Your workspace is still being created"
                : "This transfer is not available"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {result.error.name === "tenant_not_ready"
                ? "This usually takes a moment. Reload the page in a few seconds."
                : result.error.message}
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link href="/domains">Go to your domains</Link>
            </Button>
          </div>
        )}
      </div>
    </main>
  )
}
