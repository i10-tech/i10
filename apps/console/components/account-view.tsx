"use client"

import { useClerkEnabled } from "@/lib/clerk-enabled"
import * as React from "react"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { BoneScope } from "@repo/ui/components/bone/bone"
import { AccountPanel } from "@/components/account/account-panel"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import { accountShape, type AccountData, type AccountShape } from "@/lib/shapes/account"

export function AccountLoading() {
  return <AccountView shape={useRememberedShape(accountShape)} />
}

export function AccountView({
  shape,
  data,
}: {
  shape: AccountShape
  data?: AccountData
}) {
  const loading = data === undefined
  const clerk = useClerkEnabled()
  const noClerk = !(data?.clerkEnabled ?? clerk)

  return (
    <BoneScope id="account" loading={loading}>
      <div>
        <Section className="pt-0">
          <SectionTitle>Your account</SectionTitle>
          <SectionDescription>
            {noClerk ? (
              <>
                Your profile, password, two-factor authentication and active sessions
                are managed by Clerk, which is not configured in this environment. Set{" "}
                <code>CLERK_PUBLISHABLE_KEY</code> to see the real panel here.
              </>
            ) : (
              "Your name, sign-in methods, two-factor authentication and the devices you are signed in on. This is your account across every workspace you belong to."
            )}
          </SectionDescription>
          {!noClerk && (
            <SectionContent className="space-y-4">
              {/*
               * ⚠ OURS SINCE 2026-10-12, NOT CLERK'S `<UserProfile />`. Same rows,
               * same actions, our fields and motion - see components/account.
               * Clerk's original is at /reference/clerk/user-profile.
               */}
              <AccountPanel
                settings={data?.settings}
                billing={data?.billing ?? null}
                tab={shape.tab}
                loading={loading}
              />
            </SectionContent>
          )}
        </Section>
      </div>
      {data && <RememberShape def={accountShape} shape={shape} />}
    </BoneScope>
  )
}
