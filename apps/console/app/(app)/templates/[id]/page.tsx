import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { CopyField } from "@repo/ui/components/copy"
import {
  Page,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { TemplateEditor } from "@/components/template-editor"
import { tryApi } from "@/lib/api"
import type { TemplateRow } from "@/lib/types"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const result = await tryApi<TemplateRow>(
    `/console/templates/${encodeURIComponent(id)}`,
  )
  return { title: result.ok ? result.data.name : "Template" }
}

/**
 * ⚠ THE ID IS SHOWN PROMINENTLY BECAUSE IT IS WHAT CODE REFERENCES. A template
 * is useless until somebody can paste its id into a send call, and hunting for
 * it in a URL bar is the kind of friction that makes people give up and inline
 * the HTML instead.
 */
export default async function TemplatePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const result = await tryApi<TemplateRow>(
    `/console/templates/${encodeURIComponent(id)}`,
  )

  if (!result.ok) {
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }

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
            <PageTitle className="truncate font-mono">{result.data.name}</PageTitle>
          </div>
        </PageHeaderRow>
      </PageHeader>

      <PageBody className="space-y-6">
        <div className="max-w-md space-y-1">
          <p className="text-xs text-muted-foreground">Template ID</p>
          <CopyField value={result.data.id} />
        </div>

        <TemplateEditor template={result.data} />
      </PageBody>
    </Page>
  )
}
