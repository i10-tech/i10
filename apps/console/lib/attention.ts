"use server"

import { tryApi } from "@/lib/api"
import type { Attention } from "@/lib/types"

/**
 * The rail's "needs attention" for Domains, read again from the browser.
 *
 * ⚠ A READ, AND IT REVALIDATES NOTHING. The layout that renders the rail is
 * kept across navigations and never re-renders for one, so the dot asks this
 * itself when the page changes - see `AttentionMark`. A failure answers null,
 * which keeps whatever the dot showed.
 */
export async function readDomainAttention(): Promise<Attention["domains"] | null> {
  const answer = await tryApi<Attention>("/console/attention")
  return answer.ok ? answer.data.domains : null
}
