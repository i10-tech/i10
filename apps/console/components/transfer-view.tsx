"use client"

import * as React from "react"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { AcceptTransfer } from "@/components/accept-transfer"
import { Wordmark } from "@/components/wordmark"
import { RememberShape, useRecordShape } from "@/components/list/remembered-shapes"
import {
  transferShape,
  type TransferData,
  type TransferShape,
} from "@/lib/shapes/transfers"
import { useExactTime } from "@/components/time"

export function TransferLoading() {
  return <TransferView shape={useRecordShape(transferShape)} />
}

export function TransferView({
  shape,
  data,
}: {
  shape: TransferShape
  data?: TransferData
}) {
  const exact = useExactTime()
  const loading = data === undefined
  const ok = data ? data.ok : shape.ok

  return (
    <BoneScope id="transfer" loading={loading}>
      <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
        <div className="w-full max-w-md space-y-6">
          <Wordmark />

          {ok ? (
            <div className="space-y-6 rounded-xl border p-6">
              <div className="space-y-2">
                <h1 className="text-lg font-medium">
                  {loading ? (
                    <Bone id="heading" width="85%" lineHeight={28} />
                  ) : (
                    <>
                      {data.offer?.offered_by} wants to transfer{" "}
                      <span className="font-mono">{data.offer?.domain_name}</span> to
                      you
                    </>
                  )}
                </h1>
                <div className="text-sm text-muted-foreground">
                  {loading ? (
                    <div className="space-y-1">
                      <Bone id="desc-1" width="100%" lineHeight={20} />
                      <Bone id="desc-2" width="90%" lineHeight={20} />
                      <Bone id="desc-3" width="60%" lineHeight={20} />
                    </div>
                  ) : (
                    data.offer && (
                      <p>
                        From the {data.offer.from_workspace} workspace. It arrives with
                        its DNS records and verification, so nothing changes at its DNS
                        provider, and it can send from the workspace you choose as soon
                        as you accept. This offer expires on{" "}
                        {exact(data.offer.expires_at)}.
                      </p>
                    )
                  )}
                </div>
              </div>
              {loading ? (
                <div className="space-y-4">
                  <Bone id="select" shape="box" height={40} radius={8} />
                  <div className="flex justify-end gap-2">
                    <Bone id="decline" shape="box" width={72} height={36} radius={8} />
                    <Bone id="accept" shape="box" width={110} height={36} radius={8} />
                  </div>
                </div>
              ) : (
                data.offer && (
                  <AcceptTransfer offer={data.offer} clerkEnabled={data.clerkEnabled} />
                )
              )}
            </div>
          ) : (
            <div className="space-y-4 rounded-xl border p-6">
              <h1 className="text-lg font-medium">
                {data?.error?.name === "tenant_not_ready"
                  ? "Your workspace is still being created"
                  : "This transfer is not available"}
              </h1>
              <p className="text-sm text-muted-foreground">
                {data?.error?.name === "tenant_not_ready"
                  ? "This usually takes a moment. Reload the page in a few seconds."
                  : (data?.error?.message ?? "This transfer is not available")}
              </p>
              <ButtonLink href="/domains" variant="secondary" size="sm">
                Go to your domains
              </ButtonLink>
            </div>
          )}
        </div>
      </main>
      {data && <RememberShape def={transferShape} shape={shape} />}
    </BoneScope>
  )
}
