"use server"

import { refresh, revalidatePath } from "next/cache"
import { api, ApiRequestError } from "@/lib/api"
import { safeFailure } from "@/lib/failure"
import { forgetOnboardingSkip } from "@/lib/onboarding-skip"
import { PREVIEW } from "@/lib/preview"
import type {
  ApiKeyRow,
  ContactRow,
  CreatedApiKey,
  Domain,
  PropertyRow,
  SegmentRow,
  TemplatePreview,
  TemplateRow,
  TemplateUploadOutcome,
  TemplateVersionDetail,
  TopicRow,
  TrustedTemplateRow,
  VerifiedDomain,
  TransferOffer,
  WebhookEndpoint,
  Workspace,
} from "@/lib/types"

/**
 * Every mutation the console performs.
 *
 * ⚠ SERVER ACTIONS RATHER THAN ROUTE HANDLERS, FOR ONE REASON THAT MATTERS: the
 * session token never reaches the browser. A `fetch` from a client component to
 * our own `/api/...` would work too, but it needs a second layer of handlers
 * that do nothing but forward - and each one is another place to forget the
 * auth header or the tenant check. The action runs on the server, calls
 * `api()`, and the client gets a plain object back.
 *
 * ⚠ THEY RETURN A RESULT, THEY DO NOT THROW. A thrown error in a server action
 * reaches the client as an opaque "An error occurred in the Server Components
 * render" with the message stripped in production - which is exactly the
 * message the person needs ("that domain is already registered", "your plan
 * does not include another domain"). Returning a discriminated union keeps the
 * API's own wording, including its machine-readable `name`, which the forms
 * branch on to decide between an inline field error and an upgrade prompt.
 *
 * ⚠ AND EVERY ONE OF THEM REVALIDATES. A server action that mutates without
 * `revalidatePath` leaves the page showing the list it rendered before the
 * write - the row is created, the screen says it is not, and the person clicks
 * the button again.
 */

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | {
      ok: false
      error: string
      name: string
      status: number
      /**
       * ⚠ THE WHOLE ERROR BODY, BECAUSE SOME REFUSALS CARRY DATA. A 409 from
       * `/domains/:id/publish` lists the records standing in the way, and that
       * list IS the remedy - flattening every failure to a message would leave
       * the caller with a dialog it cannot fill in. Everything else ignores it.
       *
       * ⚠ IT IS THE API'S OWN JSON AND IS TREATED AS DATA, NOT AS TRUSTED SHAPE.
       * Whoever reads a field off it narrows first.
       */
      body?: Record<string, unknown>
    }

async function run<T>(
  fn: () => Promise<T>,
  revalidate: string[] = [],
  { refreshCaller = true }: { refreshCaller?: boolean } = {},
): Promise<ActionResult<T>> {
  try {
    const data = await fn()
    for (const path of revalidate) {
      // ⚠ `"page"` RATHER THAN THE DEFAULT `"layout"`. Revalidating as a layout
      // invalidates every nested route under the path, which for `/` is the
      // entire console - so creating one API key would discard the cached
      // render of every page the person has visited.
      revalidatePath(path, "page")
    }
    /*
     * ⚠ AND THE PAGE THAT CALLED US IS RE-RENDERED IN THIS SAME RESPONSE, SO NO
     * CALLER EVER FOLLOWS AN ACTION WITH `router.refresh()`. That was the
     * pattern everywhere: the action's response already carried the updated
     * page (a Server Function that revalidates the path being viewed does that
     * by itself), the component then fired a toast, and THEN asked for the page
     * again - a second `GET ?_rsc` and a second render of the whole tree,
     * landing a few hundred milliseconds into the toast. Measured on revoking a
     * key: one POST, then one GET, for one click. That second render is the
     * "refresh that cuts the toast" and the layout that twitches after a save.
     *
     * ⚠ `refresh()` RATHER THAN RELYING ON THE PATHS ABOVE, because the paths
     * name where the data is SHOWN and not where the action was CALLED FROM.
     * Onboarding creates an API key; `/api-keys` is revalidated and
     * `/onboarding` - the page on screen - is not. `refresh()` is Next's
     * Server-Function-only way to say "and the current page", whatever it is,
     * so the rule is one line here instead of a judgement at thirty call sites.
     *
     * ⚠ ONLY FOR ACTIONS THAT REVALIDATE ANYTHING. A read (`lookupDns`,
     * `checkDomain`) or a write that is deliberately silent (`renameWorkspace`,
     * below) changes nothing on screen, and re-rendering for it would be the
     * blink those were written to avoid.
     *
     * ⚠ AND NEVER FOR A DELETION (`refreshCaller: false`). The page a delete is
     * called from is very often the page OF the thing being deleted - a domain,
     * a template - and re-rendering it after the row is gone renders its 404
     * behind the dialog that is still saying "Deleted". Deletions revalidate
     * the LIST paths, which covers the list they were called from; a detail
     * page navigates away on its own. Revoking a domain's keys inside the
     * delete-domain flow is the other half: a refresh there would re-read the
     * domain's scoped keys, find none, and pull the checkbox out of the open
     * dialog while it is still answering.
     */
    if (revalidate.length > 0 && refreshCaller) refresh()
    return { ok: true, data }
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return {
        ok: false,
        error: error.body.message,
        name: error.body.name,
        status: error.status,
        body: error.body as unknown as Record<string, unknown>,
      }
    }

    /*
     * ⚠ NOT `error.message`. Anything reaching here was thrown by the runtime
     * rather than written by the API - `getaddrinfo ENOTFOUND
     * i10-api.i10-prod.svc.cluster.local`, or a TypeError naming one of our
     * own properties - and this string is rendered to the customer. See
     * lib/failure.ts; the real error is logged there.
     */
    const safe = safeFailure(error, "server action")
    return {
      ok: false,
      error: safe.message,
      name: safe.name,
      status: safe.statusCode,
    }
  }
}

// ── Workspace ───────────────────────────────────────────────────────────────

/**
 * ⚠ IT REVALIDATES NOTHING, AND THAT IS THE POINT. `revalidatePath("/settings")`
 * is a re-render of the page this is called FROM - the whole settings tree
 * re-fetched and reconciled for one string, which reads as the page blinking
 * a beat after Save. Nothing else on that page shows the name: the field
 * already holds what was typed, and the only other place it appears is the
 * workspace bar in the rail, which the caller updates directly. See
 * components/rename-workspace.tsx.
 *
 * ⚠ THE COST IS A STALE CACHE ENTRY FOR OTHER ROUTES until something else
 * revalidates them, which is the same cost every page here already pays for
 * a name it does not render.
 */
export async function renameWorkspace(name: string) {
  return run(() =>
    api<{ ok: true; name: string }>("/console/me/tenant", {
      method: "PATCH",
      body: { name },
    }),
  )
}

// ── Domains ─────────────────────────────────────────────────────────────────

export async function createDomain(input: {
  name: string
  custom_return_path?: string
  delegated?: boolean
}) {
  return run(
    () => api<Domain>("/console/domains", { method: "POST", body: input }),
    ["/domains", "/"],
  )
}

export async function verifyDomain(id: string) {
  return run(
    () =>
      // ⚠ `VerifiedDomain`, NOT `Domain`. The extra field is what the button
      // needs to tell "we could not reach your nameservers" apart from "your
      // records are not there yet" - see the note on the type.
      api<VerifiedDomain>(`/console/domains/${encodeURIComponent(id)}/verify`, {
        method: "POST",
      }),
    [`/domains/${encodeURIComponent(id)}`, "/domains"],
  )
}

/**
 * The cheap re-check, for watching rather than acting.
 *
 * ⚠ NOT `verifyDomain` IN A LOOP. Every verify re-asserts the DKIM key at SES
 * - two writes against an account-wide, low-rate API - which is right once and
 * abusive on a timer. This asks what SES currently thinks and stores it, and
 * nothing else. See `DomainStore.refresh` in the API.
 *
 * ⚠ AND IT REVALIDATES NOTHING. The caller is a poll that already re-renders
 * when the answer changes; revalidating two paths on every tick would discard
 * the cached render of the domains list several times a minute for a value
 * that is usually identical to the last one.
 */
export async function refreshDomain(id: string) {
  return run(() =>
    api<Domain>(`/console/domains/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
    }),
  )
}

export async function deleteDomain(id: string) {
  return run(
    () =>
      api<{ deleted: true }>(`/console/domains/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    ["/domains", "/"],
    { refreshCaller: false },
  )
}

/**
 * Turns open or click tracking on or off for one domain (#154). Takes effect on
 * the next message the worker picks up.
 */
export async function updateDomainTracking(
  id: string,
  change: { open_tracking?: boolean; click_tracking?: boolean },
) {
  return run(
    () =>
      api(`/console/domains/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: change,
      }),
    [`/domains/${encodeURIComponent(id)}`],
  )
}

/**
 * Offers a domain to whoever holds an email address. Moves nothing yet.
 *
 * ⚠ `emailed` IS FALSE WHEN THE NOTICE COULD NOT BE SENT. The offer still
 * stands and an existing user will find it on their domains page; somebody
 * without an account will not hear about it, and the sender is told so.
 */
export async function offerTransfer(id: string, email: string) {
  return run(
    () =>
      api<TransferOffer & { emailed: boolean }>(
        `/console/domains/${encodeURIComponent(id)}/transfer`,
        { method: "POST", body: { email } },
      ),
    [`/domains/${encodeURIComponent(id)}`],
  )
}

export async function cancelTransfer(id: string) {
  return run(
    () =>
      api<{ canceled: true }>(`/console/domains/${encodeURIComponent(id)}/transfer`, {
        method: "DELETE",
      }),
    [`/domains/${encodeURIComponent(id)}`],
  )
}

/**
 * Takes an offered domain into one of this person's workspaces, or into the
 * current one when none is named.
 *
 * ⚠ BY CLERK ORGANIZATION ID. The API checks it against the person's current
 * memberships before resolving a tenant, so nothing here can point at a
 * workspace they are not in.
 */
export async function acceptTransfer(id: string, workspace?: string) {
  return run(
    () =>
      api<{ domain_id: string; domain_name: string; workspace: Workspace | null }>(
        `/console/transfers/${encodeURIComponent(id)}/accept`,
        // ⚠ NO WORKSPACE MEANS THE CURRENT ONE - onboarding's case.
        { method: "POST", body: workspace ? { workspace } : {} },
      ),
    ["/domains", "/", "/onboarding"],
  )
}

export async function declineTransfer(id: string) {
  return run(
    () =>
      api<{ declined: true }>(`/console/transfers/${encodeURIComponent(id)}/decline`, {
        method: "POST",
      }),
    ["/domains"],
  )
}

export async function lookupDns(domain: string) {
  // ⚠ NO REVALIDATION: THIS IS A READ. It is an action rather than a loader
  // because it runs in response to typing, not to navigation - the onboarding
  // form asks it as the person finishes entering an apex.
  return run(() =>
    api<import("@/lib/types").DnsInspection>("/console/dns/lookup", {
      query: { domain },
    }),
  )
}

/**
 * Why the API would refuse to add this name - ours, or already in this
 * workspace - asked while it is still being typed.
 *
 * ⚠ READ-ONLY, AND ITS FAILURE MEANS "NO OBJECTION". The create still decides;
 * this only lets the box go red before the button is pressed.
 */
export async function checkDomain(name: string) {
  return run(() =>
    api<{ name: string; refusal: string | null }>("/console/domains/check", {
      query: { name },
    }),
  )
}

// ── DNS connections ─────────────────────────────────────────────────────────

/**
 * ⚠ THESE HANDLE THE MOST DANGEROUS CREDENTIAL IN THE PRODUCT, AND NONE OF THEM
 * EVER RETURNS ONE. A DNS write token can rewrite a customer's MX records and
 * take delivery of their mail; it is written once, sealed, and read only by the
 * publisher on the server. What comes back here is a provider, a label and the
 * zones it reaches.
 */
export async function dnsProviders() {
  return run(() =>
    api<{ data: import("@/lib/types").ConnectableProvider[] }>(
      "/console/dns/providers",
    ),
  )
}

export async function dnsConnections() {
  return run(() =>
    api<{ data: import("@/lib/types").DnsConnection[] }>("/console/dns/connections"),
  )
}

/**
 * @param returnTo Where to land once the connection is made - a path on this
 * console, never a URL. It rides in the signed OAuth `state` because a
 * provider compares `redirect_uri` exactly and will not accept an extra query
 * parameter; the API re-checks it on the way back. See dns/oauth.ts.
 */
export async function startDnsConnect(provider: string, returnTo?: string) {
  return run(() =>
    api<{ url: string }>(`/console/dns/connect/${encodeURIComponent(provider)}`, {
      method: "POST",
      body: returnTo ? { return_to: returnTo } : {},
    }),
  )
}

/** Every domain in this workspace, for the connect flow's follow-through. */
export async function listDomains() {
  return run(() => api<{ data: import("@/lib/types").Domain[] }>("/console/domains"))
}

export async function finishDnsConnect(input: {
  provider: string
  code: string
  state: string
}) {
  return run(
    () =>
      api<import("@/lib/types").DnsConnection & { return_to?: string }>(
        `/console/dns/callback/${encodeURIComponent(input.provider)}`,
        { method: "POST", body: { code: input.code, state: input.state } },
      ),
    ["/domains", "/settings"],
  )
}

export async function connectDnsWithToken(input: {
  provider: string
  token: string
  label?: string
}) {
  return run(
    () =>
      api<import("@/lib/types").DnsConnection>(
        `/console/dns/connections/${encodeURIComponent(input.provider)}/token`,
        {
          method: "POST",
          body: { token: input.token, ...(input.label ? { label: input.label } : {}) },
        },
      ),
    ["/domains", "/settings"],
  )
}

export async function disconnectDns(provider: string) {
  return run(
    () =>
      api<{ deleted: true }>(
        `/console/dns/connections/${encodeURIComponent(provider)}`,
        { method: "DELETE" },
      ),
    ["/domains", "/settings"],
    { refreshCaller: false },
  )
}

/**
 * Publishes a domain's records through a connected provider.
 *
 * ⚠ THE FIRST CALL IS A DRY RUN WHEREVER ANYTHING WOULD BE DELETED. The API
 * answers 409 with the conflicting records and writes nothing; the caller shows
 * them and calls again with `replaceConflicts`. That protocol is the reason this
 * returns the raw error rather than a boolean - the conflicts are in the body.
 */
export async function publishDnsRecords(input: {
  domainId: string
  provider: string
  replaceConflicts?: boolean
}) {
  return run(
    () =>
      api<import("@/lib/types").PublishOutcome>(
        `/console/domains/${encodeURIComponent(input.domainId)}/publish`,
        {
          method: "POST",
          body: {
            provider: input.provider,
            ...(input.replaceConflicts ? { replace_conflicts: true } : {}),
          },
        },
      ),
    [`/domains/${encodeURIComponent(input.domainId)}`, "/domains"],
  )
}

// ── Proving it is you ───────────────────────────────────────────────────────

/**
 * Ask the API whether this session has been proved recently enough to delete
 * something.
 *
 * ⚠ IT DOES NOTHING, AND THAT IS ITS ENTIRE VALUE. The step-up prompt works by
 * REPLAYING the call that was refused - so a flow that is more than one
 * request, like deleting a domain and revoking its keys, cannot be the thing
 * that triggers it: the replay would re-run the half that already succeeded.
 * Asking a route with no side effects is always safe to retry.
 *
 * ⚠ AND IT IS NOT THE GUARD. `requireFreshAuth` on the API still refuses the
 * routes that actually delete, so skipping this changes when somebody is asked
 * and not whether they are refused. See apps/api/src/middleware/session.ts.
 */
export async function stepUp() {
  return run(() => api<undefined>("/console/step-up"))
}

// ── API keys ────────────────────────────────────────────────────────────────

export async function createApiKey(input: {
  name: string
  mode: "live" | "test"
  /** Domain names to restrict it to; empty for every domain. */
  domains: string[]
}) {
  /*
   * ⚠ THE SECRET IS IN THIS RETURN VALUE AND NOWHERE ELSE, EVER. Nothing stores
   * it - see apps/api/src/auth/store.ts - so the component that receives it is
   * the last thing in the system that can show it. It must not be logged, must
   * not be put in a URL, and the dialog that renders it must not be
   * re-openable.
   */
  return run(
    () => api<CreatedApiKey>("/console/api-keys", { method: "POST", body: input }),
    ["/api-keys"],
  )
}

/**
 * Narrowing or widening a key that already exists.
 *
 * ⚠ IT EXISTS SO THE SCOPE IS NOT A DECISION MADE ONCE, IN A DIALOG, FOREVER.
 * The only other way to restrict a key minted unrestricted is to revoke it and
 * redeploy the secret everywhere it lives - enough friction that nobody does
 * it, which leaves every key unrestricted and the feature decorative.
 */
/** Empty `domains` is every domain. */
export async function updateApiKeyScope(id: string, domains: string[]) {
  return run(
    () =>
      api<ApiKeyRow>(`/console/api-keys/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { domains },
      }),
    ["/api-keys"],
  )
}

export async function revokeApiKey(id: string) {
  return run(
    () =>
      api<{ deleted: true }>(`/console/api-keys/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    ["/api-keys"],
    { refreshCaller: false },
  )
}

export async function rotateApiKey(id: string) {
  return run(
    () =>
      api<CreatedApiKey>(`/console/api-keys/${encodeURIComponent(id)}/rotate`, {
        method: "POST",
      }),
    ["/api-keys"],
  )
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export async function createWebhook(input: {
  url: string
  events: string[]
  description?: string
}) {
  return run(
    () =>
      api<WebhookEndpoint>("/console/webhook-endpoints", {
        method: "POST",
        body: input,
      }),
    ["/webhooks"],
  )
}

export async function deleteWebhook(id: string) {
  return run(
    () =>
      api<{ deleted: true }>(`/console/webhook-endpoints/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    ["/webhooks"],
    { refreshCaller: false },
  )
}

export async function rotateWebhookSecret(id: string) {
  return run(
    () =>
      api<WebhookEndpoint>(
        `/console/webhook-endpoints/${encodeURIComponent(id)}/rotate-secret`,
        {
          method: "POST",
        },
      ),
    ["/webhooks", `/webhooks/${encodeURIComponent(id)}`],
  )
}

// ── Suppressions ────────────────────────────────────────────────────────────

export async function addSuppression(address: string) {
  return run(
    () =>
      api<{ address: string }>("/console/suppressions", {
        method: "POST",
        body: { address },
      }),
    ["/suppressions"],
  )
}

export async function removeSuppression(
  address: string,
  { complaint = false }: { complaint?: boolean } = {},
) {
  return run(
    () =>
      api<{ deleted: true }>(
        // ⚠ ENCODED, BECAUSE AN ADDRESS IN A PATH SEGMENT IS NOT URL-SAFE. `+`
        // is the one that bites: `bob+news@acme.com` unencoded is parsed as a
        // space, so the delete silently misses exactly the addresses most
        // likely to have been suppressed.
        `/console/suppressions/${encodeURIComponent(address)}`,
        {
          method: "DELETE",
          // ⚠ THE API REFUSES A COMPLAINT WITHOUT THIS (#159). It is sent only
          // after the dialog has shown the complaint wording and the address
          // was typed back - never by default, or the guard would be a formality.
          query: { confirm: complaint ? "complaint" : undefined },
        },
      ),
    ["/suppressions"],
    { refreshCaller: false },
  )
}

// ── Onboarding ──────────────────────────────────────────────────────────────

export async function updateOnboarding(input: {
  step?: string
  use_case?: string
  completed?: boolean
}) {
  /*
   * ⚠ FINISHING CLEARS THE SKIP, OR THE SKIP OUTLIVES THE REASON FOR IT. The
   * cookie suppresses the console's redirect into this flow; the flow is also
   * re-opened deliberately when somebody upgrades off the free plan, which is
   * the one time there is genuinely something new to show them. A week-old
   * "I skipped it once" would swallow that, and the upgrade would look like it
   * did nothing. Completing is the moment the preference has served its
   * purpose.
   */
  if (input.completed === true) await forgetOnboardingSkip()

  return run(
    () =>
      api<import("@/lib/types").OnboardingState>("/console/onboarding", {
        method: "PATCH",
        body: input,
      }),
    ["/onboarding", "/"],
  )
}

// ── Contacts ────────────────────────────────────────────────────────────────

export async function createContact(input: {
  email: string
  first_name?: string | null
  last_name?: string | null
}) {
  return run(
    () => api<ContactRow>("/console/contacts", { method: "POST", body: input }),
    ["/contacts"],
  )
}

export async function updateContact(
  id: string,
  patch: {
    first_name?: string | null
    last_name?: string | null
    unsubscribed?: boolean
    properties?: Record<string, unknown> | null
  },
) {
  return run(
    () =>
      api<ContactRow>(`/console/contacts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: patch,
      }),
    ["/contacts", `/contacts/${encodeURIComponent(id)}`],
  )
}

export async function deleteContacts(ids: string[]) {
  return run(
    () =>
      api<{ deleted: number }>("/console/contacts/bulk-delete", {
        method: "POST",
        body: { ids },
      }),
    ["/contacts"],
    { refreshCaller: false },
  )
}

export async function importContacts(csv: string) {
  return run(
    () =>
      api<{ parsed: number; created: number; updated: number; invalid: number }>(
        "/console/contacts/import",
        { method: "POST", rawBody: csv, contentType: "text/csv" },
      ),
    ["/contacts", "/segments"],
  )
}

// ── Properties ──────────────────────────────────────────────────────────────

export async function createProperty(input: {
  key: string
  type: string
  fallback_value?: string | null
}) {
  return run(
    () =>
      api<PropertyRow>("/console/contact-properties", { method: "POST", body: input }),
    ["/contacts", "/contacts/properties"],
  )
}

export async function deleteProperty(id: string) {
  return run(
    () =>
      api<{ deleted: true }>(`/console/contact-properties/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    ["/contacts", "/contacts/properties"],
    { refreshCaller: false },
  )
}

// ── Segments ────────────────────────────────────────────────────────────────

export async function createSegment(input: { name: string; description?: string }) {
  return run(
    () => api<SegmentRow>("/console/segments", { method: "POST", body: input }),
    ["/segments"],
  )
}

export async function updateSegment(
  id: string,
  patch: { name?: string; description?: string | null },
) {
  return run(
    () =>
      api(`/console/segments/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: patch,
      }),
    ["/segments", `/segments/${encodeURIComponent(id)}`],
  )
}

export async function deleteSegment(id: string) {
  return run(
    () =>
      api<{ deleted: true }>(`/console/segments/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    ["/segments"],
    { refreshCaller: false },
  )
}

export async function addToSegment(segmentId: string, contactIds: string[]) {
  return run(
    () =>
      api<{ added: number }>(
        `/console/segments/${encodeURIComponent(segmentId)}/contacts`,
        {
          method: "POST",
          body: { contact_ids: contactIds },
        },
      ),
    ["/segments", `/segments/${encodeURIComponent(segmentId)}`, "/contacts"],
  )
}

export async function removeFromSegment(segmentId: string, contactIds: string[]) {
  return run(
    () =>
      api<{ removed: number }>(
        `/console/segments/${encodeURIComponent(segmentId)}/contacts/remove`,
        {
          method: "POST",
          body: { contact_ids: contactIds },
        },
      ),
    ["/segments", `/segments/${encodeURIComponent(segmentId)}`],
  )
}

// ── Topics ──────────────────────────────────────────────────────────────────

export async function createTopic(input: {
  name: string
  description?: string
  default_subscription: "opt_in" | "opt_out"
  visibility: "private" | "public"
}) {
  return run(
    () => api<TopicRow>("/console/topics", { method: "POST", body: input }),
    ["/topics"],
  )
}

export async function updateTopic(
  id: string,
  patch: { name?: string; description?: string | null; visibility?: string },
) {
  return run(
    () =>
      api(`/console/topics/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: patch,
      }),
    ["/topics"],
  )
}

export async function deleteTopic(id: string) {
  return run(
    () =>
      api<{ deleted: true }>(`/console/topics/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    ["/topics"],
    { refreshCaller: false },
  )
}

export async function setTopicSubscription(
  contactId: string,
  topicId: string,
  subscribed: boolean,
) {
  return run(
    () =>
      api(
        `/console/contacts/${encodeURIComponent(contactId)}/topics/${encodeURIComponent(topicId)}`,
        {
          method: "PUT",
          body: { subscribed },
        },
      ),
    [`/contacts/${encodeURIComponent(contactId)}`, "/topics"],
  )
}

// ── Broadcasts ──────────────────────────────────────────────────────────────

export async function createBroadcast(input: { name: string }) {
  return run(
    () =>
      api<import("@/lib/types").BroadcastRow>("/console/broadcasts", {
        method: "POST",
        body: input,
      }),
    ["/broadcasts"],
  )
}

/**
 * ⚠ THE PATCH IS TYPED RATHER THAN `Record<string, unknown>`, AND THE REASON IS
 * A BUG THAT SHIPPED ONCE. An untyped patch is the last place the wire names
 * and the API's field names could have been checked against each other, and
 * with it untyped nothing noticed that `segment_id` was being dropped on every
 * save - the request succeeded, the toast said "Saved", and the broadcast came
 * back targeted at nothing.
 */
export interface BroadcastPatch {
  segment_id?: string | null
  topic_id?: string | null
  name?: string
  from?: string
  reply_to?: string[]
  subject?: string
  preview_text?: string | null
  html?: string | null
  text?: string | null
  scheduled_at?: string | null
}

export async function updateBroadcast(id: string, patch: BroadcastPatch) {
  return run(
    () =>
      api<import("@/lib/types").BroadcastRow>(
        `/console/broadcasts/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: patch,
        },
      ),
    ["/broadcasts", `/broadcasts/${encodeURIComponent(id)}`],
  )
}

export async function deleteBroadcast(id: string) {
  return run(
    () =>
      api<{ deleted: true }>(`/console/broadcasts/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    ["/broadcasts"],
    { refreshCaller: false },
  )
}

// ── Templates ───────────────────────────────────────────────────────────────

export async function createTemplate(input: {
  name: string
  folder?: string | null
  kind?: "html" | "visual"
}) {
  return run(
    () => api<TemplateRow>("/console/templates", { method: "POST", body: input }),
    ["/templates"],
  )
}

export async function updateTemplate(id: string, patch: Record<string, unknown>) {
  return run(
    () =>
      api<TemplateRow>(`/console/templates/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: patch,
      }),
    ["/templates", `/templates/${encodeURIComponent(id)}`],
  )
}

export async function publishTemplate(id: string) {
  return run(
    () =>
      api<TemplateRow>(`/console/templates/${encodeURIComponent(id)}/publish`, {
        method: "POST",
      }),
    ["/templates", `/templates/${encodeURIComponent(id)}`],
  )
}

export async function deleteTemplate(id: string) {
  return run(
    () =>
      api<{ deleted: true }>(`/console/templates/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    ["/templates"],
    { refreshCaller: false },
  )
}

/**
 * The files of an upload, from the form the browser sent: each entry's name is
 * the file's path in the upload, and its value the file.
 *
 * ⚠ FORM DATA RATHER THAN JSON, BECAUSE THE FILES ARE CODE. JSON-escaping
 * source text inflates it by a third, and a folder of templates is the largest
 * thing the console ever sends; `serverActions.bodySizeLimit` is sized for the
 * raw files (see next.config.ts). The API applies the real limits.
 */
async function filesOf(form: FormData): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const [path, value] of form.entries()) {
    if (path.startsWith("$")) continue // our own fields, not files
    const entry: unknown = value
    files[path] = entry instanceof Blob ? await entry.text() : String(entry)
  }
  return files
}

/** A folder of templates, or several `.tsx` files (#234). */
export async function uploadTemplates(form: FormData) {
  const files = await filesOf(form)
  return run(
    () =>
      api<{ data: TemplateUploadOutcome[]; problems: string[] }>(
        "/console/templates/upload",
        { method: "POST", body: { files } },
      ),
    ["/templates"],
    { refreshCaller: false },
  )
}

/**
 * A new version of one template: its entry, and the files it imports.
 * `$entry` in the form names the entry.
 */
export async function uploadTemplateVersion(id: string, form: FormData) {
  const entry = form.get("$entry")
  const files = await filesOf(form)
  return run(
    () =>
      api<TemplateVersionDetail & { unchanged: boolean }>(
        `/console/templates/${encodeURIComponent(id)}/versions`,
        {
          method: "POST",
          body: { entry: typeof entry === "string" ? entry : "", files },
        },
      ),
    ["/templates", `/templates/${encodeURIComponent(id)}`],
  )
}

/**
 * An image for the visual editor (#244): stored once per workspace in the
 * public template images bucket, and its URL returned for the email.
 *
 * ⚠ THE BYTES GO TO THE API AS THEY ARE. The API reads the type from them and
 * refuses anything but PNG, JPEG, GIF and WebP; what the browser said the file
 * was is not passed on, because it is not evidence.
 */
export async function uploadTemplateImage(form: FormData) {
  const file: unknown = form.get("file")
  if (!(file instanceof Blob)) {
    return {
      ok: false as const,
      error: "Choose an image.",
      name: "validation_error",
      status: 422,
    }
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (PREVIEW) {
    // Nothing is stored in preview mode; the image is shown from itself.
    const type = file.type || "image/png"
    return {
      ok: true as const,
      data: { url: `data:${type};base64,${Buffer.from(bytes).toString("base64")}` },
    }
  }
  return run(
    () =>
      api<{ url: string; sha256: string; content_type: string; size: number }>(
        "/console/templates/assets",
        { method: "POST", rawBody: bytes, contentType: "application/octet-stream" },
      ),
    [],
    { refreshCaller: false },
  )
}

/** Makes an existing version live. Rolling back is promoting an older one. */
export async function promoteTemplateVersion(id: string, number: number) {
  return run(
    () =>
      api<TemplateRow>(
        `/console/templates/${encodeURIComponent(id)}/versions/${number}/promote`,
        { method: "POST" },
      ),
    ["/templates", `/templates/${encodeURIComponent(id)}`],
  )
}

/**
 * Puts an earlier version back into the draft, to edit from there (#243).
 *
 * ⚠ THE DRAFT CHANGES; WHAT IS SENT DOES NOT. Nothing goes live until the
 * draft is published, which makes a new version - the old one stays exactly
 * as it was. The HTML copied is the readable form, `{{ name }}` where the
 * variables go, which is what the editor works in.
 */
export async function restoreTemplateDraft(id: string, number: number) {
  return run(async () => {
    const version = await api<TemplateVersionDetail>(
      `/console/templates/${encodeURIComponent(id)}/versions/${number}`,
    )
    return api<TemplateRow>(`/console/templates/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: {
        subject: version.subject,
        html: version.display.html,
        text: version.display.text,
        ...(version.kind === "visual" ? { design: version.design ?? null } : {}),
      },
    })
  }, ["/templates", `/templates/${encodeURIComponent(id)}`])
}

/**
 * ⚠ READS, NOT WRITES, so neither revalidates nor refreshes. A preview is
 * asked for on every edit of a sample value, and a refresh per keystroke would
 * re-render the page under somebody's cursor.
 */
export async function previewTemplateVersion(
  id: string,
  number: number,
  variables?: Record<string, unknown>,
) {
  return run(
    () =>
      api<TemplatePreview>(
        `/console/templates/${encodeURIComponent(id)}/versions/${number}/preview`,
        { method: "POST", body: variables ? { variables } : {} },
      ),
    [],
    { refreshCaller: false },
  )
}

export async function templateVersion(id: string, number: number) {
  return run(
    () =>
      api<TemplateVersionDetail>(
        `/console/templates/${encodeURIComponent(id)}/versions/${number}`,
      ),
    [],
    { refreshCaller: false },
  )
}

// ── Templates submitted for review (#222) ───────────────────────────────────

export async function submitTrustedTemplate(input: {
  name: string
  html: string | null
  text: string | null
  holes: Record<string, number>
}) {
  return run(
    () =>
      api<TrustedTemplateRow>("/console/trusted-templates", {
        method: "POST",
        body: input,
      }),
    ["/templates"],
  )
}

export async function withdrawTrustedTemplate(id: string) {
  return run(
    () =>
      api<TrustedTemplateRow>(`/console/trusted-templates/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    ["/templates"],
  )
}

// ── Billing ─────────────────────────────────────────────────────────────────

/**
 * ⚠ THIS STARTS A CHECKOUT AND GRANTS NOTHING. The plan moves when Polar's
 * signature-verified webhook says the money arrived - see
 * apps/api/src/routes/billing.ts. The URL returned here is a redirect target,
 * not evidence of anything, and the page Polar returns to polls for the grant.
 *
 * ⚠ AND IT GOES THROUGH `/console/billing/checkout`, NOT `/billing/checkout`.
 * The two are the same operation behind two different credentials: `/billing`
 * takes an API key, which a browser does not have and must not be given. They
 * share one Polar client and one product map, so there is no second price list
 * to disagree with the first.
 */
/**
 * @param returnTo Where Polar should send the browser afterwards - a path on
 * this console, so somebody who bought a plan mid-onboarding comes back to
 * onboarding rather than to a confirmation page with no way onward. The API
 * keeps its own origin and accepts only the path; see routes/console/account.ts.
 */
export async function startCheckout(plan: string, returnTo?: string) {
  return run(async () => {
    const result = await api<{ id?: string; url?: string; expiresAt?: string }>(
      "/console/billing/checkout",
      { method: "POST", body: { plan, ...(returnTo ? { return_to: returnTo } : {}) } },
    )

    /*
     * ⚠ THE URL IS CHECKED HERE RATHER THAN TRUSTED BY THE CALLER, AND THAT IS
     * NOT DEFENSIVE PROGRAMMING FOR ITS OWN SAKE. The caller's next act is
     * `window.location.assign(...)`; an absent url there is an uncaught
     * TypeError in a click handler, which React surfaces as an error overlay
     * over the billing page - the single worst place in the product to show
     * somebody a stack trace, because they were about to pay us.
     *
     * ⚠ AND IT IS A REAL CASE, NOT A HYPOTHETICAL. A 501 from an unconfigured
     * `billing` dep, a Polar outage answered as an empty body, and preview mode
     * before it had a fixture for this route all produce exactly this shape.
     * Turning it into an ordinary failed `ActionResult` means the button shows
     * a toast and stays clickable.
     */
    if (typeof result?.url !== "string" || result.url.length === 0) {
      throw new ApiRequestError(502, {
        statusCode: 502,
        name: "internal_server_error",
        message: "Checkout did not come back with a payment link. Try again.",
      })
    }

    return {
      // ⚠ MAY BE ABSENT, AND THE CALLER TREATS IT AS OPTIONAL. An older API
      // build returns no id; the checkout still works, it just falls back to
      // trusting Polar's event alone. See lib/polar-embed.ts.
      id: result.id ?? null,
      url: result.url,
      expiresAt: result.expiresAt ?? null,
    }
  })
}

/**
 * A short-lived token for Polar's embedded card form.
 *
 * ⚠ IT IS A CREDENTIAL, SO IT IS FETCHED WHEN THE BUTTON IS PRESSED RATHER THAN
 * RENDERED INTO THE PAGE. A token minted during server rendering would sit in
 * the HTML of every billing page load, including the ones nobody interacts
 * with, and would be in the RSC payload of a page somebody might screenshot.
 * One hour of validity for one customer is small, and it should still only
 * exist because somebody asked to add a card.
 */
export async function paymentMethodSession() {
  return run(async () => {
    const result = await api<{ token?: string }>(
      "/console/billing/payment-method-session",
      { method: "POST" },
    )

    if (typeof result?.token !== "string" || result.token.length === 0) {
      throw new ApiRequestError(502, {
        statusCode: 502,
        name: "internal_server_error",
        message: "Could not open the card form. Try again in a moment.",
      })
    }

    return { token: result.token }
  })
}

/**
 * Moving a live subscription between plans.
 *
 * ⚠ A DIFFERENT CALL FROM `startCheckout`, AND THE CONSOLE PICKS BETWEEN THEM
 * BY WHETHER A SUBSCRIPTION ALREADY EXISTS. Sending an existing customer
 * through checkout again creates a SECOND subscription and bills them twice;
 * sending a new one through a plan change has nothing to change. The rule is in
 * the plan cards, which read `billing.subscription`.
 *
 * ⚠ IT ANSWERS 202 AND THE ENTITLEMENT HAS NOT MOVED YET. Polar has accepted
 * the change; the grant arrives on their webhook. The UI polls rather than
 * assuming.
 */
export async function changePlan(plan: string) {
  return run(
    () =>
      api<{ status: string; plan?: string }>("/console/billing/plan", {
        method: "POST",
        body: { plan },
      }),
    ["/settings/billing", "/settings/usage", "/"],
  )
}

/**
 * Calls off a cancellation that has not taken effect yet.
 *
 * ⚠ THE SAME REVALIDATION LIST AS `changePlan`, because the same pages are
 * wrong afterwards: the billing page stops saying "Ending", the usage page
 * keeps the paid allowance it was about to lose, and the overview's rail
 * follows both.
 */
export async function resumeSubscription() {
  return run(
    () => api<{ status: string }>("/console/billing/resume", { method: "POST" }),
    ["/settings/billing", "/settings/usage", "/"],
  )
}
