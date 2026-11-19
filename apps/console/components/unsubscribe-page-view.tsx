"use client"

import * as React from "react"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { BoneScope } from "@repo/ui/components/bone/bone"
import { UnsubscribePageSettings } from "@/components/unsubscribe-settings"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import {
  unsubscribePageShape,
  type UnsubscribePageData,
  type UnsubscribePageShape,
} from "@/lib/shapes/unsubscribe-page"

export function UnsubscribePageLoading() {
  return <UnsubscribePageView shape={useRememberedShape(unsubscribePageShape)} />
}

export function UnsubscribePageView({
  shape,
  data,
}: {
  shape: UnsubscribePageShape
  data?: UnsubscribePageData
}) {
  const loading = data === undefined

  return (
    <BoneScope id="unsubscribe-page" loading={loading}>
      <div>
        <Section className="pt-0">
          <SectionTitle>Appearance</SectionTitle>
          <SectionDescription>
            Shown to your recipients when they follow an unsubscribe link. Applies to
            every broadcast from this workspace.
          </SectionDescription>
          <SectionContent>
            <UnsubscribePageSettings />
          </SectionContent>
        </Section>
      </div>
      {data && <RememberShape def={unsubscribePageShape} shape={shape} />}
    </BoneScope>
  )
}
