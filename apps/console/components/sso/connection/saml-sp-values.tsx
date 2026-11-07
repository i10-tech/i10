"use client"

import * as React from "react"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import type { SamlSetup } from "@/lib/sso-types"
import { SettingsGroup, SettingsRow } from "../settings-card"

export function SamlSpValues({ data }: { data: SamlSetup }) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">Values to give your provider</h4>
      <SettingsGroup>
        <SettingsRow
          title="Entity ID (Audience)"
          description="The identifier your provider expects for i10."
        >
          <CopyField value={data.entityId} />
        </SettingsRow>
        <SettingsRow
          title="ACS URL (Reply URL)"
          description="The assertion consumer service URL."
        >
          <CopyField value={data.acsUrl} />
        </SettingsRow>
        <SettingsRow title="Logout URL">
          <CopyField value={data.sloUrl} />
        </SettingsRow>
        <SettingsRow title="Metadata URL">
          <CopyField value={data.metadataUrl} />
        </SettingsRow>
        {data.requires.length > 0 && (
          <div className="p-4 border-t border-border bg-muted/20 text-xs text-muted-foreground">
            <p className="font-medium mb-1">Provider requirements:</p>
            <ul className="list-disc pl-4 space-y-0.5">
              {data.requires.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </SettingsGroup>
    </div>
  )
}
