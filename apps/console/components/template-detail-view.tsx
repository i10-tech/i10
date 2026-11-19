"use client"

import * as React from "react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import {
  Page,
  PageActions,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { Upload } from "lucide-react"
import { BackButton } from "@/components/back-button"
import { RememberShape, useRecordShape } from "@/components/list/remembered-shapes"
import { TemplateFiles } from "@/components/template-files"
import { TemplatePreviewPanel } from "@/components/template-preview"
import { SourceBadge } from "@/components/template-source"
import { TemplateSubject } from "@/components/template-subject"
import { TemplateTabs } from "@/components/template-tabs"
import { TemplateVersions } from "@/components/template-versions"
import { Time } from "@/components/time"
import { UploadVersionButton } from "@/components/upload-templates"
import { titleOf } from "@/lib/templates"
import {
  templateDetailShape,
  type TemplateDetailData,
  type TemplateDetailShape,
} from "@/lib/shapes/template-detail"

export function TemplateDetailLoading() {
  const shape = useRecordShape(templateDetailShape)
  return <TemplateDetailView shape={shape} />
}

export function TemplateDetailView({
  shape,
  data,
}: {
  shape: TemplateDetailShape
  data?: TemplateDetailData
}) {
  const loading = data === undefined
  const template = data?.template
  const live = template?.history.find((v) => v.live)

  // ⚠ THE SAME TABS WHILE LOADING, from the shape: their labels are known. What
  // a tab holds is the template's own, so each is one Bone as tall as it usually is.
  const body = (value: string, height: number, content?: React.ReactNode) => (
    <Bone
      id={`tab-${value}`}
      as="div"
      shape="box"
      width="100%"
      height={height}
      radius={8}
    >
      {content}
    </Bone>
  )
  const versionsLabel = (n: number) => `Versions${n > 0 ? ` (${n})` : ""}`
  const tabs = [
    {
      value: "preview",
      label: "Preview",
      content: body(
        "preview",
        500,
        template && (
          <TemplatePreviewPanel
            templateId={template.id}
            history={template.history}
            imagesFrom={template.assets_origin ?? null}
          />
        ),
      ),
    },
    {
      value: "versions",
      label: versionsLabel(template ? template.versions : shape.versions),
      content: body(
        "versions",
        Math.max(1, shape.versions) * 64,
        template && (
          <TemplateVersions
            templateId={template.id}
            history={template.history}
            editable={template.source === "managed"}
            imagesFrom={template.assets_origin ?? null}
            github={template.github ?? null}
          />
        ),
      ),
    },
    ...(shape.live
      ? [
          {
            value: "source",
            label: "Source",
            content: body(
              "source",
              380,
              template && live && (
                <TemplateFiles templateId={template.id} number={live.number} />
              ),
            ),
          },
        ]
      : []),
  ]

  return (
    <BoneScope id="template-detail" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            <div className="flex min-w-0 items-center gap-3">
              <BackButton
                href={
                  shape.folder && template?.folder_id
                    ? `/templates/folder/${encodeURIComponent(template.folder_id)}`
                    : "/templates"
                }
                label="Back to templates"
              />
              <div className="min-w-0">
                <Bone id="title" lineHeight={28} width={220} inline>
                  {template && (
                    <PageTitle className="truncate">{titleOf(template)}</PageTitle>
                  )}
                </Bone>
                {(shape.kind === "html" || shape.titled) && (
                  <Bone id="name" lineHeight={16} width={120} className="mt-0.5">
                    {template?.title && (
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {template.name}
                      </p>
                    )}
                  </Bone>
                )}
              </div>
              <Bone id="source" shape="box" width={76} height={22} radius={9999} inline>
                <SourceBadge source={shape.source} />
              </Bone>
            </div>
            {shape.source === "upload" && (
              <PageActions>
                {template ? (
                  <UploadVersionButton templateId={template.id} name={template.name} />
                ) : (
                  <Button size="sm" variant="secondary" disabled>
                    <Upload />
                    Upload new version
                  </Button>
                )}
              </PageActions>
            )}
          </PageHeaderRow>
        </PageHeader>

        <PageBody className="space-y-6">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div className="w-full max-w-md space-y-1">
              <p className="text-xs text-muted-foreground">Template ID</p>
              <Bone id="id" as="div" shape="box" width="100%" height={36} radius={8}>
                {template && <CopyField value={template.id} />}
              </Bone>
            </div>
            <div className="text-xs text-muted-foreground">
              {shape.live ? (
                <Bone id="live-line" lineHeight={16} width={220}>
                  {live && (
                    <>
                      v{live.number} live since{" "}
                      <Time iso={live.created_at} mode="exact" />
                    </>
                  )}
                </Bone>
              ) : (
                <p>
                  Nothing live yet: sends naming this template fail until a version
                  exists.
                </p>
              )}
            </div>
          </div>

          {shape.github && (
            <div className="space-y-2 text-xs text-muted-foreground">
              <Bone id="github-repo" as="div" lineHeight={16} width={280}>
                {template?.github && (
                  <p>
                    Kept in{" "}
                    <a
                      href={`https://github.com/${template.github.repository}/blob/${live?.commit_sha ?? "HEAD"}/${[template.github.directory, template.github.path].filter(Boolean).join("/")}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-foreground underline-offset-4 hover:underline"
                    >
                      {template.github.repository}/
                      {[template.github.directory, template.github.path]
                        .filter(Boolean)
                        .join("/")}
                    </a>
                    . A push to its target branch makes a new version and puts it live.
                  </p>
                )}
              </Bone>
              {shape.removed && (
                <p className="rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-warning">
                  The last push no longer had this file. The template still sends v
                  {template?.version ?? ""}; add the file back, or stop sending it and
                  delete the template.
                </p>
              )}
            </div>
          )}

          {shape.kind === "tsx" && (
            <Bone id="subject" as="div" shape="box" width="100%" height={48} radius={8}>
              {template && <TemplateSubject template={template} />}
            </Bone>
          )}

          {/*
           * ⚠ KEYED BY `restored`, WHICH ONLY "EDIT FROM HERE" SETS. Copying a
           * version into the draft must remount the editor on the new document;
           * an ordinary save must not, or every save would throw away the
           * cursor and the undo history.
           */}
          <TemplateTabs
            key={data?.restored ?? ""}
            initial={data?.tab ?? shape.tab}
            tabs={tabs}
          />
        </PageBody>

        {data && <RememberShape def={templateDetailShape} shape={shape} />}
      </Page>
    </BoneScope>
  )
}
