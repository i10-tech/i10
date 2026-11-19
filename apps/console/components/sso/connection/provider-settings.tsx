"use client"

import * as React from "react"
import { oidcSetup, samlSetup } from "@/lib/sso-actions"
import type { SsoConnectionShape } from "@/lib/shapes/sso-connection"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { Advanced } from "../settings-card"
import { Loading, useRemote } from "../shared"
import { OidcSettings } from "./oidc-settings"
import { SamlSettings } from "./saml-settings"

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000

export function ProviderSettings({
  connection,
  abilities,
  shape,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  shape: SsoConnectionShape
}) {
  // ⚠ WHETHER IT OPENS BY ITSELF IS THE SHAPE'S (`failing`): the skeleton draws the
  // row open or shut the way the page will, instead of the page opening it a beat later.
  return connection.protocol === "saml" ? (
    <SamlProviderSection
      connection={connection}
      abilities={abilities}
      failing={shape.failing}
    />
  ) : (
    <OidcProviderSection
      connection={connection}
      abilities={abilities}
      failing={shape.failing}
    />
  )
}

function OidcProviderSection({
  connection,
  abilities,
  failing,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  failing: boolean
}) {
  const { data, setData, failed } = useRemote(() => oidcSetup(connection.id))
  const [now] = React.useState(() => Date.now())

  let autoOpenMessage: string | null = null
  if (failing) {
    autoOpenMessage = "Opened because this connection is reporting sign-in failures."
  } else if (data?.secretExpiresAt) {
    const diff = new Date(data.secretExpiresAt).getTime() - now
    if (diff <= THIRTY_DAYS_MS) {
      const days = Math.max(0, Math.ceil(diff / (24 * 3600 * 1000)))
      autoOpenMessage = `Opened because the client secret expires in ${days} day${days === 1 ? "" : "s"}.`
    }
  }

  return (
    <Advanced
      label="Provider settings"
      summary={
        autoOpenMessage
          ? autoOpenMessage
          : "Endpoints, credentials and protocol options"
      }
      defaultOpen={Boolean(autoOpenMessage)}
    >
      {!data ? (
        <Loading failed={failed} />
      ) : (
        <div className="space-y-4 pt-2">
          {autoOpenMessage && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
              {autoOpenMessage}
            </div>
          )}
          <OidcSettings
            connection={connection}
            abilities={abilities}
            data={data}
            setData={setData}
          />
        </div>
      )}
    </Advanced>
  )
}

function SamlProviderSection({
  connection,
  abilities,
  failing,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  failing: boolean
}) {
  const { data, setData, failed } = useRemote(() => samlSetup(connection.id))
  const [now] = React.useState(() => Date.now())

  let autoOpenMessage: string | null = null
  if (failing) {
    autoOpenMessage = "Opened because this connection is reporting sign-in failures."
  } else if (data?.certificates) {
    for (const cert of data.certificates) {
      if (cert.notAfter) {
        const diff = new Date(cert.notAfter).getTime() - now
        if (diff <= THIRTY_DAYS_MS) {
          const days = Math.max(0, Math.ceil(diff / (24 * 3600 * 1000)))
          autoOpenMessage = `Opened because a provider certificate expires in ${days} day${days === 1 ? "" : "s"}.`
          break
        }
      }
    }
  }

  return (
    <Advanced
      label="Provider settings"
      summary={
        autoOpenMessage
          ? autoOpenMessage
          : "Endpoints, certificates and signing options"
      }
      defaultOpen={Boolean(autoOpenMessage)}
    >
      {!data ? (
        <Loading failed={failed} />
      ) : (
        <div className="space-y-4 pt-2">
          {autoOpenMessage && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
              {autoOpenMessage}
            </div>
          )}
          <SamlSettings
            connection={connection}
            abilities={abilities}
            data={data}
            setData={setData}
          />
        </div>
      )}
    </Advanced>
  )
}
