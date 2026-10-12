"use client"

import * as React from "react"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { useRouter } from "next/navigation"
import { AlertTriangle, ArrowLeft, Inbox, Layers, Plus, Webhook } from "lucide-react"
import { StateButton } from "@repo/ui/components/i10/state-button"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { RadioCards } from "@repo/ui/components/radio-cards/radio-cards"
import { StepStage } from "@repo/ui/components/i10/step-stage"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { UrlInput } from "@/components/url-input"
import { httpsUrlProblem } from "@repo/ui/checks"
import { createWebhook, type CreateWebhookInput } from "@/lib/actions"
import { EventPicker } from "@/components/webhooks/event-picker"
import {
  KeyValueRows,
  pairsToRecord,
  type Pair,
} from "@/components/webhooks/key-value-rows"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import type {
  WebhookEndpoint,
  WebhookEndpointKind,
  WebhookEventType,
  WebhookSignatureScheme,
} from "@/lib/types"
import { toastError } from "@/lib/toast"

/**
 * Adding an endpoint: how it gets its events first, then only what that way
 * takes (#286).
 *
 * ⚠ THE KIND IS ASKED BEFORE ANYTHING ELSE, because it decides which fields
 * exist at all. A polling endpoint has no URL, no signing and no headers; an
 * SQS one has a queue and AWS keys. One form with every field and half of
 * them disabled is a form somebody fills in wrong.
 *
 * ⚠ THE SIGNING SECRET IS SHOWN ONCE, LIKE AN API KEY. The API stores it
 * encrypted and never returns it again; without it a customer cannot verify
 * that a request came from us.
 *
 * ⚠ AND EVERY MAIL EVENT IS SELECTED BY DEFAULT, the endpoint events not. The
 * common case is "tell me everything about my mail"; the events about your
 * own endpoints belong on a separate endpoint.
 */

const KINDS: {
  value: WebhookEndpointKind
  label: string
  description: string
  icon: React.ReactNode
}[] = [
  {
    value: "http",
    label: "HTTP",
    description: "We POST each event to your URL, signed.",
    icon: <Webhook />,
  },
  {
    value: "polling",
    label: "Polling",
    description: "You fetch events with a cursor. No public URL needed.",
    icon: <Inbox />,
  },
  {
    value: "sqs",
    label: "Amazon SQS",
    description: "We send each event to your queue as a message.",
    icon: <Layers />,
  },
]

const SQS_URL =
  /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]+(\.fifo)?$/

function sqsUrlProblem(value: string): string | null {
  return SQS_URL.test(value.trim())
    ? null
    : "Use the queue URL, https://sqs.<region>.amazonaws.com/<account>/<queue>."
}

type Step = "kind" | "form" | "secret"

export function CreateWebhookButton({
  autoOpen = false,
  catalog,
}: {
  autoOpen?: boolean
  catalog: WebhookEventType[]
}) {
  const router = useRouter()
  const mailEvents = React.useMemo(
    () => catalog.filter((t) => t.type.startsWith("email.")).map((t) => t.type),
    [catalog],
  )
  const [open, setOpen] = React.useState(autoOpen)
  const [step, setStep] = React.useState<Step>("kind")
  const [kind, setKind] = React.useState<WebhookEndpointKind>("http")
  const [url, setUrl] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [scheme, setScheme] = React.useState<WebhookSignatureScheme>("hmac_sha256")
  const [events, setEvents] = React.useState<string[]>(mailEvents)
  const [headers, setHeaders] = React.useState<Pair[]>([])
  const [accessKeyId, setAccessKeyId] = React.useState("")
  const [secretKey, setSecretKey] = React.useState("")
  const outcome = useOutcome()
  const [created, setCreated] = React.useState<WebhookEndpoint | null>(null)

  // ⚠ CLEARED ON OPEN, NOT ON CLOSE - see `useResetOnOpen`.
  useResetOnOpen(open, () => {
    setStep("kind")
    setKind("http")
    setUrl("")
    setDescription("")
    setScheme("hmac_sha256")
    setEvents(mailEvents)
    setHeaders([])
    setAccessKeyId("")
    setSecretKey("")
    setCreated(null)
    outcome.reset()
  })

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (outcome.state !== "idle") return

    if (events.length === 0) {
      toastError("Choose at least one event", {
        description: "An endpoint subscribed to nothing never receives anything.",
      })
      return
    }

    const input: CreateWebhookInput = {
      kind,
      events,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(kind !== "polling" ? { url: url.trim() } : {}),
      ...(kind !== "polling" && scheme === "ed25519"
        ? { signature_scheme: scheme }
        : {}),
      ...(kind === "http" && pairsToRecord(headers)
        ? { headers: pairsToRecord(headers)! }
        : {}),
      ...(kind === "sqs"
        ? {
            aws_credentials: {
              access_key_id: accessKeyId.trim(),
              secret_access_key: secretKey.trim(),
            },
          }
        : {}),
    }

    let endpoint: WebhookEndpoint | null = null
    await outcome.run(
      async () => {
        const result = await createWebhook(input)
        if (!result.ok) {
          toastError("Could not create the endpoint", { description: result.error })
          return false
        }
        endpoint = result.data
        return true
      },
      () => {
        const made = endpoint as WebhookEndpoint | null
        if (!made) return
        // ⚠ A POLLING ENDPOINT HAS NO SECRET TO COPY: its page, with the poll
        // URL on it, is the next thing to see.
        if (made.kind === "polling") {
          router.push(`/webhooks/${made.id}`)
          return
        }
        setCreated(made)
        setStep("secret")
      },
    )
  }

  const ready =
    kind === "polling"
      ? true
      : kind === "http"
        ? url.trim() !== ""
        : url.trim() !== "" && accessKeyId.trim() !== "" && secretKey.trim() !== ""

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus />
        Add endpoint
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (created && next === false) return
          if (outcome.state === "pending") return
          setOpen(next)
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          onEscapeKeyDown={(event) => created && event.preventDefault()}
          onPointerDownOutside={(event) => created && event.preventDefault()}
          title={
            step === "secret" && created
              ? created.secret
                ? "Copy your signing secret"
                : "Copy your public key"
              : step === "kind"
                ? "Add a webhook endpoint"
                : kind === "http"
                  ? "Add an HTTP endpoint"
                  : kind === "polling"
                    ? "Add a polling endpoint"
                    : "Add an SQS queue"
          }
          description={
            step === "secret" && created
              ? created.secret
                ? "Use it to verify that a request came from us. It is stored encrypted and cannot be shown again, so rotate it if you lose it."
                : "Verify Ed25519 signatures with it. It is not a secret: nothing you store can forge a webhook from us, and it stays visible on the endpoint."
              : step === "kind"
                ? "How should your events reach you?"
                : kind === "http"
                  ? "We POST a JSON body to this URL for every event you select."
                  : kind === "polling"
                    ? "Events wait for you. Fetch them with your API key and pass the cursor back to acknowledge them."
                    : "We call SendMessage on this queue for every event you select."
          }
          style={{ width: "min(calc(100vw - 2rem), 576px)" }}
        >
          <StepStage step={step}>
            {step === "secret" && created ? (
              <>
                <div className="space-y-3">
                  <CopyField
                    value={created.secret ?? created.public_key ?? ""}
                    className="py-2"
                  />
                  <p className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span>
                      {created.kind === "sqs"
                        ? "The signature travels as a message attribute. A consumer that does not check it will accept any message put on the queue."
                        : "An endpoint that does not verify the signature will accept a forged POST from anyone who guesses the URL."}
                    </span>
                  </p>
                </div>

                <DialogFooter>
                  <Button onClick={() => router.push(`/webhooks/${created.id}`)}>
                    I have copied it
                  </Button>
                </DialogFooter>
              </>
            ) : step === "kind" ? (
              <div className="grid gap-4">
                <RadioCards
                  aria-label="Endpoint kind"
                  layout="list"
                  value={kind}
                  onValueChange={(v) => setKind(v as WebhookEndpointKind)}
                  options={KINDS.map((k) => ({
                    value: k.value,
                    label: k.label,
                    description: k.description,
                    icon: k.icon,
                  }))}
                  onDoubleClick={() => setStep("form")}
                />
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={() => setStep("form")}>
                    Continue
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <form onSubmit={submit} {...outcome.formProps}>
                <div className="space-y-4 py-4">
                  {kind === "http" && (
                    <UrlInput
                      label="Endpoint URL"
                      id="webhook-url"
                      value={url}
                      onValueChange={setUrl}
                      check={httpsUrlProblem}
                      required="Enter the URL to post to."
                      autoFocus
                      hint="Must be HTTPS and publicly reachable. Localhost will not work - use a tunnel while developing."
                    />
                  )}

                  {kind === "sqs" && (
                    <>
                      <UrlInput
                        label="Queue URL"
                        id="webhook-queue"
                        value={url}
                        onValueChange={setUrl}
                        check={sqsUrlProblem}
                        required="Enter the queue URL."
                        autoFocus
                        hint="From the queue's Details in the SQS console."
                      />
                      <FloatingInput
                        label="Access key ID"
                        id="webhook-aws-key"
                        value={accessKeyId}
                        onChange={(event) => setAccessKeyId(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono text-xs"
                      />
                      <FloatingInput
                        label="Secret access key"
                        id="webhook-aws-secret"
                        type="password"
                        value={secretKey}
                        onChange={(event) => setSecretKey(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono text-xs"
                        hint="For an IAM user that can only call sqs:SendMessage on this queue. Stored sealed and never shown again."
                      />
                    </>
                  )}

                  <FloatingInput
                    label="Description"
                    id="webhook-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    autoComplete="off"
                    autoFocus={kind === "polling"}
                    hint="e.g. Production handler"
                  />

                  {kind !== "polling" && (
                    <div>
                      <MorphSelect
                        label="Signing"
                        value={scheme}
                        onValueChange={(v) => setScheme(v as WebhookSignatureScheme)}
                        items={[
                          {
                            value: "hmac_sha256",
                            label: "HMAC-SHA256 with a shared secret",
                          },
                          {
                            value: "ed25519",
                            label: "Ed25519, verified with a public key",
                          },
                        ]}
                        panelWidth={320}
                      />
                    </div>
                  )}

                  {kind === "http" && (
                    <fieldset className="space-y-1.5">
                      <legend className="text-sm font-medium">Custom headers</legend>
                      <p className="text-xs text-muted-foreground">
                        Sent on every request, such as a token for a gateway in front of
                        your receiver. Values cannot be read back once saved.
                      </p>
                      <KeyValueRows
                        value={headers}
                        onChange={setHeaders}
                        nameLabel="Header"
                        valueLabel="Value"
                        namePlaceholder="x-gateway-token"
                        valuePlaceholder="Value"
                        secret
                      />
                    </fieldset>
                  )}

                  <fieldset className="space-y-2">
                    <legend className="mb-1 text-sm font-medium">Events</legend>
                    <EventPicker
                      catalog={catalog}
                      value={events}
                      onChange={setEvents}
                    />
                  </fieldset>
                </div>

                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setStep("kind")}
                    disabled={outcome.state === "pending"}
                    className="sm:mr-auto"
                  >
                    <ArrowLeft />
                    Back
                  </Button>
                  <StateButton
                    type="submit"
                    state={outcome.state}
                    pendingLabel="Add endpoint"
                    doneLabel="Added"
                    disabled={!ready}
                  >
                    Add endpoint
                  </StateButton>
                </DialogFooter>
              </form>
            )}
          </StepStage>
        </DialogContent>
      </Dialog>
    </>
  )
}
