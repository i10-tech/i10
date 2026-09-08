import { renderClerkEmail, SLUG, type ClerkEmailPayload } from "@repo/emails"

/**
 * Sending Clerk's authentication mail ourselves.
 *
 * ⚠ THE WHOLE POINT IS THAT CLERK STOPS BEING THE SENDER, and the switch is
 * PER TEMPLATE rather than global — Clerk has no way to disable its delivery
 * for everything at once. So during the migration both states exist side by
 * side, and `delivered_by_clerk` on each event is the only thing that says
 * which. Ignoring it does not fail loudly; it sends every customer two copies
 * of their verification code.
 *
 * ⚠ AND THE IDEMPOTENCY KEY IS CLERK'S EMAIL ID, NOT THE SVIX MESSAGE ID. Svix
 * retries, and the projection's dedupe table claims the Svix id inside a
 * transaction that commits BEFORE we have sent anything — so keying off that
 * would mean a send that failed once is skipped as a duplicate forever, and the
 * person never gets their code. The email id is stable across redeliveries and
 * is handed to the send path, which already refuses to write the same key
 * twice. Retries become free, and a failure retries properly.
 */

export interface AuthEmailSend {
  /** The address Clerk addressed. */
  to: string
  subject: string
  html: string
  text?: string
  /** Clerk's email id, used as the send path's idempotency key. */
  idempotencyKey: string
}

export interface AuthEmailSender {
  send(input: AuthEmailSend): Promise<void>
}

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
}

export interface DeliverDeps {
  sender: AuthEmailSender
  log?: Logger
}

export type DeliverOutcome =
  /** We rendered and queued it. */
  | "sent"
  /** Clerk still owns this template's delivery — see the note above. */
  | "clerk_delivers"
  /** No recipient, or nothing to render and no body from Clerk either. */
  | "nothing_to_send"

interface EmailEvent extends ClerkEmailPayload {
  id?: string
  to_email_address?: string
  delivered_by_clerk?: boolean
}

export function authEmailDelivery(deps: DeliverDeps) {
  return {
    async onEmailCreated(data: unknown): Promise<DeliverOutcome> {
      const event = (data ?? {}) as EmailEvent

      // ⚠ CHECKED BEFORE ANYTHING ELSE, INCLUDING RENDERING. Rendering first
      // would waste the work, but more importantly it would put a code we are
      // not going to send into a log line if anything below threw.
      if (event.delivered_by_clerk) return "clerk_delivers"

      const to = event.to_email_address
      if (!to) {
        deps.log?.warn({ slug: event.slug }, "clerk email has no recipient")
        return "nothing_to_send"
      }

      const rendered = await renderClerkEmail(event)
      if (!rendered) {
        deps.log?.warn({ slug: event.slug }, "clerk email has nothing to render")
        return "nothing_to_send"
      }

      // ⚠ LOGGED FOR EVERY SLUG WE DO NOT RECOGNISE, AND THIS IS HOW THE SLUG
      // TABLE GETS FILLED IN. Clerk does not publish the identifiers anywhere —
      // one real send of each template puts the exact string in the logs, and
      // until then those emails go out in Clerk's own styling rather than
      // failing.
      if (!TEMPLATED.has(event.slug ?? "")) {
        deps.log?.info(
          { slug: event.slug ?? null },
          "clerk email sent with clerk's own body — add this slug to @repo/emails",
        )
      }

      await deps.sender.send({
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        // ⚠ FALLS BACK TO THE ADDRESS AND SLUG WHEN CLERK SENDS NO ID. An
        // idempotency key that changed every retry would be worse than none at
        // all: it would send a fresh copy on each redelivery. This pair is
        // stable for one logical email even when the id is missing.
        idempotencyKey: event.id ?? `${event.slug ?? "email"}:${to}`,
      })

      return "sent"
    },
  }
}

/**
 * The slugs we have a template for.
 *
 * ⚠ DERIVED FROM THE REGISTRY ITSELF, NOT LISTED AGAIN HERE. A second copy of
 * this list would drift the first time somebody added a template, and the only
 * symptom would be a log line that stopped appearing — which nobody notices.
 */
const TEMPLATED = new Set<string>(Object.values(SLUG))
