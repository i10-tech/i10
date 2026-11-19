import type { Metadata } from "next"
import { AccountView } from "@/components/account-view"
import { accountSettings } from "@/lib/clerk-environment"
import { tryApi } from "@/lib/api"
import { accountShape, type AccountData } from "@/lib/shapes/account"
import type { Me } from "@/lib/types"

export const metadata: Metadata = { title: "Profile" }

/**
 * Your own account: name, email, password, MFA, passkeys and active sessions.
 *
 * ⚠ ALL OF IT IS CLERK'S, AND THAT IS THE CORRECT DIVISION. Identity is Clerk's
 * job in this product - the API verifies Clerk sessions and `authd` delegates
 * LDAP binds to Clerk. Building our own password form would mean a second place
 * credentials are handled, which is one more place to get wrong than zero.
 *
 * ⚠ AND IT IS PER-PERSON, NOT PER-WORKSPACE. Somebody in three workspaces has
 * one account and one password; this page does not change when they switch
 * organization, which is why it sits under Account rather than under Settings.
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  // See settings/team: Clerk's components need their provider, and the provider
  // is only mounted when a publishable key exists.
  const clerkEnabled = Boolean(process.env.CLERK_PUBLISHABLE_KEY)

  if (!clerkEnabled) {
    const noClerkData: AccountData = {
      settings: { providers: [], passkeys: false, minLength: 8 },
      billing: null,
      clerkEnabled: false,
    }
    return <AccountView shape={accountShape.of(noClerkData)} data={noClerkData} />
  }

  /*
   * ⚠ READ ONLY TO WARN, AND A FAILURE IS NOT FATAL TO THE PAGE. Clerk's panel
   * is the point of this screen and renders perfectly well without knowing what
   * anybody pays; `DeletionWarning` falls back to the wording that is true of
   * everybody when the plan cannot be read, rather than leaving the page blank
   * over a billing query.
   */
  const [me, settings, params] = await Promise.all([
    tryApi<Me>("/console/me"),
    accountSettings(),
    searchParams,
  ])

  const data: AccountData = {
    settings,
    billing: me.ok ? me.data.billing : null,
    tab: params.tab,
    clerkEnabled: true,
  }

  return <AccountView shape={accountShape.of(data)} data={data} />
}
