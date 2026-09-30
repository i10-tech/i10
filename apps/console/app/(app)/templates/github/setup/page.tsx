import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { Button } from "@repo/ui/components/button"
import {
  Page,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"

export const metadata: Metadata = { title: "Connecting GitHub" }

/**
 * Where GitHub sends somebody back after installing the app (#235).
 *
 * ⚠ THE BINDING HAPPENS ON THE SERVER, IN THIS RENDER, ONCE. The API checks
 * the signed `state` against the workspace signed in now, exchanges `code`
 * for the person's GitHub token, and accepts `installation_id` only if that
 * token can see it - see the API's github/connect.ts. `code` works once, so a
 * reload of this page reports an error rather than binding twice.
 */
export default async function GithubSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { installation_id, code, state, setup_action } = await searchParams

  let error: string
  if (setup_action === "request") {
    error =
      "The installation was requested from an owner of that GitHub account. Once they approve it, connect GitHub again."
  } else if (!installation_id || !code || !state) {
    error =
      "GitHub did not send back everything needed. Connect GitHub again from the templates page."
  } else {
    const result = await tryApi<{ installation_id: number; account_login: string }>(
      "/console/github/installations",
      { method: "POST", body: { installation_id, code, state } },
    )
    if (result.ok) redirect("/templates?github=connected")
    error = result.error.message
  }

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Connecting GitHub</PageTitle>
        </PageHeaderRow>
      </PageHeader>
      <PageBody className="max-w-xl space-y-4">
        <PanelError title="GitHub is not connected" message={error} />
        <Button asChild variant="outline" size="sm">
          <Link href="/templates">Back to templates</Link>
        </Button>
      </PageBody>
    </Page>
  )
}
