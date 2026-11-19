import type { Metadata } from "next"
import { TransferView } from "@/components/transfer-view"
import { tryApi } from "@/lib/api"
import { transferShape, type TransferData } from "@/lib/shapes/transfers"
import type { IncomingTransfer } from "@/lib/types"

export const metadata: Metadata = { title: "Domain transfer" }

// ⚠ PER REQUEST: it reads a session and an offer addressed to that person.
export const dynamic = "force-dynamic"

/**
 * The page an offer's email links to.
 *
 * ⚠ OUTSIDE THE `(app)` GROUP, LIKE ONBOARDING, AND FOR THE SAME REASON. That
 * layout sends a new account to `/onboarding` - and somebody who signed up
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

  const data: TransferData = {
    id,
    offer: result.ok ? result.data : null,
    ok: result.ok,
    clerkEnabled,
    ...(result.ok ? {} : { error: result.error }),
  }

  return <TransferView shape={transferShape.of(data)} data={data} />
}
