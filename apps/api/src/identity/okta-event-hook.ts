import { z } from "zod"
import {
  hashSecret,
  newSecret,
  normaliseEmail,
  sameHash,
  type Connection,
} from "./model.js"
import type { IdentityStore, Logger } from "./ports.js"

/**
 * Okta Event Hooks (#383, B9 step 2b): Okta tells us a person's Okta account
 * changed, and we raise that person's `authd.accounts.credential_epoch`, so a
 * mail password authd remembered stops working on the next IMAP or SMTP login
 * instead of when its cache entry runs out.
 *
 * Spec: https://developer.okta.com/docs/concepts/event-hooks/
 *
 * ⚠ WHERE THE SECRET LIVES. `config.oktaEventHook` on the Okta connection:
 * `{ secretHash, hint, issuedAt }`. Only a SHA-256 of the secret is stored; the
 * secret itself is shown once, when an owner generates it, and exists nowhere
 * else. A hash is the right storage for a 256-bit random token (nothing to
 * brute-force), and it keeps the public endpoint from having to open the
 * connection's sealed secrets just to authenticate a stranger. The console
 * view drops `secretHash` (`redactedConfig`).
 *
 * ⚠ THE ONLY SECRET IS THE `Authorization` HEADER VALUE THE ADMIN GIVES OKTA.
 * Okta signs nothing on an event hook. The URL names the connection, and the
 * header proves the caller is the Okta org the owner configured.
 *
 * ⚠ AN EPOCH RAISE ONLY EVER TAKES ACCESS AWAY. It makes authd ask the
 * identity provider again; it can never admit anybody. That is why a wrong
 * match, a replay and a forged-looking duplicate cost one extra provider call
 * and nothing more, and why every doubtful case below raises rather than
 * skips.
 */

/** Prefix of the hook secret: greppable in a leak scan, like `i10_scim_`. */
export const HOOK_SECRET_PREFIX = "i10_okh_"

/**
 * The event types that raise the epoch, and the only ones worth subscribing
 * the hook to. All are event-hook-eligible in Okta's catalog.
 *
 * ⚠ `user.session.end` IS DELIBERATELY NOT HERE: it fires on every ordinary
 * sign-out, and a sign-out does not change a password. `user.lifecycle.
 * delete.completed` is not event-hook-eligible, so `delete.initiated` is the
 * delete signal Okta can send.
 */
export const CREDENTIAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user.account.update_password",
  "user.account.reset_password",
  "user.lifecycle.suspend",
  "user.lifecycle.deactivate",
  "user.lifecycle.delete.initiated",
  "user.account.lock",
  "user.session.clear",
])

/**
 * An event published longer ago than this is not acted on.
 *
 * ⚠ SIX HOURS, TWICE THE LONGEST A VERIFIED PASSWORD IS EVER REMEMBERED
 * (authd refuses a `AUTHD_CRED_CACHE_TTL` over three hours). A cache entry
 * made after the event was checked against the identity provider after the
 * change, so an event older than the longest cache life cannot concern any
 * live entry. The margin is for Okta, which delivers at least once, out of
 * order and with no maximum delay it will promise (it asks to hear about
 * delays only past an hour). Too tight a bound drops a real revocation, so it
 * errs long; its only job is to stop a captured request being replayed for
 * ever.
 */
export const MAX_EVENT_AGE_MS = 6 * 60 * 60 * 1000

/** Users resolved and raised at once; a batch is bounded by the body limit. */
const CONCURRENCY = 8

/** Results Okta logs for an attempt that changed nothing. */
const NO_CHANGE_RESULTS: ReadonlySet<string> = new Set(["FAILURE", "SKIPPED"])

// ── The stored secret ────────────────────────────────────────────────────

export interface StoredOktaHook {
  /** SHA-256 hex of the secret. Never returned by any route. */
  secretHash?: string
  /** The first characters of the secret, to tell two apart. */
  hint?: string
  issuedAt?: string
}

/** What the connection holds, tolerating a config that never had one. */
export function storedOktaHook(connection: Pick<Connection, "config">): StoredOktaHook {
  const raw = connection.config.oktaEventHook
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  return {
    ...(typeof r.secretHash === "string" && /^[0-9a-f]{64}$/.test(r.secretHash)
      ? { secretHash: r.secretHash }
      : {}),
    ...(typeof r.hint === "string" ? { hint: r.hint } : {}),
    ...(typeof r.issuedAt === "string" ? { issuedAt: r.issuedAt } : {}),
  }
}

/** A new secret, the one time it exists in the clear, and what is kept. */
export function mintHookSecret(now: Date): {
  secret: string
  stored: Required<StoredOktaHook>
} {
  const secret = `${HOOK_SECRET_PREFIX}${newSecret()}`
  return {
    secret,
    stored: {
      secretHash: hashSecret(secret),
      hint: secret.slice(0, HOOK_SECRET_PREFIX.length + 4),
      issuedAt: now.toISOString(),
    },
  }
}

/**
 * A connection's config as the console may see it: everything but the hook's
 * hash.
 *
 * ⚠ A HASH OF A RANDOM TOKEN IS NOT A SECRET WORTH PROTECTING, but nothing
 * outside this module has a reason to read it, and a config that is "nothing
 * secret" is a rule other code relies on.
 */
export function redactedConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const hook = config.oktaEventHook
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) return config
  const visible = { ...(hook as Record<string, unknown>) }
  delete visible.secretHash
  return { ...config, oktaEventHook: visible }
}

/**
 * The header's value as the secret it carries: with or without a `Bearer `
 * prefix, since Okta sends whatever the admin typed as the "authentication
 * secret".
 */
export function presentedSecret(header: string | null | undefined): string | null {
  if (!header) return null
  const value = header.replace(/^Bearer\s+/i, "").trim()
  return /^[\x21-\x7E]{1,256}$/.test(value) ? value : null
}

// ── Authentication ───────────────────────────────────────────────────────

const DUMMY_HASH = hashSecret("okta-event-hook-dummy-secret")

/**
 * The connection this request is for, if and only if the secret is its own.
 *
 * ⚠ ONE ANSWER FOR EVERY WAY TO FAIL. An unknown id, another provider's
 * connection, an Okta connection with no hook secret and a wrong secret all
 * return null, and all run one hash comparison first, so neither the response
 * nor its timing says which. Any status is accepted (the admin verifies the
 * hook while the connection is still a draft).
 */
export async function authenticateHook(
  store: Pick<IdentityStore, "connectionForStart">,
  connectionId: string,
  presented: string | null,
): Promise<Connection | null> {
  const connection = await store.connectionForStart(connectionId)
  const stored = connection?.provider === "okta" ? storedOktaHook(connection) : {}
  const matches = sameHash(stored.secretHash ?? DUMMY_HASH, hashSecret(presented ?? ""))
  return connection && stored.secretHash && matches ? connection : null
}

// ── The delivery ─────────────────────────────────────────────────────────

const Target = z.object({
  id: z.string().min(1).max(256),
  type: z.string().max(64).nullish(),
  alternateId: z.string().max(320).nullish(),
})

const OktaEvent = z.object({
  uuid: z.string().max(64).nullish(),
  eventType: z.string().max(128),
  published: z.string().max(64).nullish(),
  outcome: z.object({ result: z.string().max(32).nullish() }).nullish(),
  actor: Target.nullish(),
  target: z.array(Target).nullish(),
})

const Delivery = z.object({ data: z.object({ events: z.array(z.unknown()) }) })

export type OktaEventHookOutcome =
  | { outcome: "malformed" }
  | { outcome: "unavailable" }
  | {
      outcome: "processed"
      received: number
      /** Of a credential type, recent, and not a failed attempt. */
      relevant: number
      stale: number
      unreadable: number
      /** People the connection has no link for: nothing is cached for them. */
      unknown: number
      /** People whose epoch was raised, once each however many events named them. */
      raised: number
    }

export interface OktaEventHookDeps {
  store: Pick<IdentityStore, "identityBySubject" | "identityByEmail">
  /** `raiseCredentialEpoch` against the API's database. */
  raiseEpoch(clerkUserId: string): Promise<void>
  log: Logger
  now?: () => Date
}

interface Person {
  oktaId: string
  login: string | null
  eventUuids: string[]
}

/**
 * Applies one authenticated delivery to one connection.
 *
 * ⚠ DONE BEFORE THE ANSWER, NOT QUEUED. Each person costs a few indexed reads
 * and one single-statement update, which fits Okta's three seconds; an
 * acknowledged raise that is then lost would be a cached password outliving
 * its revocation, and Okta retries a 5xx. A raise is idempotent, so the retry
 * (or Okta's own at-least-once redelivery) is harmless.
 *
 * ⚠ EVERY LOOKUP IS SCOPED BY THIS CONNECTION AND ITS WORKSPACE. An event
 * names an Okta user, and the only people it can reach are the ones who sign
 * in through the connection the secret belongs to.
 */
export async function applyOktaEvents(
  d: OktaEventHookDeps,
  connection: Pick<Connection, "id" | "tenantId">,
  body: unknown,
): Promise<OktaEventHookOutcome> {
  const parsed = Delivery.safeParse(body)
  if (!parsed.success) return { outcome: "malformed" }
  const now = (d.now ?? (() => new Date()))().getTime()

  const people = new Map<string, Person>()
  const counts = { relevant: 0, stale: 0, unreadable: 0 }
  const events = parsed.data.data.events
  for (const raw of events) {
    // ⚠ THE TYPE FIRST, ON THE RAW OBJECT: an event of another type is none of
    // our business however oddly it is shaped.
    const type = (raw as { eventType?: unknown } | null)?.eventType
    if (typeof type !== "string" || !CREDENTIAL_EVENT_TYPES.has(type)) continue
    const event = OktaEvent.safeParse(raw)
    if (!event.success) {
      counts.unreadable++
      continue
    }
    const e = event.data
    if (NO_CHANGE_RESULTS.has(e.outcome?.result ?? "")) continue
    // ⚠ AN UNREADABLE TIMESTAMP ACTS: the bound is for replays, and a missing
    // date is the doubtful case, which raises.
    const published = e.published ? Date.parse(e.published) : Number.NaN
    if (Number.isFinite(published) && now - published > MAX_EVENT_AGE_MS) {
      counts.stale++
      continue
    }
    counts.relevant++
    /*
     * The person is the event's User target. Self-service password events can
     * carry the person only as the actor, so a User actor stands in when no
     * target is a User; acting for an admin by mistake costs that admin one
     * provider call.
     */
    const named = (e.target ?? []).filter((t) => t.type === "User")
    const users = named.length > 0 ? named : e.actor?.type === "User" ? [e.actor] : []
    if (users.length === 0) counts.unreadable++
    for (const user of users) {
      const person = people.get(user.id) ?? {
        oktaId: user.id,
        login: user.alternateId ?? null,
        eventUuids: [],
      }
      person.eventUuids.push(e.uuid ?? "unknown")
      people.set(user.id, person)
    }
  }

  const raised = new Set<string>()
  let unknown = 0
  let failed = 0
  const todo = [...people.values()]
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const settled = await Promise.allSettled(
      todo.slice(i, i + CONCURRENCY).map(async (person) => {
        const clerkUserId = await resolve(d.store, connection, person)
        if (!clerkUserId) {
          unknown++
          return
        }
        // Two Okta users never map to one Clerk user on a connection, but a
        // changed login might: one raise is enough.
        if (raised.has(clerkUserId)) return
        raised.add(clerkUserId)
        await d.raiseEpoch(clerkUserId)
        d.log.info(
          { connectionId: connection.id, eventUuids: person.eventUuids },
          "an Okta event raised a mail credential epoch",
        )
      }),
    )
    for (const result of settled)
      if (result.status === "rejected") {
        failed++
        d.log.error(
          {
            connectionId: connection.id,
            err: result.reason instanceof Error ? result.reason.name : "unknown",
          },
          "could not apply an Okta event to a mail credential epoch",
        )
      }
  }
  // ⚠ ONE FAILURE FAILS THE DELIVERY so Okta sends it again; the people who
  // were raised are raised again, which changes nothing.
  if (failed > 0) return { outcome: "unavailable" }

  const done = {
    outcome: "processed" as const,
    received: events.length,
    ...counts,
    unknown,
    raised: raised.size,
  }
  d.log.info(
    { connectionId: connection.id, ...counts, received: events.length, unknown },
    "handled an Okta event hook delivery",
  )
  return done
}

/**
 * The Clerk user an Okta user signs in as on this connection, or null.
 *
 * By the Okta user id first: for an OIDC connection that is the link's
 * `subject` (the ID token's `sub`). A link made over SAML has whatever NameID
 * the admin chose, usually the login, which Okta also sends as the target's
 * `alternateId`; so when no link has the id, the login is tried as a subject
 * and then as the address the link last asserted.
 *
 * ⚠ THE FALLBACK RUNS WHENEVER THE ID FINDS NOTHING, NOT ONLY FOR A LINK THAT
 * "HAS NO OKTA ID", because a link does not say what kind of identifier its
 * subject is. It is safe because of what a match does: it raises an epoch,
 * which can only make authd ask Okta again. A login that now belongs to a
 * different Okta user, or an address two links share, costs one extra check
 * of someone who signs in through this very connection, never access. The
 * cost of NOT matching is a cached password that survives, so the lookup
 * leans towards matching.
 *
 * ⚠ ONE ADDRESS CAN BELONG TO TWO LINKS and the store returns one of them;
 * the Okta id is what finds both people reliably, which is why it comes first.
 */
async function resolve(
  store: OktaEventHookDeps["store"],
  connection: Pick<Connection, "id" | "tenantId">,
  person: Person,
): Promise<string | null> {
  const byId = await store.identityBySubject(
    connection.tenantId,
    connection.id,
    person.oktaId,
  )
  if (byId) return byId.clerkUserId
  if (!person.login) return null
  const byLogin = await store.identityBySubject(
    connection.tenantId,
    connection.id,
    person.login,
  )
  if (byLogin) return byLogin.clerkUserId
  const email = normaliseEmail(person.login)
  if (!email) return null
  const byEmail = await store.identityByEmail(connection.tenantId, connection.id, email)
  return byEmail?.clerkUserId ?? null
}
