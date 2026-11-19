"use client"

import * as React from "react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { ProfileBlock, ProfileRow } from "@/components/account/shared"
import type { TeamShape } from "@/lib/shapes/team"

/**
 * The team panel before its reads have all come back: every block where the
 * loaded panel puts it (components/team-panel.tsx), drawn from the shape
 * remembered for this workspace.
 *
 * ⚠ EVERY HEIGHT HERE IS THE LOADED ONE, MEASURED, NOT GUESSED (2026-11-09).
 * The panel's blocks arrive from Clerk and four of our reads, and a skeleton
 * that was shorter than the page moved every heading below it each time one
 * landed (402px, 408px, 470px in one frame each). A list row is a `MotionItem`
 * (12px of padding around its content); the gaps are the real ones, so the
 * zero-height spacers below stand in for the `Reveal`s whose gaps still count.
 * Change a row there, change it here.
 *
 * ⚠ A LIST WITH NOTHING REMEMBERED DRAWS ONE NEUTRAL LINE, NEVER "No pending
 * invitations". That line is the empty answer, and a workspace that has
 * invitations would watch it be wrong.
 */
export function TeamSkeleton({ shape }: { shape: TeamShape }) {
  return (
    <BoneScope id="panel" loading>
      <div>
        <ProfileBlock title="Members">
          <ProfileRow label="Members">
            <div>
              <List>
                {range(shape.members).map((i) => (
                  <Item key={i} id={`member-${i}`}>
                    <MemberRow
                      manage={shape.canManage}
                      // The reader's own row, always present, is two px taller.
                      reader={i === shape.members - 1}
                    />
                  </Item>
                ))}
              </List>
            </div>
          </ProfileRow>
          {shape.canManage && (
            <ProfileRow label="Invitations">
              <div className="flex flex-col gap-1">
                {shape.capacity && (
                  <div className="pb-1">
                    <Bone id="seats" lineHeight={16} width={230} />
                  </div>
                )}
                <List>
                  {shape.invites === 0 ? (
                    <Neutral id="invites" />
                  ) : (
                    range(shape.invites).map((i) => (
                      <Item key={i} id={`invite-${i}`}>
                        <TwoLines menu />
                      </Item>
                    ))
                  )}
                </List>
                <Spacer />
                {shape.invitable && (
                  <div>
                    <Bone id="invite" shape="box" width={85} height={32} radius={8} />
                  </div>
                )}
              </div>
            </ProfileRow>
          )}
          {shape.canManage && (
            <ProfileRow label="Requests">
              <div className="flex flex-col gap-2">
                {shape.full && <Bone id="full" lineHeight={16} width="70%" />}
                <List>
                  {shape.requests === 0 ? (
                    <Neutral id="requests" />
                  ) : (
                    range(shape.requests).map((i) => (
                      <Item key={i} id={`request-${i}`}>
                        <TwoLines
                          // A request waiting for room has a badge, and its
                          // second line wraps.
                          second={i < shape.waiting ? 2 : 1}
                          badge={i < shape.waiting}
                          actions
                        />
                      </Item>
                    ))
                  )}
                </List>
              </div>
            </ProfileRow>
          )}
        </ProfileBlock>
        {shape.accessDomains && (
          <ProfileBlock title="Team access">
            <ProfileRow label="Domains">
              <div className="flex flex-col gap-3">
                {shape.suggestions > 0 && (
                  <List>
                    {range(shape.suggestions).map((i) => (
                      <Item key={i} id={`suggestion-${i}`}>
                        <Bone
                          id="card"
                          shape="box"
                          width="100%"
                          height={86}
                          radius={16}
                        />
                      </Item>
                    ))}
                  </List>
                )}
                <List>
                  {shape.domains === 0 ? (
                    <Neutral id="domains" lines={2} />
                  ) : (
                    range(shape.domains).map((i) => (
                      <Item key={i} id={`domain-${i}`}>
                        <DomainRow proof={i >= shape.domains - shape.proofs} />
                      </Item>
                    ))
                  )}
                </List>
                <Spacer />
                <div>
                  <Bone id="add" shape="box" width={129} height={32} radius={8} />
                </div>
              </div>
            </ProfileRow>
          </ProfileBlock>
        )}
        {shape.canManage && (
          <ProfileBlock title="Removed and blocked">
            <ProfileRow label="People">
              <List>
                {shape.removed === 0 ? (
                  <Neutral id="removed" />
                ) : (
                  range(shape.removed).map((i) => (
                    <Item key={i} id={`removed-${i}`}>
                      <TwoLines menu badge />
                    </Item>
                  ))
                )}
              </List>
            </ProfileRow>
          </ProfileBlock>
        )}
        <ProfileBlock title="Leave workspace">
          <ProfileRow label="Leave">
            <div className="flex items-center justify-between gap-3">
              <Bone id="note" lineHeight={20} width={380} />
              <Bone id="leave" shape="box" width={65} height={32} radius={8} inline />
            </div>
          </ProfileRow>
        </ProfileBlock>
      </div>
    </BoneScope>
  )
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

function List({ children }: { children: React.ReactNode }) {
  return (
    <ul className="flex flex-col" aria-busy>
      {children}
    </ul>
  )
}

/** A `MotionItem`'s box: its content with 6px above and below. */
function Item({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <BoneScope id={id} unit>
      <li>
        <div className="py-1.5">{children}</div>
      </li>
    </BoneScope>
  )
}

/** The line a list shows when it is empty, drawn as a bar: 38px, as the text is. */
function Neutral({ id, lines = 1 }: { id: string; lines?: number }) {
  return (
    <Item id={id}>
      <div className="pt-1.5">
        <Bone id="line" lineHeight={20} lines={lines} width="60%" />
      </div>
    </Item>
  )
}

/** A zero-height child that still takes its flex gap, as a closed `Reveal` does. */
function Spacer() {
  return <div aria-hidden className="h-0" />
}

function MemberRow({ manage, reader }: { manage: boolean; reader: boolean }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 ${reader ? "min-h-[38px]" : ""}`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <Bone id="avatar" shape="circle" width={36} inline />
        <span className="block">
          <Bone id="name" lineHeight={20} width={120} />
          <Bone id="email" lineHeight={16} width={220} />
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <Bone id="role" shape="box" width={104} height={32} radius={8} inline />
        {manage && (
          <Bone id="menu" shape="box" width={28} height={28} radius={8} inline />
        )}
      </span>
    </div>
  )
}

/** A name over a line of detail, with a menu or the request's three actions. */
function TwoLines({
  second = 1,
  menu = false,
  actions = false,
  badge = false,
}: {
  second?: 1 | 2
  menu?: boolean
  actions?: boolean
  badge?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="block min-w-0">
        {/* A badge beside the name makes that line 22px, not 20. */}
        <Bone id="name" lineHeight={badge ? 22 : 20} width={190} />
        <Bone id="detail" lineHeight={16} lines={second} width={260} />
      </span>
      {menu && <Bone id="menu" shape="box" width={28} height={28} radius={8} inline />}
      {actions && (
        <Bone id="actions" shape="box" width={240} height={32} radius={8} inline />
      )}
    </div>
  )
}

/** An access domain: its name and rules, and (waiting for a TXT proof) the record card. */
function DomainRow({ proof }: { proof: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="block min-w-0">
          <Bone id="name" lineHeight={20} width={170} />
          <Bone id="rules" lineHeight={16} width={300} />
        </span>
        <Bone id="actions" shape="box" width={96} height={32} radius={8} inline />
      </div>
      {proof ? (
        <Bone id="proof" shape="box" width="100%" height={224} radius={16} />
      ) : (
        <Spacer />
      )}
      <Spacer />
    </div>
  )
}
