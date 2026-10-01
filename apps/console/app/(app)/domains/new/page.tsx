import type { Metadata } from "next"
import { BackButton } from "@/components/back-button"
import {
  Page,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { AddDomainForm } from "@/components/add-domain-form"

export const metadata: Metadata = { title: "Add a domain" }

/**
 * ⚠ A PAGE RATHER THAN A MODAL, BECAUSE THE FLOW IS NOT SHORT. It does a live
 * DNS lookup, explains what it found, and asks a decision that cannot be
 * changed afterwards. A dialog would mean somebody loses all of it by clicking
 * outside it, and could not open the docs in another tab without starting over.
 */
export default function NewDomainPage() {
  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <div className="flex items-center gap-3">
            <BackButton href="/domains" label="Back to domains" />
            <PageTitle>Add a domain</PageTitle>
          </div>
        </PageHeaderRow>
        <PageDescription>
          We will look up who hosts its DNS and show you the shortest path from here to
          sending.
        </PageDescription>
      </PageHeader>

      <PageBody width="prose">
        <AddDomainForm />
      </PageBody>
    </Page>
  )
}
