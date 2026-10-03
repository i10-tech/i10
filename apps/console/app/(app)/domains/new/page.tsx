import type { Metadata } from "next"
import { cookies } from "next/headers"
import { Globe } from "lucide-react"
import { Page, PageBody, PageHeader } from "@repo/ui/components/page"
import { AddDomainForm, type RestoredDraft } from "@/components/add-domain-form"
import { BackButton } from "@/components/back-button"
import { DetailHero } from "@/components/detail-hero"
import { ADD_DOMAIN_DRAFT_COOKIE, draftFor } from "@/lib/add-domain-draft"
import { tryApi } from "@/lib/api"
import type { DnsInspection, Domain, Me } from "@/lib/types"

export const metadata: Metadata = { title: "Add a domain" }

/**
 * ⚠ A PAGE RATHER THAN A MODAL, BECAUSE THE FLOW IS NOT SHORT. It does a live
 * DNS lookup, explains what it found, and asks a decision that cannot be
 * changed afterwards. A dialog would mean somebody loses all of it by clicking
 * outside it, and could not open the docs in another tab without starting over.
 *
 * ⚠ THE WIDE BODY, NOT THE PROSE ONE (2026-10-03): the first step has the email
 * preview beside it, and the last step's record tables want the room.
 */
export default async function NewDomainPage() {
  const me = await tryApi<Me>("/console/me")
  const tenantId = me.ok ? (me.data.tenant?.id ?? "") : ""
  const restored = await restore(
    draftFor((await cookies()).get(ADD_DOMAIN_DRAFT_COOKIE)?.value, tenantId),
  )

  return (
    <Page>
      <PageHeader>
        <DetailHero
          back={<BackButton href="/domains" label="Back to domains" />}
          icon={<Globe />}
          title="Add domain"
          description="Use a domain you own to send email from i10."
        />
      </PageHeader>

      <PageBody className="pt-10">
        <AddDomainForm tenantId={tenantId} restored={restored} />
      </PageBody>
    </Page>
  )
}

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
async function restore(
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
