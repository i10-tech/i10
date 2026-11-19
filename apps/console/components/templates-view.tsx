"use client"

import * as React from "react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Badge } from "@repo/ui/components/badge/badge"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  TITLE,
} from "@repo/ui/components/i10/page"
import { PlaceholderTitle } from "@repo/ui/components/i10/page-title"
import { ApiButton } from "@/components/list/api-button"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import { GithubPanel } from "@/components/github-panel"
import { PanelError } from "@/components/panel-error"
import { TemplateLibrary } from "@/components/templates/library"
import { NewTemplateMenu } from "@/components/templates/new-menu"
import {
  SubmitTrustedTemplateButton,
  WithdrawTrustedTemplate,
} from "@/components/trusted-templates"
import { PAGE_COPY } from "@/lib/page-copy"
import {
  templatesShape,
  type TemplatesData,
  type TemplatesShape,
} from "@/lib/shapes/templates"
import { SNIPPETS } from "@/lib/snippets"
import { usePreviewsReady } from "@/components/template-snapshot"
import type { TrustedTemplateRow } from "@/lib/types"
import { Time } from "@/components/time"

const STATUS: Record<
  TrustedTemplateRow["status"],
  { label: string; tone: "neutral" | "success" | "info" | "warning" | "danger" }
> = {
  pending: { label: "Waiting for review", tone: "neutral" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Not approved", tone: "warning" },
  revoked: { label: "Approval withdrawn", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
}

export function TemplatesLoading() {
  return <TemplatesView shape={useRememberedShape(templatesShape)} />
}

/**
 * The list, at the top level or inside one folder. Shared by
 * `/templates` and `/templates/folder/[id]`.
 */
export function TemplatesView({
  shape,
  data,
}: {
  shape: TemplatesShape
  data?: TemplatesData
}) {
  // The list resolves with its first cards' pictures, not before them
  // (template-snapshot.tsx), so folders and templates resolve together.
  const previews = usePreviewsReady(
    data?.error ? [] : data?.templates,
    null,
    data?.error ? undefined : data?.folders,
  )
  const loading = data === undefined || !previews

  return (
    <BoneScope id="templates" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.templates.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.templates.title}</PageTitle>
            )}
            <PageActions>
              <ApiButton snippet={SNIPPETS.templates} />
              <NewTemplateMenu folderId={null} />
            </PageActions>
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.templates.description}</PageDescription>
        </PageHeader>

        <PageBody>
          {data?.error ? (
            <PanelError title="Could not load templates" message={data.error} />
          ) : (
            <TemplateLibrary
              templates={data?.templates}
              folders={data?.folders}
              folderId={null}
              loading={loading}
              shape={shape}
            />
          )}

          {/*
           * ⚠ AFTER THE TEMPLATES, NOT BEFORE, and only at the top level. The
           * page is for the templates; where some of them come from is a
           * setting of the workspace, looked at far less often.
           */}
          {shape.github && (
            <div className="mt-4">
              <GithubPanel
                state={data?.github ?? undefined}
                loading={loading}
                shape={shape}
              />
            </div>
          )}

          <ReviewedTemplates
            rows={data?.trusted}
            loading={loading}
            count={shape.trusted ?? 1}
          />
        </PageBody>

        {data && !data.error && <RememberShape def={templatesShape} shape={shape} />}
      </Page>
    </BoneScope>
  )
}

/**
 * Templates submitted for review (#222), below the workspace's own templates.
 *
 * ⚠ A DIFFERENT THING FROM THE LIST ABOVE, AND SAID SO. Those are emails this
 * workspace keeps here and sends by id; these are emails it sends often, from
 * anywhere, that our team reviewed so their repetition stops counting against
 * it. One template can be both, and most are only one.
 *
 * ⚠ OUR NOTE IS SHOWN, because a rejection without its reason is a dead end,
 * and staff write it knowing the workspace reads it.
 */
function ReviewedTemplates({
  rows,
  loading = false,
  count = 0,
}: {
  rows?: TrustedTemplateRow[] | null
  loading?: boolean
  count: number
}) {
  if (count === 0 && (!rows || rows.length === 0)) {
    return (
      <section className="mt-10 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Reviewed for repeat sending</h2>
            <p className="max-w-prose text-xs text-muted-foreground">
              Email you send often, like password resets or receipts, can be reviewed by
              our team so that sending it many times does not count as repeated content.
              Approval never excuses bounces or spam complaints, and too many of them
              withdraw it.
            </p>
          </div>
          <SubmitTrustedTemplateButton />
        </div>

        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          Nothing submitted yet.
        </p>
      </section>
    )
  }

  return (
    <BoneScope id="trusted" loading={loading} independent>
      <section className="mt-10 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Reviewed for repeat sending</h2>
            <p className="max-w-prose text-xs text-muted-foreground">
              Email you send often, like password resets or receipts, can be reviewed by
              our team so that sending it many times does not count as repeated content.
              Approval never excuses bounces or spam complaints, and too many of them
              withdraw it.
            </p>
          </div>
          <SubmitTrustedTemplateButton />
        </div>

        <ul className="divide-y overflow-hidden rounded-2xl border">
          {Array.from({ length: loading ? count : (rows?.length ?? 0) }, (_, i) => {
            const t = loading ? undefined : rows?.[i]
            return (
              <BoneScope key={t?.id ?? i} id={`row-${i}`} unit>
                <li className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Bone id="name" lineHeight={20} width={160}>
                      {t && <p className="truncate text-sm font-medium">{t.name}</p>}
                    </Bone>
                    <Bone id="holes" lineHeight={16} width={220} className="mt-1">
                      {t && (
                        <p className="truncate text-xs text-muted-foreground">
                          {t.holes.length === 0
                            ? "No placeholders"
                            : t.holes.map((h) => `{{${h.name}}}`).join(" ")}
                          {t.decision_reason ? ` - ${t.decision_reason}` : ""}
                        </p>
                      )}
                    </Bone>
                  </div>
                  <Bone
                    id="status"
                    shape="box"
                    width={80}
                    height={20}
                    radius={9999}
                    inline
                  >
                    {t && (
                      <Badge tone={STATUS[t.status].tone}>
                        {STATUS[t.status].label}
                      </Badge>
                    )}
                  </Bone>
                  {/* ⚠ SKIPPED BY test/skeleton-parity: only an approved template has a match count, and only a live one a withdraw button; a shape does not carry statuses. */}
                  {t?.status === "approved" && (
                    <span
                      data-skeleton="skip"
                      className="tabular shrink-0 font-mono text-2xs text-muted-foreground"
                    >
                      {t.matched.toLocaleString("en")} matched
                    </span>
                  )}
                  <Bone id="time" lineHeight={16} width={60}>
                    {t && (
                      <span
                        className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
                        title={t.decided_at ?? t.submitted_at}
                      >
                        <Time iso={t.decided_at ?? t.submitted_at} />
                      </span>
                    )}
                  </Bone>
                  {t && (t.status === "pending" || t.status === "approved") && (
                    <span data-skeleton="skip" className="contents">
                      <WithdrawTrustedTemplate id={t.id} name={t.name} />
                    </span>
                  )}
                </li>
              </BoneScope>
            )
          })}
        </ul>
      </section>
    </BoneScope>
  )
}
