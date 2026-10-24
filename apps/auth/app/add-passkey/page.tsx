import type { Metadata } from "next"
import { afterAuthUrl } from "../_lib/redirect"
import { AddPasskey } from "./add-passkey"

export const metadata: Metadata = { title: "Add a passkey · i10" }

export const dynamic = "force-dynamic"

/**
 * Where the console sends an owner or admin whose workspace requires SSO but
 * who signs in another way (#340, decision 7): they must hold a passkey. Adding
 * one is Clerk's frontend API, so it happens here, then the browser goes back.
 *
 * ⚠ `redirect_url` IS ATTACKER-CONTROLLABLE, so it goes through the same
 * origin-equality guard as every other destination on this app.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>
}) {
  const { redirect_url: raw } = await searchParams
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 pt-24 pb-12">
      <div className="w-full max-w-sm">
        <AddPasskey afterUrl={afterAuthUrl(raw)} />
      </div>
    </main>
  )
}
