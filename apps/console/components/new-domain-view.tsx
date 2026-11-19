"use client"

import * as React from "react"
import { Globe } from "lucide-react"
import { BoneScope } from "@repo/ui/components/bone/bone"
import { Page, PageBody, PageHeader } from "@repo/ui/components/i10/page"
import { AddDomainForm } from "@/components/add-domain-form"
import { DetailHero } from "@/components/detail-hero"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import {
  newDomainShape,
  type NewDomainData,
  type NewDomainShape,
} from "@/lib/shapes/new-domain"

/** What loading.tsx renders: the view drawn from the remembered shape. */
export function NewDomainLoading() {
  return <NewDomainView shape={useRememberedShape(newDomainShape)} />
}

/**
 * /domains/new, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 */
export function NewDomainView({
  shape,
  data,
}: {
  shape: NewDomainShape
  data?: NewDomainData
}) {
  const loading = data === undefined

  return (
    <BoneScope id="domain-new" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <DetailHero
            crumbs={[{ label: "Domains", href: "/domains" }]}
            icon={<Globe />}
            title="Add domain"
            description="Use a domain you own to send email from i10."
          />
        </PageHeader>

        <PageBody className="pt-10">
          <AddDomainForm
            tenantId={data?.tenantId ?? ""}
            restored={data?.restored}
            loading={loading}
            stepOverride={loading ? shape.step : undefined}
          />
        </PageBody>
        {data && <RememberShape def={newDomainShape} shape={shape} />}
      </Page>
    </BoneScope>
  )
}
