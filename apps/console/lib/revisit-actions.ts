"use server"

import { keptPage } from "@/lib/kept-pages"
import { versionOf } from "@/lib/revisits"

/**
 * The fingerprint of a kept page's data as the server has it now, or null when
 * it cannot say (lib/revisits.ts). Read under the caller's session by the page's
 * own loader, so it tells nothing the page would not.
 *
 * ⚠ A SERVER FUNCTION, NOT A ROUTE HANDLER, BECAUSE IT RUNS IN THE PAGES' OWN
 * MODULES. A route handler is a separate bundle: in preview every fixture date
 * is computed again there, so every revisit looked changed (measured
 * 2026-11-18). It revalidates nothing, so Next keeps its cache across it.
 */
export async function readPageVersion(path: string): Promise<string | null> {
  if (!path.startsWith("/")) return null
  const url = new URL(path, "http://console")
  const page = keptPage(url.pathname)
  if (!page) return null
  try {
    // A page that is gone fingerprints as null, so the revisit refreshes into its 404.
    return versionOf((await page.load(url.searchParams)) ?? null)
  } catch {
    return null
  }
}
