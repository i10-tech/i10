"use client"

import * as React from "react"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup } from "../settings-card"
import { Bypass } from "./bypass"
import { DeleteDraft } from "./delete-draft"
import { DomainsRow } from "./domains-row"
import { Enforcement } from "./enforcement"
import { GroupRulesGroup } from "./group-rules-group"
import { Header } from "./header"
import { LdapRow } from "./ldap-row"
import { NewPeopleGroup } from "./new-people-group"
import { ProviderSettings } from "./provider-settings"
import { SessionsGroup } from "./sessions-group"
import { SetupLinksRow } from "./setup-links-row"
import { TestSection } from "./test-section"
import { UniversalLogoutRow } from "./universal-logout-row"

export function ConnectionView({
  initial,
  abilities,
  authOrigin,
  clerkEnabled,
}: {
  initial: SsoConnection
  abilities: SsoAbilities
  authOrigin: string | null
  clerkEnabled: boolean
}) {
  const [connection, setConnection] = React.useState(initial)

  const onChange = React.useCallback((next: SsoConnection) => setConnection(next), [])

  return (
    <div className="space-y-8 pb-12">
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
          onChange={onChange}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Sessions</h3>
        <SessionsGroup
          connection={connection}
          abilities={abilities}
          onChange={onChange}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Roles from groups</h3>
        <GroupRulesGroup connection={connection} abilities={abilities} />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Test</h3>
        <TestSection connection={connection} authOrigin={authOrigin} />
      </div>

      <div className="space-y-4 pt-4 border-t border-border">
        <h3 className="text-sm font-medium text-muted-foreground">Advanced settings</h3>
        <ProviderSettings connection={connection} abilities={abilities} />
        <SetupLinksRow connection={connection} authOrigin={authOrigin} />
        <LdapRow connection={connection} abilities={abilities} />
        {connection.provider === "okta" && (
          <UniversalLogoutRow connection={connection} />
        )}
      </div>

      {abilities.owner && connection.status === "draft" && (
        <DeleteDraft connection={connection} />
      )}
    </div>
  )
}
