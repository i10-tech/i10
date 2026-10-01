import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { tryApi } from "@/lib/api"
import type { TemplateFolder } from "@/lib/types"
import { TemplatesScreen } from "@/components/templates/screen"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const folder = await folderNamed(id)
  return { title: folder ? `${folder.name} · Templates` : "Templates" }
}

async function folderNamed(id: string): Promise<TemplateFolder | null> {
  if (!UUID.test(id)) return null
  const result = await tryApi<{ folders?: TemplateFolder[] }>("/console/templates")
  return result.ok
    ? ((result.data.folders ?? []).find((f) => f.id === id) ?? null)
    : null
}

/** One folder's templates, as Resend opens a folder: the same list, scoped. */
export default async function TemplateFolderPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!UUID.test(id) || !(await folderNamed(id))) notFound()
  return <TemplatesScreen folderId={id} />
}
