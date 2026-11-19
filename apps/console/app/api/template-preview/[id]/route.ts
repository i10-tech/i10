/*
 * A template's draft, filled as a test email would be, as a GET the browser
 * can keep (#248). The thumbnails and the folder papers draw from it.
 *
 * ⚠ A GET, NOT THE SERVER ACTION IT REPLACES. An action is a POST, which a
 * browser never caches, so every visit to the list fetched every picture again.
 * Here the URL names the edit (`v`, the template's `updated_at`) and the
 * workspace (`w`), so one URL is one picture for ever and the browser may keep
 * it.
 *
 * ⚠ `immutable` ONLY WHEN THE PICTURE IS PROVEN TO BE THE ONE THE URL NAMES.
 * The caller learned `v` from a list that may be a little old; if the draft has
 * moved on since, the answer is the newer edit under the older edit's URL, and
 * caching that for a year would pin it. So the API reports the stamp it read
 * the draft at, and the header is `immutable` only when that equals `v`. A
 * shared template has no stamp (it changes with a deploy), so it is never
 * kept.
 *
 * ⚠ `w` IS CHECKED AGAINST THE SESSION, NOT TRUSTED. It exists so a cached
 * picture can never be served to another workspace signed in on the same
 * browser; a URL naming a workspace other than the session's is answered but
 * not kept.
 */

import { auth } from "@clerk/nextjs/server"
import { api, ApiRequestError } from "@/lib/api"
import { PREVIEW } from "@/lib/preview"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const KEEP = "private, max-age=31536000, immutable"
const DROP = "private, no-store"

/** What a session with no active organization is called, here and in the thumbnail. */
const PERSONAL = "personal"

interface DraftPreview {
  html: string | null
  subject: string | null
  text: string | null
  stamp?: string | null
}

const reply = (body: unknown, status: number, cache: string) =>
  Response.json(body, { status, headers: { "Cache-Control": cache } })

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!UUID.test(id)) return reply({ error: "not_found" }, 404, DROP)

  const url = new URL(request.url)
  const v = url.searchParams.get("v")
  const w = url.searchParams.get("w")

  try {
    // ⚠ `api()` SERVES THE FIXTURE IN PREVIEW MODE and forwards the session
    // otherwise, so neither is repeated here.
    const draft = await api<DraftPreview>(
      `/console/templates/${id}/draft-preview`,
    )
    const body = { html: draft.html, subject: draft.subject, text: draft.text }
    if (PREVIEW) return reply(body, 200, DROP)

    const session = await auth()
    const same =
      v !== null && draft.stamp != null && draft.stamp === v && w === (session.orgId ?? PERSONAL)
    return reply(body, 200, same ? KEEP : DROP)
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.status === 401) return reply({ error: "unauthorized" }, 401, DROP)
      if (error.status === 404) return reply({ error: "not_found" }, 404, DROP)
    }
    return reply({ error: "unavailable" }, 502, DROP)
  }
}
