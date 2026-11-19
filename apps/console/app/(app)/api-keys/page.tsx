import type { Metadata } from "next"
import { ApiKeysView } from "@/components/api-keys-view"
import { tryApi } from "@/lib/api"
import { apiKeysShape, type ApiKeysData } from "@/lib/shapes/api-keys"
import type { ApiKeyRow, DomainSummary } from "@/lib/types"

export const metadata: Metadata = { title: "API keys" }

/**
 * The credentials a customer's servers send with.
 *
 * ⚠ THE SECRET IS SHOWN EXACTLY ONCE, AT CREATION, AND NOTHING STORES IT. The
 * API keeps a SHA-256 of the whole key including its prefix - see migration
 * 0031 - so there is no "reveal" to build even if we wanted one. The UI has to
 * make that obvious at the moment of creation rather than leaving somebody to
 * discover it by closing the dialog.
 *
 * ⚠ AND REVOCATION IS IMMEDIATE, WHICH IS THE WHOLE REASON KEYS LEFT CLERK.
 * Revoking deletes the row AND evicts the Redis entry; without the eviction the
 * key keeps working for up to the cache TTL. The API treats a failed eviction
 * as a 500 rather than reporting success, because telling somebody a leaked
 * credential is dead when it is not is the worst possible answer here.
 */
export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>
}) {
  const params = await searchParams
  /*
   * ⚠ THE DOMAINS COME WITH THE PAGE SO THE SCOPE CONTROLS HAVE SOMETHING TO
   * OFFER. Both the create dialog and the scope editor need the list, and
   * fetching it inside each of them would put a spinner inside a dialog
   * somebody has already opened - for a list that is usually three rows long.
   *
   * ⚠ AND ITS FAILURE IS NOT THE PAGE'S FAILURE. If domains cannot be read the
   * keys still list, create and revoke; the scope control simply has nothing to
   * choose from and says so. Losing the whole page because a second, optional
   * request failed would be the worse trade.
   */
  const [result, domains] = await Promise.all([
    tryApi<{ data: ApiKeyRow[] }>("/console/api-keys"),
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
  ])
  const scopeDomains = domains.ok ? domains.data.data : []

  const data: ApiKeysData = {
    keys: result.ok ? result.data.data : [],
    domains: scopeDomains,
    newKey: params.new === "1",
    ...(result.ok ? {} : { error: result.error.message }),
  }

  return <ApiKeysView shape={apiKeysShape.of(data)} data={data} />
}
