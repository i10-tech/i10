import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Revisit } from "@/components/revisit"
import { TemplateFolderView } from "@/components/template-folder-view"
import { templateFolderShape } from "@/lib/shapes/template-folder"
import { loadTemplateFolder, templateFolderNamed } from "@/lib/templates-data"

/** Kept for a revisit, then checked: lib/revisits.ts. */
export const unstable_dynamicStaleTime = 300

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const folder = await templateFolderNamed(id)
  return { title: folder ? `${folder.name} · Templates` : "Templates" }
}

/** One folder's templates, as Resend opens a folder: the same list, scoped. */
export default async function TemplateFolderPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await loadTemplateFolder(id)
  if (!data) notFound()

  return (
    <>
      <TemplateFolderView
        shape={templateFolderShape(id).of(data)}
        data={data}
        folderId={id}
      />
      <Revisit data={data} />
    </>
  )
}
