import type { Metadata } from "next"
import { SuppressionsView } from "@/components/suppressions-view"
import { tryApi } from "@/lib/api"
import { suppressionsShape, type SuppressionsData } from "@/lib/shapes/suppressions"
import type { Page as ApiPage, SuppressionRow } from "@/lib/types"

export const metadata: Metadata = { title: "Suppressions" }

/**
 * Addresses we refuse to send to.
 *
 * ⚠ THIS LIST PROTECTS THE ACCOUNT, NOT THE RECIPIENT, AND THE DISTINCTION
 * MATTERS WHEN SOMEBODY ASKS TO REMOVE AN ENTRY. Continuing to send to an
 * address that hard-bounced is the fastest way to lose a sending reputation -
 * every attempt is counted against the account by the receiving networks. An
 * address here is not being punished; it is being skipped so the rest of the
 * mail keeps arriving.
 *
 * ⚠ AND IT IS SEPARATE FROM A CONTACT'S `unsubscribed` FLAG. Unsubscribing from
 * a newsletter must not stop a password reset, and a hard bounce on a
 * transactional message must not silently remove somebody from a marketing list
 * they can still be reached on. Two questions, two tables, both consulted at
 * send.
 */
export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; reason?: string; cursor?: string }>
}) {
  const params = await searchParams

  const result = await tryApi<ApiPage<SuppressionRow>>("/console/suppressions", {
    query: {
      search: params.search,
      reason: params.reason,
      cursor: params.cursor,
      limit: 50,
    },
  })

  const data: SuppressionsData = {
    rows: result.ok ? result.data.data : [],
    nextCursor: result.ok ? result.data.nextCursor : null,
    ...(result.ok ? {} : { error: result.error.message }),
  }

  return <SuppressionsView shape={suppressionsShape.of(data)} data={data} />
}
