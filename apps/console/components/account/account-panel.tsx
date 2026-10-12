"use client"

import { useUser } from "@clerk/nextjs"
import { Skeleton } from "@repo/ui/components/skeleton/skeleton"
import { TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs/tabs"
import { ProfileDetails } from "@/components/account/profile-details"
import { Security } from "@/components/account/security"
import { UrlTabs } from "@/components/list/url-tabs"
import type { AccountSettings } from "@/lib/clerk-environment"
import type { BillingState } from "@/lib/types"

/**
 * The account panel, ours (2026-10-12) - what Clerk's `<UserProfile />` was:
 * "Profile details" and "Security", each row drawn from Clerk's user and
 * changed through it. Clerk's original is kept at /reference/clerk/user-profile
 * to compare against.
 *
 * ⚠ TWO TABS, PROFILE AND SECURITY (2026-10-12), as Clerk's panel had two
 * pages in its own sidebar. `?tab=security` opens on the second, so a link
 * can land on it.
 */
export function AccountPanel({
  settings,
  billing,
  tab,
}: {
  /** `?tab=`, from the page. */
  tab?: string
  settings: AccountSettings
  /** For the deletion warning, shown in the delete dialog. */
  billing: BillingState | null
}) {
  const { isLoaded, user } = useUser()
  if (!isLoaded || !user) {
    return (
      <div className="space-y-3">
        <Skeleton label="Loading your account" avatar lines={3} />
      </div>
    )
  }
  return (
    <UrlTabs value={tab === "security" ? "security" : undefined} fallback="profile">
      <TabsList>
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
      </TabsList>
      <TabsContent value="profile" className="m-0 pt-6">
        <ProfileDetails user={user} providers={settings.providers} />
      </TabsContent>
      <TabsContent value="security" className="m-0 pt-6">
        <Security
          user={user}
          minLength={settings.minLength}
          passkeys={settings.passkeys}
          billing={billing}
        />
      </TabsContent>
    </UrlTabs>
  )
}
