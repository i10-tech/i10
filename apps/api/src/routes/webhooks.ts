import { Hono } from "hono"
import type { Database } from "../db/client.js"
import { applyClerkEvent } from "../projection/writer.js"
import type { TenantProvisioning } from "../tenants/provision.js"
import type { TenantLifecycle } from "../tenants/lifecycle.js"
import type { authEmailDelivery } from "../auth-email/deliver.js"
import { readSvixHeaders, verifySvixSignature } from "../webhooks/svix.js"

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

export interface ClerkWebhookDeps {
  db: Database
  signingSecret: string
  hostedDomains: readonly string[]
  /**
   * Creates tenants from Clerk organizations, and organizations for users who
   * have none. Absent in tests and where Clerk cannot be reached, in which case
   * sign-ups still update the mailbox projection and simply provision nothing.
   */
  provisioning?: TenantProvisioning
  /**
   * The other half of provisioning: a deleted organization stops being a
   * tenant, and stops being billed.
   *
   * ⚠ ABSENT MEANS A DELETED WORKSPACE KEEPS PAYING, WHICH IS WHY IT IS WIRED
   * WHEREVER PROVISIONING IS. Without it `organization.deleted` falls through
   * to `ignored` — the state this endpoint was in until it was found: an
   * account deleted in Clerk left `core.tenants` saying `active`, the plan
   * assignment on Pro, and Polar charging a card every month for a workspace
   * nobody could sign in to.
   */
  lifecycle?: TenantLifecycle
  /**
   * Sends Clerk's authentication mail through our own send path.
   *
   * ⚠ ABSENT MEANS CLERK KEEPS SENDING IT, WHICH IS THE SAFE DEFAULT. An
   * unconfigured deployment must not silently swallow verification codes — with
   * this undefined the event is acknowledged and Clerk's own delivery, which is
   * still switched on per template, remains the only sender.
   */
  authEmail?: ReturnType<typeof authEmailDelivery>
  log?: Logger
}

/**
 * Receives Clerk's webhooks and maintains the mailbox projection.
 *
 * The projection is what `services/authd` serves to Stalwart, so this endpoint
 * decides which addresses exist as local recipients. Nothing reaches the
 * database before the Svix signature verifies.
 *
 * On status codes — Svix retries anything that is not 2xx, with backoff, then
 * gives up:
 *
 *   401  bad or missing signature. Retrying will not help, but answering 200 to
 *        an unverified request would tell a forger it worked.
 *   400  signed by us and still unparseable, so a contract change rather than
 *        an attack. Retrying will not fix it; take it off the queue and be loud.
 *   200  accepted, ignored, stale, or a duplicate. All mean "stop sending this".
 *   500  we failed to process a genuine event. Retry is exactly right, and the
 *        transaction rolled back so the retry is not swallowed as a duplicate.
 */
export function createClerkWebhooks(deps?: ClerkWebhookDeps) {
  const app = new Hono()

  app.post("/clerk", async (c) => {
    if (!deps) {
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Webhook processing is not configured.",
        },
        503,
      )
    }

    // ⚠ VERIFY THE RAW BYTES. The signature covers the exact text received;
    // parsing to JSON and re-serialising changes key order and whitespace, and
    // every delivery would fail to verify.
    const body = await c.req.text()
    const headers = readSvixHeaders((name) => c.req.header(name))

    const verified = verifySvixSignature(body, headers, deps.signingSecret)
    if (!verified.ok) {
      deps.log?.warn(
        { reason: verified.reason, svixId: headers.id },
        "rejected clerk webhook",
      )
      return c.json(
        { statusCode: 401, name: "invalid_access", message: "Invalid signature." },
        401,
      )
    }

    let event: { type?: unknown; data?: unknown }
    try {
      event = JSON.parse(body) as { type?: unknown; data?: unknown }
    } catch {
      deps.log?.error({ svixId: headers.id }, "clerk webhook body is not JSON")
      return c.json(
        { statusCode: 400, name: "validation_error", message: "Body is not JSON." },
        400,
      )
    }

    if (typeof event.type !== "string") {
      deps.log?.error({ svixId: headers.id }, "clerk webhook has no event type")
      return c.json(
        { statusCode: 400, name: "validation_error", message: "Missing event type." },
        400,
      )
    }

    try {
      const result = await applyClerkEvent(
        deps.db,
        headers.id!,
        event.type,
        event.data,
        deps.hostedDomains,
      )
      // ⚠ RUN EVEN WHEN `applyClerkEvent` SAID `duplicate`, AND THAT IS THE
      // WHOLE REASON IT IS OUT HERE RATHER THAN INSIDE THE SWITCH. That dedupe
      // claims the Svix message id and discards a redelivery, which is right
      // for the mailbox projection — the second copy has nothing new to say.
      // Provisioning is the opposite: if it failed the first time, the retry is
      // the only chance to fix it, and swallowing that leaves somebody with an
      // account that can never send. Both halves are idempotent on their own.
      const provisioned = await provision(deps, event.type, event.data)

      // ⚠ OUTSIDE THE DEDUPE FOR THE SAME REASON PROVISIONING IS, and safe for
      // a different one. `applyClerkEvent` claims the Svix id and answers
      // `duplicate` on a redelivery — skipping the send on that basis would
      // mean a send that failed once is never retried, and somebody's code
      // never arrives. Instead the send path is keyed on Clerk's own email id,
      // so a redelivery is refused there rather than here.
      const emailed =
        event.type === "email.created" && deps.authEmail
          ? await deps.authEmail.onEmailCreated(event.data)
          : undefined

      deps.log?.info(
        {
          svixId: headers.id,
          type: event.type,
          outcome: result.outcome,
          ...(provisioned ? { provisioned } : {}),
          ...(emailed ? { emailed } : {}),
        },
        "clerk webhook applied",
      )
      return c.json({
        ok: true,
        ...result,
        ...(provisioned ? { provisioned } : {}),
        ...(emailed ? { emailed } : {}),
      })
    } catch (err) {
      deps.log?.error(
        { svixId: headers.id, type: event.type, err: String(err) },
        "clerk webhook failed",
      )
      return c.json(
        {
          statusCode: 500,
          name: "internal_server_error",
          message: "Could not process the event.",
        },
        500,
      )
    }
  })

  return app
}

/**
 * ⚠ THROWS RATHER THAN SWALLOWS, so the caller answers 500 and Svix retries.
 * A sign-up that produced no tenant is an account that cannot send, and the
 * customer's only signal would be a 401 on their first API call — a retry is
 * both free and the correct repair.
 */
async function provision(
  deps: ClerkWebhookDeps,
  type: string,
  data: unknown,
): Promise<string | null> {
  switch (type) {
    case "user.created":
      return deps.provisioning?.onUserCreated(data) ?? null
    case "organization.created":
      return deps.provisioning?.onOrganizationCreated(data) ?? null

    /*
     * ⚠ DELETION RUNS THROUGH THE SAME FUNCTION AS CREATION, AND THEREFORE
     * OUTSIDE THE SVIX DEDUPE, FOR THE IDENTICAL REASON. `applyClerkEvent`
     * claims the message id and answers `duplicate` on a redelivery — right for
     * the mailbox projection, wrong here: if the Polar revoke failed the first
     * time, the retry is the only thing that stops the billing, and a dedupe
     * that swallowed it would leave a deleted account paying for ever. Both
     * handlers below are idempotent by themselves.
     *
     * ⚠ AND `user.deleted` REACHES BOTH HALVES. The projection removes their
     * mailbox; this asks whether the workspaces they owned went with them. They
     * are different questions about the same event and neither subsumes the
     * other.
     */
    case "organization.deleted":
      return deps.lifecycle?.onOrganizationDeleted(data) ?? null

    /*
     * ⚠ THE ECHO OF OUR OWN RENAME ARRIVES HERE, AND IT HAS TO BE HARMLESS.
     * `PATCH /console/me/tenant` renames our row and then asks Clerk to match;
     * Clerk answers by firing this for the change we just made. The handler
     * writes nothing when the name already agrees, so the exchange ends after
     * one round trip rather than ringing back and forth.
     */
    case "organization.updated":
      return deps.lifecycle?.onOrganizationUpdated(data) ?? null
    case "user.deleted":
      return deps.lifecycle?.onUserDeleted(data) ?? null

    default:
      return null
  }
}
