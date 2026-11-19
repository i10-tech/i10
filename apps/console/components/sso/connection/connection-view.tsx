"use client"

import * as React from "react"
import { Bone } from "@repo/ui/components/bone/bone"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import type { SsoConnectionShape } from "@/lib/shapes/sso-connection"
import { SettingsGroup } from "../settings-card"
import { Bypass } from "./bypass"
import { DeleteDraft } from "./delete-draft"
import { DomainsRow } from "./domains-row"
import { Enforcement } from "./enforcement"
import { GroupRulesGroup } from "./group-rules-group"
import { Header } from "./header"
import { MailSignIn, type MailSignInInitial } from "./mail-sign-in"
import { NewPeopleGroup } from "./new-people-group"
import { ProviderSettings } from "./provider-settings"
import { SessionsGroup } from "./sessions-group"
import { SetupLinksRow } from "./setup-links-row"
import { TestSection } from "./test-section"
import { UniversalLogoutRow } from "./universal-logout-row"

/**
 * What the skeleton draws a connection from: the shape's facts and nothing else.
 *
 * ⚠ EVERY PIECE THE STAND-IN COULD GET WRONG IS INSIDE A BONE. It carries only
 * what picks a component's structure (protocol, provider, status); the rest is
 * the quietest value, and a bone covers it, so it is never read as the answer.
 */
function standIn(shape: SsoConnectionShape): SsoConnection {
  return {
    id: "",
    name: "",
    protocol: shape.protocol,
    provider: shape.provider,
    status: shape.status,
    enforcement: "off",
    jitEnabled: false,
    mfaRequired: false,
    relink: "ask",
    upnAsEmail: false,
    maxSessionSeconds: null,
    idleTimeoutSeconds: null,
    attributeMapping: {},
    domains: [],
  }
}

export function ConnectionView({
  initial,
  mail,
  abilities,
  authOrigin,
  clerkEnabled,
  loading = false,
  shape,
}: {
  /** Absent while loading: the same page, drawn from `shape` with a bar for each piece. */
  initial?: SsoConnection
  /** The mail sign-in section's first reads; absent while loading. */
  mail?: MailSignInInitial
  abilities: SsoAbilities
  authOrigin: string | null
  clerkEnabled: boolean
  loading?: boolean
  shape: SsoConnectionShape
}) {
  // The loading view and the loaded page are separate instances, so the
  // loaded one always starts from its `initial`.
  const [saved, setConnection] = React.useState<SsoConnection | undefined>(initial)
  const connection = saved ?? standIn(shape)

  const onChange = React.useCallback((next: SsoConnection) => setConnection(next), [])

  return (
    // ⚠ INERT WHILE A SKELETON: its controls would act on a connection with no id.
    <div className="space-y-8 pb-12" inert={loading || undefined}>
      <Header
        connection={connection}
        abilities={abilities}
        authOrigin={authOrigin}
        onChange={onChange}
      />

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Who can sign in</h3>
        <SettingsGroup>
          <DomainsRow
            connection={connection}
            abilities={abilities}
            onChange={onChange}
          />
          <Enforcement
            connection={connection}
            abilities={abilities}
            onChange={onChange}
          />
        </SettingsGroup>
        <Bypass
          connection={connection}
          abilities={abilities}
          clerkEnabled={clerkEnabled}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">New people</h3>
        <NewPeopleGroup
          connection={connection}
          abilities={abilities}
          shape={shape}
          onChange={onChange}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Sessions</h3>
        <SessionsGroup
          connection={connection}
          abilities={abilities}
          shape={shape}
          onChange={onChange}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Mail sign-in</h3>
        {/* ⚠ NOT WHILE A SKELETON: it reads the connection's setup by id. */}
        <Bone id="mail-sign-in" shape="box" width="100%" height={72}>
          {saved && (
            <MailSignIn
              connection={connection}
              abilities={abilities}
              initial={mail ?? {}}
            />
          )}
        </Bone>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Roles from groups</h3>
        <GroupRulesGroup connection={connection} abilities={abilities} />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Test</h3>
        <TestSection connection={connection} authOrigin={authOrigin} />
      </div>

      <div className="space-y-4 border-t border-border pt-4">
        <h3 className="text-sm font-medium text-muted-foreground">Advanced settings</h3>
        <ProviderSettings connection={connection} abilities={abilities} shape={shape} />
        <SetupLinksRow connection={connection} authOrigin={authOrigin} />
        {shape.isOkta && <UniversalLogoutRow connection={connection} />}
      </div>

      {shape.canDelete && <DeleteDraft connection={connection} />}
    </div>
  )
}
