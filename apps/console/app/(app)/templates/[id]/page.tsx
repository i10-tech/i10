import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { tryApi } from "@/lib/api"
import { isEditable, titleOf } from "@/lib/templates"
import type { TemplateDetail } from "@/lib/types"
import { TemplateDetailView } from "@/components/template-detail-view"
import {
  templateDetailShape,
  type TemplateDetailData,
} from "@/lib/shapes/template-detail"

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

  const data: TemplateDetailData = {
    template,
    tab,
    restored,
  }

  return <TemplateDetailView shape={templateDetailShape.of(data)} data={data} />
}
