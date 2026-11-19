"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { BoneScope } from "@repo/ui/components/bone/bone"
import { PanelError } from "@/components/panel-error"
import { AuditLog } from "@/components/sso/audit-log"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import {
  securityAuditShape,
  type SecurityAuditData,
  type SecurityAuditShape,
} from "@/lib/shapes/security-audit"

export function SecurityAuditLoading() {
  return <SecurityAuditView shape={useRememberedShape(securityAuditShape)} />
}

export function SecurityAuditView({
  shape,
  data,
}: {
  shape: SecurityAuditShape
  data?: SecurityAuditData
}) {
  const loading = data === undefined

  return (
    <BoneScope id="security-audit" loading={loading}>
      <Section className="pt-0">
        <Link
          href="/settings/security"
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> Security
        </Link>
        <SectionTitle>Identity audit log</SectionTitle>
        <SectionDescription>
          Who changed sign-in settings, directories, sessions and mailboxes, and when.
        </SectionDescription>
        <SectionContent>
          {data?.error !== undefined ? (
            <PanelError title="Could not load the audit log" message={data.error} />
          ) : !shape.canManage ? (
            <p className="text-sm text-muted-foreground">
              Only a workspace admin or owner can see the audit log.
            </p>
          ) : !shape.available ? (
            <p className="text-sm text-muted-foreground">
              The identity audit log is not available on this deployment.
            </p>
          ) : (
            <AuditLog
              events={data?.events ?? NONE}
              user={data?.user ?? null}
              limit={data?.limit ?? 50}
              nextLimit={data?.nextLimit ?? null}
              clerkEnabled={data?.clerkEnabled ?? false}
              loading={loading}
              filtered={shape.filtered}
              skeletonRows={shape.rows}
            />
          )}
        </SectionContent>
      </Section>
      {data && data.error === undefined && (
        <RememberShape def={securityAuditShape} shape={shape} skip={shape.filtered} />
      )}
    </BoneScope>
  )
}
