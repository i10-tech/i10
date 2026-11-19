"use client"

import * as React from "react"
import { BoneScope } from "@repo/ui/components/bone/bone"
import { PanelError } from "@/components/panel-error"
import { SetupFlow } from "@/components/sso/setup/setup-flow"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import {
  ssoConnectShape,
  type SsoConnectData,
  type SsoConnectShape,
} from "@/lib/shapes/sso-connect"
import type { SsoConnections } from "@/lib/sso-types"

const EMPTY_CONNECTIONS: SsoConnections = {
  data: [],
  protocols: [],
  presets: { oidc: [], saml: [] },
}

export function SsoConnectLoading() {
  return <SsoConnectView shape={useRememberedShape(ssoConnectShape)} />
}

export function SsoConnectView({
  shape,
  data,
}: {
  shape: SsoConnectShape
  data?: SsoConnectData
}) {
  const loading = data === undefined

  return (
    <BoneScope id="sso-connect" loading={loading}>
      {data?.error !== undefined ? (
        <PanelError title="Could not load providers" message={data.error} />
      ) : (
        <SetupFlow
          initial={data?.initial ?? null}
          catalog={data?.catalog ?? EMPTY_CONNECTIONS}
          initialAccessDomains={data?.initialAccessDomains}
          email={data?.email ?? null}
          authOrigin={data?.authOrigin ?? null}
          previewTest={data?.previewTest ?? false}
          loading={loading}
          expected={loading ? shape : undefined}
        />
      )}
      {data && <RememberShape def={ssoConnectShape} shape={shape} />}
    </BoneScope>
  )
}
