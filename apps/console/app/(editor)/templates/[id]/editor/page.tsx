import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { TemplateEditorLoader } from "@/components/template-editor/loader"
import { tryApi } from "@/lib/api"
import { isEditable, titleOf } from "@/lib/templates"
import type { DomainSummary, Me, TemplateDetail, TemplateFolder } from "@/lib/types"

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
 * The template editor (#162): Resend's layout, on a page of its own.
 *
 * ⚠ ONLY FOR TEMPLATES WRITTEN HERE. One uploaded or kept in GitHub changes by
 * its files, so it opens on its own page instead - where a push or an upload
 * is the way to change it, and nothing offers a box the next push would
 * overwrite.
 */
export default async function TemplateEditorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [result, list, domains, me] = await Promise.all([
    tryApi<TemplateDetail>(`/console/templates/${encodeURIComponent(id)}`),
    tryApi<{ folders?: TemplateFolder[] }>("/console/templates"),
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
    tryApi<Me>("/console/me"),
  ])
  if (!result.ok) {
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }
  if (!isEditable(result.data)) redirect(`/templates/${encodeURIComponent(id)}`)

  const verified = domains.ok
    ? domains.data.data
        .filter((d) => d.status === "verified" && !d.displaced_at)
        .map((d) => d.name.toLowerCase())
    : []

  return (
    <TemplateEditorLoader
      template={result.data}
      folders={list.ok ? (list.data.folders ?? []) : []}
      verified={verified}
      userEmail={me.ok ? me.data.user.email : null}
      imagesFrom={result.data.assets_origin ?? null}
    />
  )
}
