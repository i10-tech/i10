"use client"

import * as React from "react"
import { Info } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { CopyField } from "@repo/ui/components/copy"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import { RadioGroup, RadioGroupItem } from "@repo/ui/components/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { Time } from "@/components/time"
import { rotateWebhookSecret } from "@/lib/actions"
import { useResetOnOpen, useRetained } from "@/lib/react"
import { useStepUp } from "@/lib/step-up"
import { toastError } from "@/lib/toast"
import type { WebhookEndpoint } from "@/lib/types"

/**
 * Rotating an endpoint's signing key.
 *
 * ⚠ THE PERSON CHOOSES WHAT HAPPENS TO THE OLD KEY, AND NOTHING IS PRESELECTED.
 * Keeping it working for a while lets a receiver deploy the new secret first;
 * revoking it now is what you want when the old one may have leaked. Which is
 * right depends on why they are rotating, and only they know that - so the
 * Rotate button stays disabled until they have answered. The ceiling is 72
 * hours (docs/decisions/webhooks.md, decision 7).
 */

const GRACE_OPTIONS = [
  { seconds: 15 * 60, label: "15 minutes" },
  { seconds: 60 * 60, label: "1 hour" },
  { seconds: 6 * 60 * 60, label: "6 hours" },
  { seconds: 24 * 60 * 60, label: "24 hours" },
  { seconds: 72 * 60 * 60, label: "72 hours (the maximum)" },
] as const

type Choice = "revoke" | "expire" | null

export function RotateSecretDialog({
  endpoint,
  onOpenChange,
}: {
  endpoint: WebhookEndpoint | null
  onOpenChange: (open: boolean) => void
}) {
  const stepUp = useStepUp()
  const shown = useRetained(endpoint)
  const [choice, setChoice] = React.useState<Choice>(null)
  const [grace, setGrace] = React.useState<string>(String(60 * 60))
  const [scheme, setScheme] = React.useState<"hmac_sha256" | "ed25519">("hmac_sha256")
  const [pending, setPending] = React.useState(false)
  const [rotated, setRotated] = React.useState<WebhookEndpoint | null>(null)

  // A fresh question every time the dialog opens: nothing carries over from
  // the last rotation, least of all the last answer.
  useResetOnOpen(endpoint !== null, () => {
    setChoice(null)
    setGrace(String(60 * 60))
    setScheme(endpoint?.signature_scheme ?? "hmac_sha256")
    setRotated(null)
    setPending(false)
  })

  const rotate = async () => {
    if (!endpoint || !choice) return
    setPending(true)
    try {
      if (!(await stepUp())) return
      const result = await rotateWebhookSecret(endpoint.id, {
        previous_secret: choice,
        ...(choice === "expire" ? { expires_in: Number(grace) } : {}),
        ...(scheme !== endpoint.signature_scheme ? { signature_scheme: scheme } : {}),
      })
      if (!result.ok) {
        toastError("Could not rotate the secret", { description: result.error })
        return
      }
      setRotated(result.data)
    } finally {
      setPending(false)
    }
  }

  const keptUntil = rotated?.previous_secrets.at(-1)?.expires_at

  return (
    <Dialog
      open={endpoint !== null}
      // Once the new secret is on screen, only the explicit button closes it.
      onOpenChange={(open) => !rotated && !pending && onOpenChange(open)}
    >
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!rotated}
        onEscapeKeyDown={(event) => rotated && event.preventDefault()}
        onPointerDownOutside={(event) => rotated && event.preventDefault()}
      >
        {!rotated ? (
          <>
            <DialogHeader>
              <DialogTitle>Rotate signing secret</DialogTitle>
              <DialogDescription className="break-all">{shown?.url}</DialogDescription>
            </DialogHeader>

            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-sm font-medium">
                What should happen to the current secret?
              </legend>
              <RadioGroup
                value={choice ?? ""}
                onValueChange={(v) => setChoice(v as Choice)}
                className="gap-2"
              >
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 hover:bg-muted/30">
                  <RadioGroupItem value="revoke" className="mt-0.5" />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">Revoke it now</span>
                    <span className="block text-xs text-muted-foreground">
                      It stops working immediately. Choose this if it may have leaked.
                      Events fail verification until your receiver has the new secret.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 hover:bg-muted/30">
                  <RadioGroupItem value="expire" className="mt-0.5" />
                  <span className="w-full space-y-2">
                    <span className="block space-y-0.5">
                      <span className="block text-sm font-medium">
                        Keep it working for a while
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Every event is signed with both secrets until then, so you can
                        deploy the new one first.
                      </span>
                    </span>
                    {choice === "expire" && (
                      <Select value={grace} onValueChange={setGrace}>
                        <SelectTrigger
                          className="w-full"
                          aria-label="Keep the current secret for"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {GRACE_OPTIONS.map((o) => (
                            <SelectItem key={o.seconds} value={String(o.seconds)}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </span>
                </label>
              </RadioGroup>
            </fieldset>

            <div className="space-y-1.5">
              <span className="text-sm font-medium">Signing</span>
              <Select
                value={scheme}
                onValueChange={(v) => setScheme(v as typeof scheme)}
              >
                <SelectTrigger className="w-full" aria-label="Signing scheme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hmac_sha256">
                    HMAC-SHA256 with a shared secret
                  </SelectItem>
                  <SelectItem value="ed25519">
                    Ed25519, verified with a public key
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button onClick={rotate} disabled={!choice || pending}>
                {pending ? "Rotating" : "Rotate secret"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {rotated.secret ? "Your new signing secret" : "Your new public key"}
              </DialogTitle>
              <DialogDescription>
                {rotated.secret
                  ? "Shown once. Store it before you close this."
                  : "Verify Ed25519 signatures with this key. It is not a secret and stays visible on the endpoint."}
              </DialogDescription>
            </DialogHeader>
            <CopyField
              value={rotated.secret ?? rotated.public_key ?? ""}
              className="py-2"
            />
            <p className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {keptUntil ? (
                  <>
                    The previous secret keeps working until{" "}
                    <Time iso={keptUntil} mode="exact" />. You can revoke it sooner from
                    the endpoint&apos;s menu.
                  </>
                ) : (
                  "The previous secret has stopped working."
                )}
              </span>
            </p>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>
                {rotated.secret ? "I have copied it" : "Done"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
