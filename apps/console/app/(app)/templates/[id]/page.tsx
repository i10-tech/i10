import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { CopyField } from "@repo/ui/components/copy"
import {
  Page,
  PageActions,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { TemplateEditor } from "@/components/template-editor"
import { TemplateFiles } from "@/components/template-files"
import { TemplatePreviewPanel } from "@/components/template-preview"
import { SourceBadge } from "@/components/template-source"
import { TemplateSubject } from "@/components/template-subject"
import { TemplateTabs } from "@/components/template-tabs"
import { TemplateVersions } from "@/components/template-versions"
import { Time } from "@/components/time"
import { UploadVersionButton } from "@/components/upload-templates"
import { VisualTemplateEditor } from "@/components/visual-template-editor"
import { tryApi } from "@/lib/api"
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
  return { title: result.ok ? result.data.name : "Template" }
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
      />
    ),
  }
  const tabs =
    template.kind === "html" || template.kind === "visual"
      ? [
          {
            value: "editor",
            label: "Editor",
            content:
              template.kind === "visual" ? (
                <VisualTemplateEditor template={template} />
              ) : (
                <TemplateEditor template={template} />
              ),
          },
          preview,
          versions,
        ]
      : [
          preview,
          versions,
          ...(live
            ? [
                {
                  value: "source",
                  label: "Source",
                  content: (
                    <TemplateFiles templateId={template.id} number={live.number} />
                  ),
                },
              ]
            : []),
        ]

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon-sm"
              asChild
              aria-label="Back to templates"
            >
              <Link href="/templates">
                <ArrowLeft />
              </Link>
            </Button>
            <PageTitle className="truncate font-mono">{template.name}</PageTitle>
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
