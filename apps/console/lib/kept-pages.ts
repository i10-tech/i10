import "server-only"
import { loadTemplateFolder, loadTemplates } from "@/lib/templates-data"

/**
 * Every page that renders `<Revisit>`, with the loader it draws from, for the
 * revisit check (lib/revisit-actions.ts, lib/revisits.ts).
 *
 * ⚠ THE SAME LOADER THE PAGE CALLS. A different read would fingerprint other
 * data, and the page would refresh on every revisit or never.
 * test/revisit-pages.test.ts holds this list and the pages together.
 */
export const KEPT_PAGES: {
  route: string
  load: (params: Record<string, string>, search: URLSearchParams) => Promise<unknown>
}[] = [
  { route: "/templates", load: () => loadTemplates() },
  { route: "/templates/folder/[id]", load: ({ id }) => loadTemplateFolder(id!) },
]

const COMPILED = KEPT_PAGES.map((page) => {
  const names: string[] = []
  const source = page.route.replace(/\[(\w+)\]/g, (_, name: string) => {
    names.push(name)
    return "([^/]+)"
  })
  return { ...page, pattern: new RegExp(`^${source}$`), names }
})

/** The kept page at `pathname` and its params, or null. */
export function keptPage(pathname: string) {
  for (const page of COMPILED) {
    const found = page.pattern.exec(pathname)
    if (!found) continue
    const params = Object.fromEntries(
      page.names.map((name, i) => [name, decodeURIComponent(found[i + 1]!)]),
    )
    return { load: (search: URLSearchParams) => page.load(params, search) }
  }
  return null
}
