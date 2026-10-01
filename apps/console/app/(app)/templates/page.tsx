import type { Metadata } from "next"
import { TemplatesScreen } from "@/components/templates/screen"

export const metadata: Metadata = { title: "Templates" }

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
  return <TemplatesScreen folderId={null} />
}
