import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { GithubSetupView } from "@/components/github-setup-view"
import { githubSetupShape, type GithubSetupData } from "@/lib/shapes/github-setup"
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

  let error: string | undefined
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

  const data: GithubSetupData = { error }
  return <GithubSetupView shape={githubSetupShape.of(data)} data={data} />
}
