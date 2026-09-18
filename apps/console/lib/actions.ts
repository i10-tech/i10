"use server"

import { revalidatePath } from "next/cache"
import { api, ApiRequestError } from "@/lib/api"
import { forgetOnboardingSkip } from "@/lib/onboarding-skip"
import type {
  ContactRow,
  CreatedApiKey,
  Domain,
  PropertyRow,
  SegmentRow,
  TemplateRow,
  TopicRow,
  WebhookEndpoint,
} from "@/lib/types"

/**
 * Every mutation the console performs.
 *
 * ⚠ SERVER ACTIONS RATHER THAN ROUTE HANDLERS, FOR ONE REASON THAT MATTERS: the
 * session token never reaches the browser. A `fetch` from a client component to
 * our own `/api/...` would work too, but it needs a second layer of handlers
 * that do nothing but forward — and each one is another place to forget the
 * auth header or the tenant check. The action runs on the server, calls
 * `api()`, and the client gets a plain object back.
 *
 * ⚠ THEY RETURN A RESULT, THEY DO NOT THROW. A thrown error in a server action
 * reaches the client as an opaque "An error occurred in the Server Components
 * render" with the message stripped in production — which is exactly the
 * message the person needs ("that domain is already registered", "your plan
 * does not include another domain"). Returning a discriminated union keeps the
 * API's own wording, including its machine-readable `name`, which the forms
 * branch on to decide between an inline field error and an upgrade prompt.
 *
 * ⚠ AND EVERY ONE OF THEM REVALIDATES. A server action that mutates without
 * `revalidatePath` leaves the page showing the list it rendered before the
 * write — the row is created, the screen says it is not, and the person clicks
 * the button again.
 */

export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string; name: string; status: number }

async function run<T>(
  fn: () => Promise<T>,
  revalidate: string[] = [],
): Promise<ActionResult<T>> {
  try {
    const data = await fn()
    for (const path of revalidate) {
      // ⚠ `"page"` RATHER THAN THE DEFAULT `"layout"`. Revalidating as a layout
      // invalidates every nested route under the path, which for `/` is the
      // entire console — so creating one API key would discard the cached
      // render of every page the person has visited.
      revalidatePath(path, "page")
    }
    return { ok: true, data }
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return {
        ok: false,
        error: error.body.message,
        name: error.body.name,
        status: error.status,
      }
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Something went wrong.",
      name: "internal_server_error",
      status: 500,
    }
  }
}

// ── Workspace ───────────────────────────────────────────────────────────────

export async function renameWorkspace(name: string) {
  return run(
    () =>
      api<{ ok: true; name: string }>("/console/me/tenant", {
        method: "PATCH",
        body: { name },
      }),
    ["/settings"],
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
      api<Domain>(`/console/domains/${encodeURIComponent(id)}/verify`, {
        method: "POST",
      }),
    [`/domains/${encodeURIComponent(id)}`, "/domains"],
  )
}

export async function deleteDomain(id: string) {
  return run(
    () =>
      api<{ deleted: true }>(`/console/domains/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    ["/domains", "/"],
  )
}

export async function lookupDns(domain: string) {
  // ⚠ NO REVALIDATION: THIS IS A READ. It is an action rather than a loader
  // because it runs in response to typing, not to navigation — the onboarding
  // form asks it as the person finishes entering an apex.
  return run(() =>
    api<import("@/lib/types").DnsInspection>("/console/dns/lookup", {
      query: { domain },
    }),
  )
}

// ── API keys ────────────────────────────────────────────────────────────────

export async function createApiKey(input: { name: string; mode: "live" | "test" }) {
  /*
   * ⚠ THE SECRET IS IN THIS RETURN VALUE AND NOWHERE ELSE, EVER. Nothing stores
   * it — see apps/api/src/auth/store.ts — so the component that receives it is
   * the last thing in the system that can show it. It must not be logged, must
   * not be put in a URL, and the dialog that renders it must not be
   * re-openable.
   */
  return run(
    () => api<CreatedApiKey>("/console/api-keys", { method: "POST", body: input }),
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

export async function removeSuppression(address: string) {
  return run(
    () =>
      api<{ deleted: true }>(
        // ⚠ ENCODED, BECAUSE AN ADDRESS IN A PATH SEGMENT IS NOT URL-SAFE. `+`
        // is the one that bites: `bob+news@acme.com` unencoded is parsed as a
        // space, so the delete silently misses exactly the addresses most
        // likely to have been suppressed.
        `/console/suppressions/${encodeURIComponent(address)}`,
        { method: "DELETE" },
      ),
    ["/suppressions"],
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
 * save — the request succeeded, the toast said "Saved", and the broadcast came
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
  )
}

// ── Templates ───────────────────────────────────────────────────────────────

export async function createTemplate(input: { name: string; folder?: string | null }) {
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
  )
}

// ── Billing ─────────────────────────────────────────────────────────────────

/**
 * ⚠ THIS STARTS A CHECKOUT AND GRANTS NOTHING. The plan moves when Polar's
 * signature-verified webhook says the money arrived — see
 * apps/api/src/routes/billing.ts. The URL returned here is a redirect target,
 * not evidence of anything, and the page Polar returns to polls for the grant.
 *
 * ⚠ AND IT GOES THROUGH `/console/billing/checkout`, NOT `/billing/checkout`.
 * The two are the same operation behind two different credentials: `/billing`
 * takes an API key, which a browser does not have and must not be given. They
 * share one Polar client and one product map, so there is no second price list
 * to disagree with the first.
 */
export async function startCheckout(plan: string) {
  return run(async () => {
    const result = await api<{ url?: string; expiresAt?: string }>(
      "/console/billing/checkout",
      { method: "POST", body: { plan } },
    )

    /*
     * ⚠ THE URL IS CHECKED HERE RATHER THAN TRUSTED BY THE CALLER, AND THAT IS
     * NOT DEFENSIVE PROGRAMMING FOR ITS OWN SAKE. The caller's next act is
     * `window.location.assign(...)`; an absent url there is an uncaught
     * TypeError in a click handler, which React surfaces as an error overlay
     * over the billing page — the single worst place in the product to show
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

    return { url: result.url, expiresAt: result.expiresAt ?? null }
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
