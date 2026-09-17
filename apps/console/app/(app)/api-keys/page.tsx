import type { Metadata } from "next"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { ApiKeysTable } from "@/components/api-keys-table"
import { CreateApiKeyButton } from "@/components/create-api-key"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import type { ApiKeyRow } from "@/lib/types"

export const metadata: Metadata = { title: "API keys" }

/**
 * The credentials a customer's servers send with.
 *
 * ⚠ THE SECRET IS SHOWN EXACTLY ONCE, AT CREATION, AND NOTHING STORES IT. The
 * API keeps a SHA-256 of the whole key including its prefix — see migration
 * 0031 — so there is no "reveal" to build even if we wanted one. The UI has to
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
  const result = await tryApi<{ data: ApiKeyRow[] }>("/console/api-keys")

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>API keys</PageTitle>
          <PageActions>
            {/*
             * ⚠ `?new=1` OPENS THE DIALOG, SO THE COMMAND MENU CAN LINK TO IT.
             * A dialog whose only trigger is a button on one page cannot be
             * reached from ⌘K, from a doc, or from an onboarding step — all
             * three of which want to say "create a key" and land somebody in
             * the form rather than next to it.
             */}
            <CreateApiKeyButton autoOpen={params.new === "1"} />
          </PageActions>
        </PageHeaderRow>
        <PageDescription>
          Keys authenticate your servers. They are shown once when created and
          stored only as a hash — if you lose one, rotate it rather than looking
          for it.
        </PageDescription>
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError title="Could not load your keys" message={result.error.message} />
        ) : (
          <ApiKeysTable keys={result.data.data} />
        )}
      </PageBody>
    </Page>
  )
}
