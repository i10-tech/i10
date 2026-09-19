import type { Metadata } from "next"
import { headers } from "next/headers"
import { auth } from "@clerk/nextjs/server"
import { ssoProviders } from "../_lib/providers"
import { passwordRules, signUpAbilities } from "../_lib/environment"
import { afterAuthUrl } from "../_lib/redirect"
import { SignUpForm } from "./sign-up-form"
import { AuthFlow } from "../_components/auth-flow"

export const metadata: Metadata = { title: "Create your account · i10" }

/** Same reason as the sign-in page: the destination comes from the query. */
export const dynamic = "force-dynamic"

/**
 * The optional steps somebody can be sent BACK to, spelled out.
 *
 * ⚠ IT IS AN ALLOW-LIST BECAUSE `?step=` ARRIVES IN A URL. Anyone can type one,
 * and the value picks which branch of the flow renders — so it is checked
 * against the three steps that are legitimately resumable rather than cast. The
 * account-building steps are deliberately absent: resuming onto "verify" with a
 * session but no sign-up attempt would render a code box with nothing to check
 * the code against.
 */
const RESUMABLE = ["passkey", "totp-offer", "connect"] as const
type Resumable = (typeof RESUMABLE)[number]

function resumable(value: string | string[] | undefined): Resumable | undefined {
  return RESUMABLE.find((step) => step === value)
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[]; step?: string | string[] }>
}) {
  const { redirect_url: raw, step } = await searchParams
  const after = afterAuthUrl(raw)
  const carry =
    typeof raw === "string" ? `?redirect_url=${encodeURIComponent(raw)}` : ""

  /*
   * ⚠ ASKED HERE SO THE FIRST PAINT IS THE RIGHT STEP. The connect step sends
   * the browser out to Google and it comes back as a full page load with every
   * piece of React state gone. Deciding in the browser means rendering "What is
   * your name?" and correcting it a frame later, to somebody who finished
   * signing up a minute ago.
   */
  const { userId } = await auth()

  /*
   * ⚠ BOTH OF THESE READ THE SAME CLERK ENVIRONMENT DOCUMENT AND COST ONE
   * REQUEST. Next dedupes identical `fetch`es within a render pass — see
   * _lib/environment.ts, which owns the fetch and its cache.
   *
   * ⚠ AND THEY ARE ASKED SERVER SIDE SO THE STEP COUNT IS RIGHT ON THE FIRST
   * PAINT. Deciding in the browser would draw a progress bar with seven
   * segments and then re-segment it to five, under somebody who has already
   * started counting.
   */
  const [providers, abilities, password] = await Promise.all([
    ssoProviders((await headers()).get("user-agent")),
    signUpAbilities(),
    /*
     * ⚠ THE THIRD READ OF THE SAME DOCUMENT, AND STILL ONE REQUEST. What this
     * instance will accept as a password is a property of the instance, so the
     * hint under the box and the rule the submit button enforces both come from
     * Clerk rather than from a constant that was wrong — it said eight
     * characters against an instance requiring fifteen.
     */
    passwordRules(),
  ])

  /*
   * ⚠ A STEP IS ONLY HONOURED WITH A SESSION AND WITH THE ABILITY BEHIND IT.
   * `?step=totp-offer` from an instance with two-factor switched off would open
   * a screen whose button Clerk refuses — so the allow-list above is checked
   * against what this instance can actually do, not just against the spelling.
   */
  const wanted = userId ? resumable(step) : undefined
  const startAt =
    (wanted === "passkey" && abilities.passkey) ||
    (wanted === "totp-offer" && abilities.totp) ||
    (wanted === "connect" && providers.length > 0)
      ? wanted
      : undefined

  /*
   * ⚠ WITHOUT A STEP TO RESUME, THIS IS THE SAME PAGE AS `/sign-in`. There is
   * one box and it decides: a known address goes to a password, an unknown one
   * starts here. Keeping a second URL that asks the question from the other
   * side would put the dead end back — a returning customer arriving on
   * `/sign-up` being told their address is taken — for a distinction the
   * lookup already makes better than they can.
   *
   * ⚠ BUT THE RESUME PATH IS NOT THAT PAGE, AND MUST NOT BECOME IT. Coming
   * back from a provider with `?step=connect` means the account already exists
   * and there is a half-finished flow to re-enter; asking such a person for an
   * email address would be asking them to sign up twice.
   */
  if (!startAt) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <AuthFlow
            afterAuthUrl={after}
            resetHref={`/reset-password${carry}`}
            mfaHref={`/mfa${carry}`}
            redirectRaw={typeof raw === "string" ? raw : undefined}
            providers={providers}
            abilities={abilities}
            password={password}
          />
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <SignUpForm
          afterAuthUrl={after}
          signInHref={`/sign-in${carry}`}
          redirectRaw={typeof raw === "string" ? raw : undefined}
          providers={providers}
          abilities={abilities}
          password={password}
          startAt={startAt}
          alreadySignedIn={Boolean(userId) && startAt === undefined}
        />
      </div>
    </main>
  )
}
