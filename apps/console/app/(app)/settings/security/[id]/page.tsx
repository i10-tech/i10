import { redirect } from "next/navigation"

export default async function SecurityConnectionRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const query = new URLSearchParams()
  for (const [key, val] of Object.entries(sp)) {
    if (val === undefined) continue
    if (Array.isArray(val)) {
      for (const v of val) query.append(key, v)
    } else {
      query.set(key, val)
    }
  }
  const qs = query.toString()
  redirect(`/settings/sso/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`)
}
