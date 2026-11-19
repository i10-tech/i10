"use client"

import { useUser } from "@clerk/nextjs"
import { TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs/tabs"
import { Bone } from "@repo/ui/components/bone/bone"
import { ProfileDetails } from "@/components/account/profile-details"
import { Security } from "@/components/account/security"
import { ProfileBlock, ProfileRow } from "@/components/account/shared"
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
  loading: loadingProp = false,
}: {
  /** `?tab=`, from the page. */
  tab?: string
  settings?: AccountSettings
  /** For the deletion warning, shown in the delete dialog. */
  billing: BillingState | null
  loading?: boolean
}) {
  const { isLoaded, user } = useUser()
  const loading = loadingProp || !isLoaded || !user

  const activeTab = tab === "security" ? "security" : "profile"

  if (loading) {
    return (
      <UrlTabs value={activeTab} fallback="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="m-0 pt-6">
          <div className="space-y-6">
            <ProfileBlock title="Profile">
              <ProfileRow label="Profile">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <Bone id="avatar" shape="circle" width={48} height={48} inline />
                    <div className="space-y-1">
                      <Bone id="name" width={140} lineHeight={20} />
                      <Bone id="email" width={180} lineHeight={16} />
                    </div>
                  </span>
                  <Bone
                    id="edit-btn"
                    shape="box"
                    width={90}
                    height={28}
                    radius={6}
                    inline
                  />
                </div>
              </ProfileRow>
              <ProfileRow label="Email addresses">
                <div className="flex items-center justify-between">
                  <Bone id="emails" width={200} lineHeight={20} />
                  <Bone
                    id="add-email"
                    shape="box"
                    width={80}
                    height={28}
                    radius={6}
                    inline
                  />
                </div>
              </ProfileRow>
            </ProfileBlock>
          </div>
        </TabsContent>
        <TabsContent value="security" className="m-0 pt-6">
          <div className="space-y-6">
            <ProfileBlock title="Sign-in">
              <ProfileRow label="Password">
                <div className="flex items-center justify-between">
                  <Bone id="pwd" width={100} lineHeight={20} />
                  <Bone
                    id="pwd-btn"
                    shape="box"
                    width={80}
                    height={28}
                    radius={6}
                    inline
                  />
                </div>
              </ProfileRow>
              <ProfileRow label="Passkeys">
                <div className="flex items-center justify-between">
                  <Bone id="passkeys" width={140} lineHeight={20} />
                  <Bone
                    id="passkeys-btn"
                    shape="box"
                    width={90}
                    height={28}
                    radius={6}
                    inline
                  />
                </div>
              </ProfileRow>
            </ProfileBlock>
            <ProfileBlock title="Active devices">
              <ProfileRow label="Devices">
                <div className="space-y-2">
                  <Bone id="device-1" width={180} lineHeight={20} />
                  <Bone id="device-2" width={150} lineHeight={20} />
                </div>
              </ProfileRow>
            </ProfileBlock>
          </div>
        </TabsContent>
      </UrlTabs>
    )
  }

  return (
    <UrlTabs value={tab === "security" ? "security" : undefined} fallback="profile">
      <TabsList>
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
      </TabsList>
      <TabsContent value="profile" className="m-0 pt-6">
        <ProfileDetails user={user} providers={settings?.providers ?? []} />
      </TabsContent>
      <TabsContent value="security" className="m-0 pt-6">
        <Security
          user={user}
          minLength={settings?.minLength ?? 8}
          passkeys={settings?.passkeys ?? false}
          billing={billing}
        />
      </TabsContent>
    </UrlTabs>
  )
}
