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
import { TeamPanel } from "@/components/team-panel"
import { useRememberedShape } from "@/components/list/remembered-shapes"
import { teamShape, type TeamData, type TeamShape } from "@/lib/shapes/team"

export function TeamLoading() {
  return <TeamView />
}

/**
 * ⚠ THE PANEL DRAWS THE REMEMBERED SHAPE, NOT THE ONE IN `shape`. What the
 * page holds is Clerk's and ours, read in the browser, so the server has no
 * data to take a shape from and `teamShape.of(data)` is only the fallback. The
 * loading route and the loaded page both draw the remembered one, so the
 * skeleton does not change shape at the route swap.
 */
export function TeamView({ data }: { shape?: TeamShape; data?: TeamData }) {
  const loading = data === undefined
  const remembered = useRememberedShape(teamShape)
  /*
   * ⚠ CLERK'S HOOKS THROW OUTSIDE A PROVIDER, AND THE PROVIDER IS ONLY
   * MOUNTED WHEN A KEY EXISTS - see app/layout.tsx. This branch is for local
   * review with no identity provider running; every real deployment takes the
   * other one.
   */
  const clerk = useClerkEnabled()
  const noClerk = !(data?.clerkEnabled ?? clerk)

  return (
    <BoneScope id="team" loading={loading}>
      <div>
        <Section className="pt-0">
          <SectionTitle>Members</SectionTitle>
          <SectionDescription>
            {noClerk ? (
              <>
                Membership, roles and invitations live in Clerk, which is not configured
                in this environment. Set <code>CLERK_PUBLISHABLE_KEY</code> to see the
                real panel here.
              </>
            ) : (
              "Everyone here shares this workspace: its domains, its keys, its contacts and its bill. Invitations are sent by email."
            )}
          </SectionDescription>
          {!noClerk && (
            <SectionContent>
              <TeamPanel shape={remembered} loading={loading} />
            </SectionContent>
          )}
        </Section>
      </div>
    </BoneScope>
  )
}
