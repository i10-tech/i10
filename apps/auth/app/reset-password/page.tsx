import type { Metadata } from "next"
import { passwordRules } from "../_lib/environment"
import { afterAuthUrl } from "../_lib/redirect"
import { ResetPasswordForm } from "./reset-password-form"

export const metadata: Metadata = { title: "Reset your password · i10" }

export const dynamic = "force-dynamic"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>
}) {
  const { redirect_url: raw } = await searchParams
  /*
   * ⚠ THE SAME NUMBERS THE SIGN-UP PAGE READS, AND THIS FORM HAD NONE. It said
   * "At least 8 characters." in a hint typed by hand, while the instance was
   * configured to require fifteen — so somebody resetting their password was
   * invited to choose one Clerk would then refuse, two seconds later, from a
   * server. That is the exact failure `passwordRules` exists to prevent, and
   * the page that fixed it was not the only page asking for a password.
   */
  const policy = await passwordRules()
  const after = afterAuthUrl(raw)
  const carry =
    typeof raw === "string" ? `?redirect_url=${encodeURIComponent(raw)}` : ""

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <ResetPasswordForm
          afterAuthUrl={after}
          signInHref={`/sign-in${carry}`}
          passwordPolicy={policy}
        />
      </div>
    </main>
  )
}
