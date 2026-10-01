import type { Metadata } from "next"
import { BackButton } from "@/components/back-button"
import { notFound, redirect } from "next/navigation"
import { CopyField } from "@repo/ui/components/copy"
import {
  Page,
  PageActions,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { TemplateFiles } from "@/components/template-files"
import { TemplatePreviewPanel } from "@/components/template-preview"
import { SourceBadge } from "@/components/template-source"
import { TemplateSubject } from "@/components/template-subject"
import { TemplateTabs } from "@/components/template-tabs"
import { TemplateVersions } from "@/components/template-versions"
import { Time } from "@/components/time"
import { UploadVersionButton } from "@/components/upload-templates"
import { tryApi } from "@/lib/api"
import { isEditable, titleOf } from "@/lib/templates"
import type { TemplateDetail } from "@/lib/types"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const result = await tryApi<TemplateDetail>(
    `/console/templates/${encodeURIComponent(id)}`,
  )
  return { title: result.ok ? titleOf(result.data) : "Template" }
}

/**
 * One template: its id, how to change it, how it looks, and every version.
 *
 * ⚠ THE ID IS SHOWN PROMINENTLY BECAUSE IT IS WHAT CODE REFERENCES. A template
 * is useless until somebody can paste its id into a send call, and hunting for
 * it in a URL bar is the kind of friction that makes people give up and inline
 * the HTML instead.
 *
 * ⚠ WHAT CAN BE CHANGED HERE FOLLOWS WHERE THE TEMPLATE LIVES (#234). One made
 * in the editor is edited here; an uploaded one gets a new version by upload;
 * one kept in GitHub changes only by a push, so this page offers it nothing to
 * type into that the next push would overwrite.
 */
export default async function TemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; restored?: string }>
}) {
  const { id } = await params
  const { tab, restored } = await searchParams
  const result = await tryApi<TemplateDetail>(
    `/console/templates/${encodeURIComponent(id)}`,
  )

  if (!result.ok) {
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }
  const template = result.data
  // ⚠ ONE WRITTEN HERE OPENS IN THE EDITOR, which has its preview, versions
  // and details built in; this page is for uploaded and GitHub templates.
  if (isEditable(template))
    redirect(`/templates/${encodeURIComponent(template.id)}/editor`)
  const live = template.history.find((v) => v.live)

  const preview = {
    value: "preview",
    label: "Preview",
    content: (
      <TemplatePreviewPanel
        templateId={template.id}
        history={template.history}
        imagesFrom={template.assets_origin ?? null}
      />
    ),
  }
  const versions = {
    value: "versions",
    label: `Versions${template.versions > 0 ? ` (${template.versions})` : ""}`,
    content: (
      <TemplateVersions
        templateId={template.id}
        history={template.history}
        editable={template.source === "managed"}
        imagesFrom={template.assets_origin ?? null}
        github={template.github ?? null}
      />
    ),
  }
  const tabs = [
    preview,
    versions,
    ...(live
      ? [
          {
            value: "source",
            label: "Source",
            content: <TemplateFiles templateId={template.id} number={live.number} />,
          },
        ]
      : []),
  ]

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <div className="flex min-w-0 items-center gap-3">
            <BackButton
              href={
                template.folder_id
                  ? `/templates/folder/${encodeURIComponent(template.folder_id)}`
                  : "/templates"
              }
              label="Back to templates"
            />
            <div className="min-w-0">
              <PageTitle className="truncate">{titleOf(template)}</PageTitle>
              {template.title && (
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {template.name}
                </p>
              )}
            </div>
            <SourceBadge source={template.source} />
          </div>
          {template.source === "upload" && (
            <PageActions>
              <UploadVersionButton templateId={template.id} name={template.name} />
            </PageActions>
          )}
        </PageHeaderRow>
      </PageHeader>

      <PageBody className="space-y-6">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div className="w-full max-w-md space-y-1">
            <p className="text-xs text-muted-foreground">Template ID</p>
            <CopyField value={template.id} />
          </div>
          <p className="text-xs text-muted-foreground">
            {live ? (
              <>
                v{live.number} live since <Time iso={live.created_at} mode="exact" />
              </>
            ) : (
              "Nothing live yet: sends naming this template fail until a version exists."
            )}
          </p>
        </div>

        {template.github && (
          <div className="space-y-2 text-xs text-muted-foreground">
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
            {template.github.removed && (
              <p className="rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-warning">
                The last push no longer had this file. The template still sends v
                {template.version}; add the file back, or stop sending it and delete the
                template.
              </p>
            )}
          </div>
        )}

        {template.kind === "tsx" && <TemplateSubject template={template} />}

        {/*
         * ⚠ KEYED BY `restored`, WHICH ONLY "EDIT FROM HERE" SETS. Copying a
         * version into the draft must remount the editor on the new document;
         * an ordinary save must not, or every save would throw away the
         * cursor and the undo history.
         */}
        <TemplateTabs key={restored ?? ""} initial={tab ?? ""} tabs={tabs} />
      </PageBody>
    </Page>
  )
}
