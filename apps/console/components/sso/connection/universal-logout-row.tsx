"use client"

import * as React from "react"
import { Bone } from "@repo/ui/components/bone/bone"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import type { SsoConnection } from "@/lib/sso-types"
import { Advanced } from "../settings-card"

export function UniversalLogoutRow({ connection }: { connection: SsoConnection }) {
  if (connection.provider !== "okta") return null

  return (
    <Advanced
      label="Universal Logout URL"
      summary={
        // ⚠ WHETHER A URL IS SET IS DATA'S: a bone, not a guess at "optional".
        <Bone id="logout-summary" inline width={150}>
          {connection.universalLogoutUrl
            ? "Configured for Okta"
            : "Optional single sign-out for Okta"}
        </Bone>
      }
    >
      <div className="space-y-2 pt-2">
        <p className="text-sm text-muted-foreground">
          Set it in Okta under the app&apos;s Universal Logout settings; it needs
          Adaptive MFA or Identity Threat Protection, so it is optional.
        </p>
        {connection.universalLogoutUrl ? (
          <CopyField value={connection.universalLogoutUrl} />
        ) : (
          <p className="text-xs text-muted-foreground">
            No Universal Logout URL endpoint is assigned to this connection.
          </p>
        )}
      </div>
    </Advanced>
  )
}
