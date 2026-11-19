"use client"

import * as React from "react"
import { BoneScope } from "@repo/ui/components/bone/bone"
import { ConnectionView } from "@/components/sso/connection/connection-view"
import { RememberShape, useRecordShape } from "@/components/list/remembered-shapes"
import {
  ssoConnectionShape,
  type SsoConnectionData,
  type SsoConnectionShape,
} from "@/lib/shapes/sso-connection"

export function SsoConnectionLoading() {
  return <SsoConnectionPageView shape={useRecordShape(ssoConnectionShape)} />
}

export function SsoConnectionPageView({
  shape,
  data,
}: {
  shape: SsoConnectionShape
  data?: SsoConnectionData
}) {
  const loading = data === undefined

  return (
    <BoneScope id="sso-connection" loading={loading}>
      <ConnectionView
        initial={data?.connection}
        abilities={
          data?.abilities ?? { manage: true, owner: shape.owner, userId: null }
        }
        authOrigin={data?.authOrigin ?? null}
        clerkEnabled={data?.clerkEnabled ?? false}
        loading={loading}
        shape={shape}
      />
      {data && <RememberShape def={ssoConnectionShape} shape={shape} />}
    </BoneScope>
  )
}
