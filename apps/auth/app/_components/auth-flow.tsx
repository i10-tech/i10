"use client"

import { useState } from "react"
import type { SsoProvider } from "../_lib/providers"
import type { PasswordRules, SignUpAbilities } from "../_lib/environment"
import { SignInForm } from "../sign-in/sign-in-form"
import { SignUpForm } from "../sign-up/sign-up-form"

/**
 * One box, both doors.
 *
 * ⚠ TWO PAGES ASKED THE SAME QUESTION AND MADE THE PERSON PICK THE DOOR FIRST,
 * which is a decision only WE can answer. "Do you already have an account" is a
 * lookup, and putting it to somebody who has half-forgotten produces the worst
 * outcome in either direction: a returning customer on the sign-up page told
 * their address is taken, or a new one on the sign-in page told there is no
 * such account. Both are dead ends reached by answering honestly.
 *
 * ⚠ SO THE ADDRESS DECIDES, AND IT IS ASKED ONCE. `signIn.create({ identifier })`
 * is the lookup — it is what the sign-in form already did to find out which
 * factors exist — and its `form_identifier_not_found` is simply the other
 * answer. Known goes on to a password; unknown starts a sign-up with the
 * address already filled in.
 *
 * ⚠ AND ONE SET OF PROVIDER BUTTONS, SAYING "CONTINUE WITH", NOT TWO SAYING
 * "SIGN IN WITH" AND "SIGN UP WITH". They were always the same button: Clerk's
 * SSO callback transfers an unrecognised provider account into a sign-up by
 * itself, so the label was the only thing that ever differed — and it was
 * asking the person to predict the outcome of a lookup they cannot perform.
 *
 * ⚠ THE BRANCH LIVES HERE RATHER THAN IN EITHER FORM, so neither imports the
 * other. They are 600 and 800 lines and each owns a real state machine; having
 * one render the other for a decision neither of them makes would tangle both.
 */
export function AuthFlow({
  afterAuthUrl,
  resetHref,
  mfaHref,
  redirectRaw,
  providers,
  abilities,
  password,
}: {
  afterAuthUrl: string
  resetHref: string
  mfaHref: string
  redirectRaw?: string
  providers: SsoProvider[]
  abilities: SignUpAbilities
  password: PasswordRules
}) {
  /*
   * ⚠ `null` UNTIL THE LOOKUP ANSWERS, AND THE ADDRESS IS THE STATE. Holding a
   * mode flag beside the email would be two facts that can disagree; the
   * address IS the answer, so its presence is the mode.
   */
  const [newAccount, setNewAccount] = useState<string | null>(null)

  if (newAccount !== null) {
    return (
      <SignUpForm
        afterAuthUrl={afterAuthUrl}
        /*
         * ⚠ STILL A WAY BACK, EVEN THOUGH THE PERSON DID NOT CHOOSE THIS DOOR.
         * The lookup decided for them, and a lookup can be wrong about what
         * somebody meant — a typo in the address lands here looking exactly
         * like a new customer.
         */
        signInHref="/sign-in"
        redirectRaw={redirectRaw}
        providers={providers}
        abilities={abilities}
        password={password}
        initialEmail={newAccount}
        alreadySignedIn={false}
      />
    )
  }

  return (
    <SignInForm
      afterAuthUrl={afterAuthUrl}
      resetHref={resetHref}
      mfaHref={mfaHref}
      redirectRaw={redirectRaw}
      providers={providers}
      onUnknownIdentifier={setNewAccount}
    />
  )
}
