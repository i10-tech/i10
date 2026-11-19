"use client"

import * as React from "react"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { BoneScope } from "@repo/ui/components/bone/bone"
import { PanelError } from "@/components/panel-error"
import { SsoHome } from "@/components/sso/sso-home"
import { DirectoriesPanel } from "@/components/sso/directories-panel"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import { ssoShape, type SsoData, type SsoShape } from "@/lib/shapes/sso"
import type { SsoAbilities } from "@/lib/sso-types"

import type { SsoConnections } from "@/lib/sso-types"

const EMPTY_CONNECTIONS: SsoConnections = {
  data: [],
  protocols: [],
  presets: { oidc: [], saml: [] },
}

const DEFAULT_ABILITIES: SsoAbilities = {
  manage: true,
  owner: true,
  userId: null,
}

export function SsoLoading() {
  return <SsoHomeView shape={useRememberedShape(ssoShape)} />
}

export function SsoHomeView({ shape, data }: { shape: SsoShape; data?: SsoData }) {
  const loading = data === undefined
  const abilities = data?.abilities ?? DEFAULT_ABILITIES

  return (
    <BoneScope id="sso" loading={loading}>
      {data?.error !== undefined ? (
        <PanelError title="Could not load your connections" message={data.error} />
      ) : !shape.canManage ? (
        <Section className="pt-0">
          <SectionDescription>
            Only a workspace admin or owner can set this up. Ask one of them if your
            company wants to sign in through its identity provider.
          </SectionDescription>
        </Section>
      ) : !shape.available ? (
        <Section className="pt-0">
          <SectionDescription>
            Single sign-on is not available on this deployment.
          </SectionDescription>
        </Section>
      ) : (
        <div>
          <Section className="pt-0">
            <SectionTitle>Connections</SectionTitle>
            <SectionContent>
              <SsoHome
                catalog={data?.catalog ?? EMPTY_CONNECTIONS}
                abilities={abilities}
                loading={loading}
                skeletonCount={shape.connections}
              />
            </SectionContent>
          </Section>
          <Section>
            <SectionTitle>Directories</SectionTitle>
            <SectionDescription>
              Add and remove people automatically when your company&rsquo;s directory
              changes.
            </SectionDescription>
            <SectionContent>
              <DirectoriesPanel
                abilities={abilities}
                initial={data?.directories}
                loading={loading}
                skeletonCount={shape.directories ?? 1}
              />
            </SectionContent>
          </Section>
        </div>
      )}
      {data && data.error === undefined && (
        <RememberShape def={ssoShape} shape={shape} />
      )}
    </BoneScope>
  )
}
