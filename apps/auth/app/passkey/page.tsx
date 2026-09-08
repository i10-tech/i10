import type { Metadata } from "next"
import { afterAuthUrl } from "../_lib/redirect"
import { PasskeyPrompt } from "./passkey-prompt"

export const metadata: Metadata = { title: "Sign in with a passkey · i10" }

export const dynamic = "force-dynamic"

/** Re-validates `redirect_url` itself — see the MFA page on why. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>
}) {
  const { redirect_url: raw } = await searchParams
  const after = afterAuthUrl(raw)
  const carry =
    typeof raw === "string" ? `?redirect_url=${encodeURIComponent(raw)}` : ""

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <PasskeyPrompt afterAuthUrl={after} signInHref={`/sign-in${carry}`} />
      </div>
    </main>
  )
}
