import { afterAuthUrl } from "../_lib/redirect"
import { SsoCallback } from "./sso-callback"

export const dynamic = "force-dynamic"

/**
 * ⚠ THE DESTINATION IS CARRIED HERE IN THE QUERY, because an OAuth provider
 * returns the browser to a bare URL and remembers nothing of ours. The buttons
 * append the ORIGINAL `redirect_url` to this page's address, and it is
 * re-validated here against the allowlist like everywhere else — a destination
 * that has been through a third party's redirect is exactly the one not to
 * trust on sight.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[]; reconnected?: string }>
}) {
  const { redirect_url: raw, reconnected } = await searchParams

  return (
    <SsoCallback afterAuthUrl={afterAuthUrl(raw)} reconnected={reconnected === "1"} />
  )
}
