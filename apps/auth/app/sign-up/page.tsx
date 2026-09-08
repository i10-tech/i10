import type { Metadata } from "next"
import { afterAuthUrl } from "../_lib/redirect"
import { SignUpForm } from "./sign-up-form"

export const metadata: Metadata = { title: "Create your account · i10" }

/** Same reason as the sign-in page: the destination comes from the query. */
export const dynamic = "force-dynamic"

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
        <SignUpForm afterAuthUrl={after} signInHref={`/sign-in${carry}`} />
      </div>
    </main>
  )
}
