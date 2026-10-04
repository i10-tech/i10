import type { Metadata } from "next"
import { cookies } from "next/headers"
import { Globe } from "lucide-react"
import { Page, PageBody, PageHeader } from "@repo/ui/components/page"
import { AddDomainForm } from "@/components/add-domain-form"
import { BackButton } from "@/components/back-button"
import { DetailHero } from "@/components/detail-hero"
import { ADD_DOMAIN_DRAFT_COOKIE, draftFor } from "@/lib/add-domain-draft"
import { restoreDraft } from "@/lib/add-domain-restore"
import { tryApi } from "@/lib/api"
import type { Me } from "@/lib/types"

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
  const restored = await restoreDraft(
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
