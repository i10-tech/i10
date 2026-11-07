"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Time } from "@/components/time"
import { issueDirectoryToken, revokeDirectoryToken } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoDirectory } from "@/lib/sso-types"
import { ShownOnce, type useSsoCall } from "../shared"
import { OVERLAP } from "./types"

export function ScimDirectory({
  directory,
  abilities,
  call,
  reload,
}: {
  directory: SsoDirectory
  abilities: SsoAbilities
  call: ReturnType<typeof useSsoCall>
  reload: () => Promise<void>
}) {
  const [overlap, setOverlap] = React.useState(String(24 * 3600))
  const [issued, setIssued] = React.useState<{ token: string; baseUrl: string } | null>(
    null,
  )
  const liveTokens = directory.tokens.filter((t) => !t.revokedAt)

  return (
    <div className="space-y-3">
      {directory.baseUrl && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            SCIM base URL
          </span>
          <CopyField value={directory.baseUrl} />
        </div>
      )}

      {liveTokens.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            Active tokens
          </span>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {liveTokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-xs">{t.hint}…</span>
                  <span className="block text-xs text-muted-foreground">
                    Made <Time iso={t.createdAt} />
                    {t.lastUsedAt ? (
                      <>
                        {" "}
                        - used <Time iso={t.lastUsedAt} />
                      </>
                    ) : (
                      " - never used"
                    )}
                    {t.expiresAt && (
                      <>
                        {" "}
                        - ends <Time iso={t.expiresAt} mode="exact" />
                      </>
                    )}
                  </span>
                </span>
                {abilities.owner && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      const ok = await call(
                        () => revokeDirectoryToken(directory.id, t.id),
                        {
                          title: "Could not revoke the token",
                        },
                      )
                      if (ok) {
                        toastDone("Token revoked")
                        await reload()
                      }
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 pt-1">
        {liveTokens.length > 0 && (
          <div className="w-56">
            <MorphSelect
              label="When rotating"
              value={overlap}
              onValueChange={setOverlap}
              items={OVERLAP}
            />
          </div>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={!abilities.owner}
          onClick={async () => {
            const made = await call(
              () => issueDirectoryToken(directory.id, Number(overlap)),
              { title: "Could not issue a token" },
            )
            if (made) {
              setIssued({ token: made.token, baseUrl: made.baseUrl })
              await reload()
            }
          }}
        >
          {liveTokens.length > 0 ? "Rotate token" : "Issue token"}
        </Button>
      </div>

      {!abilities.owner && (
        <p className="text-xs text-muted-foreground">
          Only an owner can issue a token: it is the credential itself.
        </p>
      )}

      <ShownOnce
        open={issued !== null}
        title="Your directory token"
        description="Paste it into your provider as the SCIM token (Okta calls it the API token, Entra the secret token). It is shown once and cannot be found again."
        fields={
          issued
            ? [
                { label: "Base URL", value: issued.baseUrl },
                { label: "Token", value: issued.token },
              ]
            : []
        }
        onClose={() => setIssued(null)}
      />
    </div>
  )
}
