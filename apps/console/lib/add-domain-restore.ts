import "server-only"
import type { RestoredDraft } from "@/components/add-domain-form"
import type { draftFor } from "@/lib/add-domain-draft"
import { tryApi } from "@/lib/api"
import type { DnsInspection, Domain } from "@/lib/types"

/**
 * A reload in the middle of the flow, rebuilt from what the cookie remembers.
 *
 * ⚠ THE CREATED DOMAIN IS READ AGAIN, NOT TRUSTED. If it has been deleted
 * since, or verified by another route, the records step has nothing to show:
 * a deleted one sends them back to choosing (the name and answers kept), and
 * a verified one has nothing left to add, so the flow starts over.
 *
 * ⚠ AND THE LOOKUP IS RUN HERE FOR A RESTORED NAME, so the second step paints
 * with its provider already in it instead of growing one a second later.
 */
export async function restoreDraft(
  draft: ReturnType<typeof draftFor>,
): Promise<RestoredDraft | null> {
  if (!draft) return null

  const [domain, lookup] = await Promise.all([
    draft.id
      ? tryApi<Domain>(`/console/domains/${encodeURIComponent(draft.id)}`)
      : null,
    draft.step !== "domain" && draft.name
      ? tryApi<DnsInspection>("/console/dns/lookup", {
          query: { domain: draft.name.trim().toLowerCase() },
        })
      : null,
  ])

  const created = domain?.ok ? domain.data : null
  if (created?.status === "verified") return null

  return {
    ...draft,
    // Past the point of creation only with a row to show.
    step: draft.step === "publish" && !created ? "records" : draft.step,
    created,
    inspection: lookup?.ok ? lookup.data : null,
  }
}
