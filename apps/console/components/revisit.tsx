import { RevisitCheck } from "@/components/revisit-check"
import { versionOf } from "@/lib/revisits"

/**
 * Rendered by a page Next keeps for a revisit (lib/revisits.ts), with the data
 * it drew. Draws nothing.
 *
 * ⚠ THE PAGE MUST ALSO BE LISTED IN lib/kept-pages.ts, WITH THE LOADER IT DRAWS
 * FROM, and export `unstable_dynamicStaleTime`; test/revisit-pages.test.ts
 * fails a page that does not.
 */
export function Revisit({ data }: { data: unknown }) {
  return <RevisitCheck version={versionOf(data)} rendered={crypto.randomUUID()} />
}
