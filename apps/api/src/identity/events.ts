import {
  onUserUpdated,
  planSweep,
  revokeNow,
  sessionCreatedOf,
  type ManagedDeps,
  type SweepJob,
} from "./managed.js"

/**
 * Clerk's webhooks, for the identity core (#337).
 *
 *   - `session.created`: the sweeper (sso.md 2.2, layer 3). A managed
 *     account's session from anything but a ticket is revoked now; a ticket
 *     session is checked for its bind two minutes later.
 *   - `user.updated`: the watchdog. A managed account that gained a password,
 *     a social account, a passkey, 2FA or an address is put back.
 *   - `user.deleted`: the person's links and managed row go, so their IdP
 *     subject does not stay pointed at an account that no longer exists.
 *
 * ⚠ NEEDS `session.created` SUBSCRIBED ON CLERK'S WEBHOOK ENDPOINT, on both
 * instances, beside the `user.*` events the projection already takes. Without
 * it there is no sweeper; the gateway and the gate still stand.
 *
 * ⚠ OUTSIDE THE SVIX DEDUPE AND IDEMPOTENT, like the other handlers there: a
 * revoke or fix that failed once is retried by Svix, and running any of these
 * twice changes nothing the first run did not.
 */
export async function onIdentityClerkEvent(
  d: ManagedDeps & { schedule: (job: SweepJob) => Promise<void> },
  type: string,
  data: unknown,
): Promise<string | null> {
  switch (type) {
    case "session.created": {
      const event = sessionCreatedOf(data)
      if (!event) return null
      const plan = await planSweep(d, event)
      if (plan.action === "none") return null
      if (plan.action === "revoke") {
        await revokeNow(d, event, plan.reason)
        return "sso:revoked"
      }
      await d.schedule({
        sessionId: event.sessionId,
        userId: event.userId,
        dueAt: plan.at.getTime(),
      })
      return "sso:sweep_scheduled"
    }
    case "user.updated":
      return onUserUpdated(d, data)
    case "user.deleted": {
      const id = (data as { id?: unknown } | null)?.id
      if (typeof id !== "string") return null
      const managed = await d.store.managedByUser(id)
      if (!managed) return null
      await d.store.forgetUser(managed.tenantId, id)
      await d.store.record(managed.tenantId, {
        type: "managed.deleted",
        subjectUserId: id,
        reason: "user.deleted",
      })
      return "managed:forgotten"
    }
    default:
      return null
  }
}
