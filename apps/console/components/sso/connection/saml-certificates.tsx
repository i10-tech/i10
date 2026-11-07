"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { Textarea } from "@repo/ui/components/i10/textarea"
import { Time } from "@/components/time"
import {
  addSamlCertificate,
  makeSamlSpKey,
  removeSamlCertificate,
} from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SamlSetup, SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup } from "../settings-card"
import { connectionWriteNeedsStepUp, useSsoCall } from "../shared"

export function SamlCertificates({
  connection,
  data,
  setData,
  locked,
}: {
  connection: SsoConnection
  data: SamlSetup
  setData: (next: SamlSetup) => void
  locked: boolean
  abilities: SsoAbilities
}) {
  const call = useSsoCall()
  const [pem, setPem] = React.useState("")
  const spCert = data.spCertificates[0]

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">Certificates</h4>
      <SettingsGroup>
        <div className="p-4 space-y-4">
          <div>
            <p className="text-sm font-medium">Provider certificates</p>
            {data.certificates.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No certificate saved.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
                {data.certificates.map((cert) => (
                  <li
                    key={cert.id}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <span className="block truncate font-mono text-xs">
                        {cert.fingerprint}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Valid until <Time iso={cert.notAfter} />
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={locked}
                      onClick={async () => {
                        const after = await call(
                          () => removeSamlCertificate(connection.id, cert.id),
                          {
                            stepUp: connectionWriteNeedsStepUp(connection),
                            title: "Could not remove certificate",
                          },
                        )
                        if (after) {
                          setData(after)
                          toastDone("Certificate removed")
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Add provider certificate</p>
            <Textarea
              placeholder="Paste X.509 certificate in PEM format"
              rows={3}
              value={pem}
              disabled={locked}
              onChange={(e) => setPem(e.target.value)}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={locked || !pem.trim()}
              onClick={async () => {
                const after = await call(
                  () => addSamlCertificate(connection.id, pem.trim()),
                  {
                    stepUp: connectionWriteNeedsStepUp(connection),
                    title: "Could not add certificate",
                  },
                )
                if (after) {
                  setData(after)
                  setPem("")
                  toastDone("Certificate added")
                }
              }}
            >
              Add certificate
            </Button>
          </div>

          {spCert && (
            <div className="pt-2 border-t border-border">
              <p className="text-sm font-medium">Our certificate</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground truncate">
                {spCert.fingerprint}
              </p>
              <div className="mt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={locked}
                  onClick={async () => {
                    const after = await call(() => makeSamlSpKey(connection.id), {
                      stepUp: connectionWriteNeedsStepUp(connection),
                      title: "Could not rotate certificate",
                    })
                    if (after) {
                      setData(after)
                      toastDone("Our certificate rotated")
                    }
                  }}
                >
                  Rotate our certificate
                </Button>
              </div>
            </div>
          )}
        </div>
      </SettingsGroup>
    </div>
  )
}
