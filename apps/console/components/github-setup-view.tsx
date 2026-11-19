"use client"

import { BoneScope } from "@repo/ui/components/bone/bone"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import {
  Page,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { PanelError } from "@/components/panel-error"
import type { GithubSetupData, GithubSetupShape } from "@/lib/shapes/github-setup"

export function GithubSetupView({
  data,
}: {
  shape: GithubSetupShape
  data?: GithubSetupData
}) {
  const loading = data === undefined
  return (
    <BoneScope id="github-setup" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            <PageTitle>Connecting GitHub</PageTitle>
          </PageHeaderRow>
        </PageHeader>
        <PageBody className="max-w-xl space-y-4">
          {/* ⚠ NOTHING HERE IS DATA BUT THE ERROR, AND A SHAPE DOES NOT PREDICT AN ERROR: the page and its skeleton are the same button. */}
          {data?.error && (
            <PanelError title="GitHub is not connected" message={data.error} />
          )}
          <ButtonLink href="/templates" variant="secondary" size="sm">
            Back to templates
          </ButtonLink>
        </PageBody>
      </Page>
    </BoneScope>
  )
}
