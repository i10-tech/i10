"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { KeyRound } from "lucide-react"
import { ActionButton } from "@repo/ui/components/action-button"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { CopyField } from "@repo/ui/components/copy"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@repo/ui/components/field"
import { Input } from "@repo/ui/components/input"
import { Label } from "@repo/ui/components/label"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"
import { Switch } from "@repo/ui/components/switch"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Time } from "@/components/time"
import { RotateSecretDialog } from "@/components/webhook-rotate-dialog"
import { EventPicker } from "@/components/webhooks/event-picker"
import {
  KeyValueRows,
  pairsToRecord,
  recordToPairs,
  type Pair,
} from "@/components/webhooks/key-value-rows"
import {
  deleteWebhook,
  revokePreviousWebhookSecrets,
  updateWebhook,
  type WebhookPatch,
} from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import { useSyncedState } from "@/lib/react"
import { API_ORIGIN } from "@/lib/snippets"
import { toastError } from "@/lib/toast"
import { endpointName } from "@/lib/webhooks"
import type { WebhookEndpoint, WebhookEventType } from "@/lib/types"

/**
 * Everything about an endpoint that can be changed (#286).
 *
 * ⚠ ONE SAVE PER SECTION, NOT ONE FOR THE PAGE. The API takes a PATCH of any
 * subset, and a page-wide Save would send the events somebody did not mean to
 * change along with the URL they did - or refuse the URL and lose the events.
 *
 * ⚠ SECTIONS APPEAR BY KIND. A polling endpoint has no URL, signing, headers
 * or rate limit; an SQS one has keys and no headers. Nothing is shown
 * disabled with a reason it would never stop having.
 */
export function EndpointSettings({
  endpoint,
  catalog,
}: {
  endpoint: WebhookEndpoint
  catalog: WebhookEventType[]
}) {
  return (
    <div className="max-w-3xl">
      <EndpointSection endpoint={endpoint} />
      <EventsSection endpoint={endpoint} catalog={catalog} />
      <FiltersSection endpoint={endpoint} />
      {endpoint.kind !== "polling" && <DeliverySection endpoint={endpoint} />}
      {endpoint.kind === "sqs" && <CredentialsSection endpoint={endpoint} />}
      {endpoint.kind !== "polling" && <SigningSection endpoint={endpoint} />}
      <StatusSection endpoint={endpoint} />
      <DangerSection endpoint={endpoint} />
    </div>
  )
}

/** A section's save: the patch, the toast on refusal, the tick on success. */
function useSave(id: string, failure: string) {
  const outcome = useOutcome()
  const save = (patch: WebhookPatch) =>
    outcome.run(async () => {
      const result = await updateWebhook(id, patch)
      if (!result.ok) {
        toastError(failure, { description: result.error })
        return false
      }
      return true
    })
  return { outcome, save }
}

function SaveButton({
  outcome,
  disabled,
  label = "Save",
  done = "Saved",
}: {
  outcome: ReturnType<typeof useOutcome>
  disabled: boolean
  label?: string
  done?: string
}) {
  return (
    <ActionButton
      type="submit"
      size="sm"
      state={outcome.state}
      onReset={outcome.reset}
      pendingLabel={label}
      doneLabel={done}
      // Only while idle, so the tick does not grey out under itself.
      disabled={outcome.state === "idle" && disabled}
    >
      {label}
    </ActionButton>
  )
}

function EndpointSection({ endpoint }: { endpoint: WebhookEndpoint }) {
  const [url, setUrl] = useSyncedState(endpoint.url ?? "")
  const [description, setDescription] = useSyncedState(endpoint.description ?? "")
  const { outcome, save } = useSave(endpoint.id, "Could not save the endpoint")
  const changed =
    (endpoint.kind !== "polling" && url.trim() !== (endpoint.url ?? "")) ||
    description.trim() !== (endpoint.description ?? "")

  const pollUrl = `${API_ORIGIN}/webhook-endpoints/${endpoint.id}/poll`

  return (
    <Section className="pt-0">
      <SectionTitle>Endpoint</SectionTitle>
      <SectionContent>
        <form
          className="space-y-4"
          {...outcome.formProps}
          onSubmit={(event) => {
            event.preventDefault()
            if (!changed || outcome.state !== "idle") return
            const patch: WebhookPatch = {}
            if (endpoint.kind !== "polling" && url.trim() !== endpoint.url) {
              patch.url = url.trim()
            }
            if (description.trim() !== (endpoint.description ?? "")) {
              patch.description = description.trim() || null
            }
            void save(patch)
          }}
        >
          {endpoint.kind !== "polling" && (
            <div className="space-y-1.5">
              <Label htmlFor="endpoint-url">
                {endpoint.kind === "sqs" ? "Queue URL" : "URL"}
              </Label>
              <Input
                id="endpoint-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {endpoint.kind === "sqs"
                  ? "https://sqs.<region>.amazonaws.com/<account>/<queue>"
                  : "HTTPS and publicly reachable. Changing it sends the next event to the new address."}
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="endpoint-description">Description</Label>
            <Input
              id="endpoint-description"
              value={description}
              maxLength={255}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Production handler"
              autoComplete="off"
            />
          </div>
          <div className="flex justify-end">
            <SaveButton outcome={outcome} disabled={!changed} />
          </div>
        </form>

        {endpoint.kind === "polling" && (
          <dl className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <dt className="text-sm font-medium">Poll URL</dt>
              <dd className="space-y-1.5">
                <CopyField value={pollUrl} />
                <p className="text-xs text-muted-foreground">
                  <code className="font-mono">GET</code> it with an API key. Pass the{" "}
                  <code className="font-mono">next_cursor</code> you get back as{" "}
                  <code className="font-mono">?cursor=</code> on the next call: that
                  acknowledges everything up to it. An older cursor reads events again.
                </p>
              </dd>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Acknowledged up to</dt>
                <dd className="mt-0.5 font-mono text-sm">
                  {endpoint.poll_cursor ?? "Nothing yet"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last polled</dt>
                <dd className="mt-0.5 text-sm">
                  {endpoint.last_polled_at ? (
                    <Time iso={endpoint.last_polled_at} />
                  ) : (
                    "Never"
                  )}
                </dd>
              </div>
            </div>
          </dl>
        )}
      </SectionContent>
    </Section>
  )
}

function EventsSection({
  endpoint,
  catalog,
}: {
  endpoint: WebhookEndpoint
  catalog: WebhookEventType[]
}) {
  const [events, setEvents] = useSyncedState(endpoint.events)
  const { outcome, save } = useSave(endpoint.id, "Could not save the events")
  const changed =
    events.length !== endpoint.events.length ||
    events.some((e) => !endpoint.events.includes(e))

  return (
    <Section>
      <SectionTitle>Events</SectionTitle>
      <SectionDescription>
        What this endpoint is sent. Open one to see its schema and an example.
      </SectionDescription>
      <SectionContent>
        <form
          className="space-y-4"
          {...outcome.formProps}
          onSubmit={(event) => {
            event.preventDefault()
            if (!changed || events.length === 0) return
            void save({ events })
          }}
        >
          {catalog.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The event catalog could not be loaded. Reload to try again.
            </p>
          ) : (
            <EventPicker catalog={catalog} value={events} onChange={setEvents} />
          )}
          <div className="flex items-center justify-end gap-3">
            {events.length === 0 && (
              <p className="text-xs text-warning">
                Choose at least one: an endpoint subscribed to nothing is never called.
              </p>
            )}
            <SaveButton outcome={outcome} disabled={!changed || events.length === 0} />
          </div>
        </form>
      </SectionContent>
    </Section>
  )
}

/**
 * ⚠ DOMAINS ARE TYPED AS A LIST, NOT PICKED FROM THE WORKSPACE'S DOMAINS. A
 * filter can name a domain before it is added, and one that was removed
 * should not silently widen the filter by vanishing from a picker.
 */
function FiltersSection({ endpoint }: { endpoint: WebhookEndpoint }) {
  const [domains, setDomains] = useSyncedState(
    (endpoint.filter_domains ?? []).join(", "),
  )
  const [tags, setTags] = useSyncedState<Pair[]>(recordToPairs(endpoint.filter_tags))
  const { outcome, save } = useSave(endpoint.id, "Could not save the filters")

  const list = domains
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  const before = endpoint.filter_domains ?? []
  const tagRecord = pairsToRecord(tags)
  const domainsChanged =
    list.length !== before.length || list.some((d, i) => d !== before[i])
  const tagsChanged =
    JSON.stringify(tagRecord ?? {}) !== JSON.stringify(endpoint.filter_tags ?? {})

  return (
    <Section>
      <SectionTitle>Filters</SectionTitle>
      <SectionDescription>
        Narrow the mail events this endpoint gets. Empty sends everything. Events about
        your endpoints are never filtered.
      </SectionDescription>
      <SectionContent>
        <form
          className="space-y-5"
          {...outcome.formProps}
          onSubmit={(event) => {
            event.preventDefault()
            if (!domainsChanged && !tagsChanged) return
            void save({
              ...(domainsChanged ? { filter_domains: list.length ? list : null } : {}),
              ...(tagsChanged ? { filter_tags: tagRecord } : {}),
            })
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="filter-domains">Sending domains</Label>
            <Input
              id="filter-domains"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="acme.com, mail.acme.com"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Only mail sent from these domains. Separate them with commas.
            </p>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Tags</legend>
            <p className="text-xs text-muted-foreground">
              Only messages that carry every one of these tags.
            </p>
            <KeyValueRows
              value={tags}
              onChange={setTags}
              nameLabel="Tag"
              valueLabel="Value"
              namePlaceholder="category"
              valuePlaceholder="receipt"
            />
          </fieldset>
          <div className="flex justify-end">
            <SaveButton outcome={outcome} disabled={!domainsChanged && !tagsChanged} />
          </div>
        </form>
      </SectionContent>
    </Section>
  )
}

/**
 * ⚠ HEADER VALUES ARE WRITE-ONLY, so editing them is replacing all of them.
 * The names are shown; the values are typed again. Saving an empty set clears
 * them.
 */
function DeliverySection({ endpoint }: { endpoint: WebhookEndpoint }) {
  const [rate, setRate] = useSyncedState(endpoint.rate_limit?.toString() ?? "")
  const rateSave = useSave(endpoint.id, "Could not save the rate limit")
  const parsed = rate.trim() === "" ? null : Number(rate)
  const rateValid =
    parsed === null || (Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000)
  const rateChanged = parsed !== endpoint.rate_limit

  const [editing, setEditing] = React.useState(false)
  const [headers, setHeaders] = React.useState<Pair[]>([])
  const headerSave = useSave(endpoint.id, "Could not save the headers")
  const filled = headers.filter((h) => h.name.trim())
  const missing = filled.some((h) => h.value === "")

  return (
    <Section>
      <SectionTitle>Delivery</SectionTitle>
      <SectionContent className="space-y-8">
        <form
          className="space-y-1.5"
          {...rateSave.outcome.formProps}
          onSubmit={(event) => {
            event.preventDefault()
            if (!rateValid || !rateChanged) return
            void rateSave.save({ rate_limit: parsed })
          }}
        >
          <Label htmlFor="rate-limit">Rate limit</Label>
          <div className="flex items-center gap-2">
            <Input
              id="rate-limit"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="No limit"
              aria-invalid={!rateValid || undefined}
              className="tabular w-32"
            />
            <span className="text-sm text-muted-foreground">per second</span>
            <span className="ml-auto">
              <SaveButton
                outcome={rateSave.outcome}
                disabled={!rateValid || !rateChanged}
              />
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            1 to 1000, held across all of our workers. Events over it wait their turn;
            none are dropped.
          </p>
        </form>

        {endpoint.kind === "http" && (
          <form
            className="space-y-2"
            {...headerSave.outcome.formProps}
            onSubmit={async (event) => {
              event.preventDefault()
              if (missing) return
              const ok = await headerSave.save({ headers: pairsToRecord(headers) })
              if (ok) setEditing(false)
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Custom headers</span>
              {!editing && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setHeaders(
                      endpoint.header_names.map((name) => ({ name, value: "" })),
                    )
                    setEditing(true)
                  }}
                >
                  {endpoint.header_names.length ? "Replace headers" : "Add headers"}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Sent on every request. Values cannot be read back, so changing any header
              means entering every value again. Signing and transport headers are
              reserved.
            </p>
            {!editing ? (
              endpoint.header_names.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {endpoint.header_names.map((name) => (
                    <Badge key={name} variant="outline" className="font-mono text-2xs">
                      {name}: ••••
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">None set.</p>
              )
            ) : (
              <div className="space-y-3">
                <KeyValueRows
                  value={headers}
                  onChange={setHeaders}
                  nameLabel="Header"
                  valueLabel="Value"
                  namePlaceholder="x-gateway-token"
                  valuePlaceholder="Value"
                  secret
                />
                <div className="flex items-center justify-end gap-2">
                  {missing && (
                    <p className="mr-auto text-xs text-warning">
                      Enter a value for every header.
                    </p>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </Button>
                  <SaveButton
                    outcome={headerSave.outcome}
                    disabled={missing}
                    label={filled.length ? "Save headers" : "Clear headers"}
                    done="Saved"
                  />
                </div>
              </div>
            )}
          </form>
        )}
      </SectionContent>
    </Section>
  )
}

function CredentialsSection({ endpoint }: { endpoint: WebhookEndpoint }) {
  const [id, setId] = React.useState("")
  const [secret, setSecret] = React.useState("")
  const { outcome, save } = useSave(endpoint.id, "Could not replace the keys")
  return (
    <Section>
      <SectionTitle>AWS credentials</SectionTitle>
      <SectionDescription>
        In use:{" "}
        <span className="font-mono text-xs">{endpoint.aws_access_key_id ?? "-"}</span>.
        The secret is sealed and never shown. New keys replace the old ones at once.
      </SectionDescription>
      <SectionContent>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          {...outcome.formProps}
          onSubmit={async (event) => {
            event.preventDefault()
            const ok = await save({
              aws_credentials: {
                access_key_id: id.trim(),
                secret_access_key: secret.trim(),
              },
            })
            if (ok) {
              setId("")
              setSecret("")
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="aws-key">Access key ID</Label>
            <Input
              id="aws-key"
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aws-secret">Secret access key</Label>
            <Input
              id="aws-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
          <SaveButton
            outcome={outcome}
            disabled={id.trim().length < 16 || secret.trim().length < 16}
            label="Replace keys"
            done="Replaced"
          />
        </form>
      </SectionContent>
    </Section>
  )
}

function SigningSection({ endpoint }: { endpoint: WebhookEndpoint }) {
  const [rotating, setRotating] = React.useState(false)
  const revoke = useOutcome()
  return (
    <Section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <SectionTitle className="m-0">Signing</SectionTitle>
          <SectionDescription>
            {endpoint.signature_scheme === "ed25519"
              ? "Ed25519 (v1a). Verify with the public key below; nothing you store can forge a webhook."
              : "HMAC-SHA256 (v1) with the shared secret you were shown once. Rotate it if it is lost or may have leaked."}
          </SectionDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setRotating(true)}>
          <KeyRound />
          Rotate secret
        </Button>
      </div>
      <SectionContent className="space-y-4">
        {endpoint.public_key && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Public key</p>
            <CopyField value={endpoint.public_key} />
          </div>
        )}
        {endpoint.previous_secrets.length > 0 && (
          <div className="space-y-2 rounded-xl border border-warning/25 bg-warning/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">Previous secrets still signing</p>
              <ActionButton
                size="sm"
                variant="outline"
                state={revoke.state}
                onReset={revoke.reset}
                pendingLabel="Revoke now"
                doneLabel="Revoked"
                onClick={() =>
                  void revoke.run(async () => {
                    const r = await revokePreviousWebhookSecrets(endpoint.id)
                    if (!r.ok) {
                      toastError("Could not revoke the previous secrets", {
                        description: r.error,
                      })
                      return false
                    }
                    return true
                  })
                }
              >
                Revoke now
              </ActionButton>
            </div>
            <ul className="space-y-1">
              {endpoint.previous_secrets.map((p, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2 text-xs">
                  <span className="font-mono">
                    {p.signature_scheme === "ed25519" ? "Ed25519 key" : "HMAC secret"}
                  </span>
                  <span className="text-muted-foreground">
                    stops signing <Time iso={p.expires_at} mode="exact" />
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Every event is signed with each of these and the current one, so receivers
              on either verify. Revoke them once yours has the new secret.
            </p>
          </div>
        )}
      </SectionContent>
      <RotateSecretDialog
        endpoint={rotating ? endpoint : null}
        onOpenChange={(open) => !open && setRotating(false)}
      />
    </Section>
  )
}

/**
 * ⚠ OPTIMISTIC, AND PUT BACK ON FAILURE, like the domain's tracking switches.
 * Turning an endpoint i10 switched off back on makes it `failing`, so its next
 * success is the recovery the owner hears about.
 */
function StatusSection({ endpoint }: { endpoint: WebhookEndpoint }) {
  const [on, setOn] = useSyncedState(endpoint.enabled)
  const [saving, setSaving] = React.useState(false)
  return (
    <Section>
      <SectionTitle>Status</SectionTitle>
      <SectionContent>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="endpoint-enabled">
              Send events to this endpoint
            </FieldLabel>
            <FieldDescription>
              {endpoint.health === "disabled" && endpoint.disabled_reason
                ? `i10 switched it off: ${endpoint.disabled_reason}`
                : on
                  ? "Off pauses it. Events that happen while it is paused can be sent afterwards from Replays."
                  : "Paused. Turn it on to pick up again."}
            </FieldDescription>
          </FieldContent>
          <Switch
            id="endpoint-enabled"
            checked={on}
            disabled={saving}
            onCheckedChange={async (next) => {
              setOn(next)
              setSaving(true)
              const r = await updateWebhook(endpoint.id, { enabled: next })
              setSaving(false)
              if (!r.ok) {
                setOn(!next)
                toastError(next ? "Could not turn it on" : "Could not pause it", {
                  description: r.error,
                })
              }
            }}
          />
        </Field>
      </SectionContent>
    </Section>
  )
}

function DangerSection({ endpoint }: { endpoint: WebhookEndpoint }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  return (
    <Section>
      <SectionTitle className="text-destructive">Danger zone</SectionTitle>
      <SectionContent>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 p-4">
          <div>
            <p className="text-sm font-medium">Delete this endpoint</p>
            <p className="text-xs text-muted-foreground">
              Events stop at once. Past deliveries stay in the log.
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
            Delete endpoint
          </Button>
        </div>
      </SectionContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this endpoint?"
        description="Events stop being delivered to it immediately. Past deliveries stay in the log."
        confirmLabel="Delete endpoint"
        doneLabel="Deleted"
        confirmWord={endpointName(endpoint)}
        onConfirm={async () => {
          const result = await deleteWebhook(endpoint.id)
          if (!result.ok) {
            toastError("Could not delete the endpoint", { description: result.error })
            return false
          }
          router.push("/webhooks")
          return true
        }}
      />
    </Section>
  )
}
