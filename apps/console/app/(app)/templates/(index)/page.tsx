import type { Metadata } from "next"
import { Revisit } from "@/components/revisit"
import { TemplatesView } from "@/components/templates-view"
import { templatesShape } from "@/lib/shapes/templates"
import { loadTemplates } from "@/lib/templates-data"

export const metadata: Metadata = { title: "Templates" }

/** Kept for a revisit, then checked: lib/revisits.ts. */
export const unstable_dynamicStaleTime = 300

/**
 * Reusable emails, referenced by id or alias from a send - kept in folders,
 * as Resend keeps them.
 *
 * ⚠ DRAFT AND PUBLISHED ARE TWO DIFFERENT THINGS, AND EVERY CARD SAYS WHICH.
 * A template is referenced from production code that is sending mail right
 * now; editing it must not change what goes out mid-sentence. "Unpublished
 * changes" means the editor and the live version have diverged - exactly
 * the state somebody forgets they are in.
 */
export default async function TemplatesPage() {
  const data = await loadTemplates()
  return (
    <>
      <TemplatesView shape={templatesShape.of(data)} data={data} />
      <Revisit data={data} />
    </>
  )
}
