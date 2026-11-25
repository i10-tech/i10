import { createHash } from "node:crypto"
import { z } from "zod"
import {
  hashSecret,
  newSecret,
  normaliseEmail,
  sameHash,
  type Connection,
} from "./model.js"
import { storedOidc } from "./oidc.js"
import { storedOidcMail } from "./oidc-mail.js"
import type { IdentityStore, Logger, ReplayCache } from "./ports.js"
import { ReplayUnavailable } from "./saml.js"

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
 * User events that end mail device codes in addition to raising the epoch (#383).
 *
 * Every one of these means the person's access was ended, forced out, or reset.
 * Guarded by: `User` targets only (never actor fallback), replay cache on `uuid`,
 * finite `published` within `MAX_EVENT_AGE_MS` behind and `MAX_EVENT_FUTURE_MS`
 * ahead, and `created_at < published + DEVICE_CREATED_BEFORE_SKEW_MS`.
 */
export const DEVICE_REVOKING_USER_EVENTS: ReadonlySet<string> = new Set([
  "user.lifecycle.suspend",
  "user.lifecycle.deactivate",
  "user.lifecycle.delete.initiated",
  "user.session.clear",
  "user.account.reset_password",
])

/**
 * User events that raise the credential epoch without deleting mail device codes.
 *
 * `user.account.update_password` is a routine password rotation (the person is
 * still employed and enrolled); `user.account.lock` is a temporary lockout that
 * protects the password lane. An Okta lock does not reach authd's row, so it
 * neither holds nor deletes device codes: deleting them would let anybody wipe a
 * person's phone with ten wrong guesses at their Okta password.
 */
export const EPOCH_ONLY_USER_EVENTS: ReadonlySet<string> = new Set([
  "user.account.update_password",
  "user.account.lock",
])

const APP_USER_MEMBERSHIP_REMOVE = "application.user_membership.remove"
const APP_LIFECYCLE_DEACTIVATE = "application.lifecycle.deactivate"

/**
 * The event types that raise the epoch, and the only ones worth subscribing
 * the hook to. All are event-hook-eligible in Okta's catalog.
 *
 * ⚠ `user.session.end` IS DELIBERATELY NOT HERE: it fires on every ordinary
 * sign-out, and a sign-out does not change a password. `user.lifecycle.
 * delete.completed` is not event-hook-eligible, so `delete.initiated` is the
 * delete signal Okta can send. `application.user_membership.remove` is a person
 * losing the app (the User target), which ends devices only when an `AppInstance`
 * target matches this connection's own Okta app.
 */
export const CREDENTIAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...EPOCH_ONLY_USER_EVENTS,
  ...DEVICE_REVOKING_USER_EVENTS,
  APP_USER_MEMBERSHIP_REMOVE,
])

/**
 * The event types that raise EVERY managed account of the connection, for a
 * change to the rules people are held to rather than to a person. All are
 * event-hook-eligible in Okta's catalog.
 *
 * ⚠ WE RAISE CONNECTION-WIDE BECAUSE A POLICY EVENT DOES NOT NAME THE APP: its
 * target is the policy or rule, so there is no telling whether it concerns the
 * mail app. The cost of guessing wrong is one extra provider check per person
 * at their next login, and a raise can never admit anyone.
 *
 * ⚠ SWITCHING AN APP TO ANOTHER POLICY IS NOT HERE AND CANNOT BE:
 * `policy.mapping.create` (and `.delete`, `policy.lifecycle.delete`,
 * `application.policy.sign_on.*`) are not event-hook-eligible, so Okta rejects
 * a subscription to them. That one change still waits out the cache (fifteen
 * minutes on the OIDC lane).
 */
export const CONNECTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "policy.rule.add",
  "policy.rule.update",
  "policy.rule.delete",
  "policy.rule.activate",
  "policy.rule.deactivate",
  "policy.lifecycle.update",
  "policy.lifecycle.activate",
  "policy.lifecycle.deactivate",
  "application.lifecycle.deactivate",
])

/** Everything the hook is worth subscribing to: the one list the console shows. */
export const HOOK_EVENT_TYPES: readonly string[] = [
  ...CREDENTIAL_EVENT_TYPES,
  ...CONNECTION_EVENT_TYPES,
]

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

/**
 * A device-revoking event with `published` further ahead of our clock than this
 * does not delete devices (still raises the epoch): a future timestamp would
 * otherwise push `createdBefore` into the future and wipe devices enrolled later.
 */
export const MAX_EVENT_FUTURE_MS = 2 * 60 * 1000

/**
 * Clock-skew margin added to `published` when computing `createdBefore` for
 * `endFor`: covers clock drift between Okta and Postgres while keeping devices
 * enrolled after a real re-enrollment intact when Okta delivers late.
 */
export const DEVICE_CREATED_BEFORE_SKEW_MS = 60 * 1000

/**
 * The Okta `AppInstance` ids (`0oa...`) this connection represents.
 *
 * Includes:
 *   - `config.oidc.clientId` when `protocol === "oidc"` (the sign-in OIDC app's
 *     client id IS its Okta AppInstance id), and
 *   - the Okta mail app's client id from `config.oidcMail` (preset `"okta"`) or
 *     legacy `config.oktaMail`, for any protocol (SAML connections can have an
 *     Okta OIDC mail app too).
 *
 * Non-Okta `oidcMail` presets are excluded because their client ids are not
 * Okta AppInstance ids. For a SAML connection with no Okta mail app, the set is
 * empty because `config.saml` carries only the SAML key id (`exk...`).
 */
export function ownOktaAppIds(
  connection: Partial<Pick<Connection, "protocol" | "provider" | "config">>,
): ReadonlySet<string> {
  const ids = new Set<string>()
  if (!connection.config) return ids
  if (connection.protocol === "oidc") {
    const signInId = storedOidc({ config: connection.config }).clientId?.trim()
    if (signInId) ids.add(signInId)
  }
  const mail = storedOidcMail({
    config: connection.config,
    provider: connection.provider ?? "okta",
  })
  if (mail.preset === "okta" && typeof mail.clientId === "string") {
    const mailId = mail.clientId.trim()
    if (mailId) ids.add(mailId)
  }
  return ids
}

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
      /** Of a credential or connection type, recent, and not a failed attempt. */
      relevant: number
      stale: number
      unreadable: number
      /** People the connection has no link for: nothing is cached for them. */
      unknown: number
      /** People whose epoch was raised, once each however many events named them. */
      raised: number
      /** Whether every managed account of the connection was raised, once. */
      connectionRaised: boolean
    }

/**
 * Device-revocation wiring for Okta event hooks: either BOTH callbacks and the
 * replay cache are supplied together, or none of them are. Supplying callbacks
 * without a replay cache would silently degrade device revocation to epoch-only.
 */
export type OktaEventHookDeviceRevocation =
  | {
      /**
       * Raises the account's epoch AND deletes its mail devices created before
       * `createdBefore` in ONE transaction (`raiseEpochAndEndDevices`).
       */
      revokeUserDevices: (input: {
        tenantId: string
        clerkUserId: string
        createdBefore: Date
      }) => Promise<void>
      /**
       * Raises every managed account's epoch on the connection AND deletes their
       * mail devices created before `createdBefore` in ONE transaction
       * (`raiseConnectionEpochAndEndDevices`).
       */
      revokeConnectionDevices: (input: {
        tenantId: string
        connectionId: string
        createdBefore: Date
      }) => Promise<void>
      /** Replay cache on event `uuid` (TTL = `MAX_EVENT_AGE_MS`) for device revocations. */
      replay: ReplayCache
    }
  | {
      revokeUserDevices?: undefined
      revokeConnectionDevices?: undefined
      replay?: undefined
    }

export type OktaEventHookDeps = {
  store: Pick<IdentityStore, "identityBySubject" | "identityByEmail">
  /** `raiseCredentialEpoch` against the API's database. */
  raiseEpoch(clerkUserId: string): Promise<void>
  /** `raiseConnectionCredentialEpochs` against the API's database. */
  raiseConnection(connectionId: string): Promise<void>
  log: Logger
  now?: () => Date
} & OktaEventHookDeviceRevocation

interface DeviceRevocationEvent {
  uuid: string
  createdBefore: Date
}

interface Person {
  oktaId: string
  login: string | null
  eventUuids: string[]
  deviceEvents: DeviceRevocationEvent[]
}

const deviceClaimKey = (connectionId: string, uuid: string) =>
  `sso:okta-hook:device:${connectionId}:${createHash("sha256").update(uuid).digest("hex")}`

function validDeviceEvent(
  uuid: string | null | undefined,
  published: number,
  now: number,
): DeviceRevocationEvent | null {
  const trimmed = typeof uuid === "string" ? uuid.trim() : ""
  if (!trimmed) return null
  if (!Number.isFinite(published)) return null
  if (now - published > MAX_EVENT_AGE_MS) return null
  if (published - now > MAX_EVENT_FUTURE_MS) return null
  return {
    uuid: trimmed,
    createdBefore: new Date(published + DEVICE_CREATED_BEFORE_SKEW_MS),
  }
}

/**
 * Applies one authenticated delivery to one connection.
 *
 * ⚠ DONE BEFORE THE ANSWER, NOT QUEUED. Each person costs a few indexed reads
 * and one single-statement update, which fits Okta's three seconds; an
 * acknowledged raise that is then lost would be a cached password outliving
 * its revocation, and Okta retries a 5xx. A raise is idempotent, so the retry
 * (or Okta's own at-least-once redelivery) is harmless; device revocations are
 * additionally guarded by `uuid` replay claims and `createdBefore` so a replay
 * or late delivery cannot wipe a newly enrolled device.
 *
 * ⚠ EVERY LOOKUP IS SCOPED BY THIS CONNECTION AND ITS WORKSPACE. An event
 * names an Okta user, and the only people it can reach are the ones who sign
 * in through the connection the secret belongs to.
 */
export async function applyOktaEvents(
  d: OktaEventHookDeps,
  connection: Pick<Connection, "id" | "tenantId"> &
    Partial<Pick<Connection, "protocol" | "provider" | "config">>,
  body: unknown,
): Promise<OktaEventHookOutcome> {
  if ((d.revokeUserDevices || d.revokeConnectionDevices) && !d.replay) {
    throw new Error(
      "applyOktaEvents requires replay when device revocation callbacks are supplied",
    )
  }
  const parsed = Delivery.safeParse(body)
  if (!parsed.success) return { outcome: "malformed" }
  const now = (d.now ?? (() => new Date()))().getTime()
  const ownAppIds = ownOktaAppIds(connection)
  const matchesOwnApp = (targets: { id: string; type?: string | null }[]) =>
    ownAppIds.size > 0 &&
    targets.some((t) => t.type === "AppInstance" && ownAppIds.has(t.id))

  const people = new Map<string, Person>()
  const connectionDeviceEvents: DeviceRevocationEvent[] = []
  const counts = { relevant: 0, stale: 0, unreadable: 0 }
  let wholeConnection = false
  const events = parsed.data.data.events
  for (const raw of events) {
    // ⚠ THE TYPE FIRST, ON THE RAW OBJECT: an event of another type is none of
    // our business however oddly it is shaped.
    const type = (raw as { eventType?: unknown } | null)?.eventType
    if (typeof type !== "string") continue
    const ofConnection = CONNECTION_EVENT_TYPES.has(type)
    if (!ofConnection && !CREDENTIAL_EVENT_TYPES.has(type)) continue
    const event = OktaEvent.safeParse(raw)
    if (!event.success) {
      counts.unreadable++
      continue
    }
    const e = event.data
    if (NO_CHANGE_RESULTS.has(e.outcome?.result ?? "")) continue
    // ⚠ AN UNREADABLE TIMESTAMP STILL RAISES THE EPOCH: the bound is for replays,
    // and a missing date is the doubtful case, which raises. Device revocations
    // require a finite timestamp inside `[now - MAX_EVENT_AGE_MS, now + MAX_EVENT_FUTURE_MS]`.
    const published = e.published ? Date.parse(e.published) : Number.NaN
    if (Number.isFinite(published) && now - published > MAX_EVENT_AGE_MS) {
      counts.stale++
      continue
    }
    counts.relevant++
    const targets = e.target ?? []
    if (ofConnection) {
      wholeConnection = true
      if (type === APP_LIFECYCLE_DEACTIVATE && matchesOwnApp(targets)) {
        const devEv = validDeviceEvent(e.uuid, published, now)
        if (devEv) connectionDeviceEvents.push(devEv)
      }
      continue
    }

    const isDeviceRevokingType =
      DEVICE_REVOKING_USER_EVENTS.has(type) ||
      (type === APP_USER_MEMBERSHIP_REMOVE && matchesOwnApp(targets))
    const devEv = isDeviceRevokingType ? validDeviceEvent(e.uuid, published, now) : null

    /*
     * The person is the event's User target.
     *
     * ⚠ NO ACTOR FALLBACK FOR DEVICE-REVOKING EVENTS: a malformed admin event
     * without a User target has the admin as `actor`, and falling back to
     * `actor` would wipe the admin's phone. Epoch-only self-service events
     * (`user.account.update_password`, `user.account.lock`) keep the fallback
     * because an extra epoch raise costs at most one provider call.
     */
    const named = targets.filter((t) => t.type === "User")
    const users =
      named.length > 0
        ? named
        : EPOCH_ONLY_USER_EVENTS.has(type) && e.actor?.type === "User"
          ? [e.actor]
          : []
    if (users.length === 0) counts.unreadable++
    for (const user of users) {
      const person = people.get(user.id) ?? {
        oktaId: user.id,
        login: user.alternateId ?? null,
        eventUuids: [],
        deviceEvents: [],
      }
      person.eventUuids.push(e.uuid ?? "unknown")
      if (devEv) person.deviceEvents.push(devEv)
      people.set(user.id, person)
    }
  }

  // Claim every eligible device-revoking event's `uuid` once before running any
  // device deletion so replays within MAX_EVENT_AGE_MS never re-delete devices.
  const newlyClaimed = new Map<string, string>()
  const uuidsToClaim = new Set<string>()
  if (d.replay) {
    for (const person of people.values()) {
      for (const ev of person.deviceEvents) uuidsToClaim.add(ev.uuid)
    }
    for (const ev of connectionDeviceEvents) uuidsToClaim.add(ev.uuid)
  }
  for (const uuid of uuidsToClaim) {
    const claimKey = deviceClaimKey(connection.id, uuid)
    try {
      if (await d.replay!.claim(claimKey, MAX_EVENT_AGE_MS)) {
        newlyClaimed.set(uuid, claimKey)
      }
    } catch (error) {
      if (error instanceof ReplayUnavailable) {
        for (const held of newlyClaimed.values()) {
          await d.replay!.release(held).catch(() => {})
        }
        return { outcome: "unavailable" }
      }
      throw error
    }
  }

  const failedClaims = new Set<string>()
  const markFailedClaims = (deviceEvents: DeviceRevocationEvent[]) => {
    for (const ev of deviceEvents) {
      const claimKey = newlyClaimed.get(ev.uuid)
      if (claimKey) failedClaims.add(claimKey)
    }
  }

  let unknown = 0
  let failed = 0
  // Resolve every Okta user first, then merge by Clerk user id so a person
  // matched via two Okta entries in one delivery gets one write with the latest
  // valid `createdBefore`.
  const resolved = new Map<
    string,
    { eventUuids: string[]; deviceEvents: DeviceRevocationEvent[] }
  >()
  const todo = [...people.values()]
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(async (person) => {
        const clerkUserId = await resolve(d.store, connection, person)
        return { person, clerkUserId }
      }),
    )
    for (let j = 0; j < settled.length; j++) {
      const result = settled[j]!
      const person = batch[j]!
      if (result.status === "rejected") {
        failed++
        markFailedClaims(person.deviceEvents)
        d.log.error(
          {
            connectionId: connection.id,
            err: result.reason instanceof Error ? result.reason.name : "unknown",
          },
          "could not apply an Okta event to a mail credential epoch",
        )
        continue
      }
      const { clerkUserId } = result.value
      if (!clerkUserId) {
        unknown++
        continue
      }
      const existing = resolved.get(clerkUserId) ?? {
        eventUuids: [],
        deviceEvents: [],
      }
      existing.eventUuids.push(...person.eventUuids)
      existing.deviceEvents.push(...person.deviceEvents)
      resolved.set(clerkUserId, existing)
    }
  }

  const raised = new Set<string>()
  const resolvedEntries = [...resolved.entries()]
  for (let i = 0; i < resolvedEntries.length; i += CONCURRENCY) {
    const batch = resolvedEntries.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(async ([clerkUserId, entry]) => {
        const activeDeviceEvents = entry.deviceEvents.filter((ev) =>
          newlyClaimed.has(ev.uuid),
        )
        if (activeDeviceEvents.length > 0 && d.revokeUserDevices) {
          const createdBefore = new Date(
            Math.max(...activeDeviceEvents.map((ev) => ev.createdBefore.getTime())),
          )
          await d.revokeUserDevices({
            tenantId: connection.tenantId,
            clerkUserId,
            createdBefore,
          })
        } else {
          await d.raiseEpoch(clerkUserId)
        }
        raised.add(clerkUserId)
        d.log.info(
          { connectionId: connection.id, eventUuids: entry.eventUuids },
          "an Okta event raised a mail credential epoch",
        )
      }),
    )
    for (let j = 0; j < settled.length; j++) {
      const result = settled[j]!
      if (result.status === "rejected") {
        failed++
        markFailedClaims(batch[j]![1].deviceEvents)
        d.log.error(
          {
            connectionId: connection.id,
            err: result.reason instanceof Error ? result.reason.name : "unknown",
          },
          "could not apply an Okta event to a mail credential epoch",
        )
      }
    }
  }

  // ONCE however many policy or app events the delivery holds: one statement
  // (or one transaction when revoking devices) covers every managed account.
  if (wholeConnection) {
    const activeConnEvents = connectionDeviceEvents.filter((ev) =>
      newlyClaimed.has(ev.uuid),
    )
    try {
      if (activeConnEvents.length > 0 && d.revokeConnectionDevices) {
        const createdBefore = new Date(
          Math.max(...activeConnEvents.map((ev) => ev.createdBefore.getTime())),
        )
        await d.revokeConnectionDevices({
          tenantId: connection.tenantId,
          connectionId: connection.id,
          createdBefore,
        })
      } else {
        await d.raiseConnection(connection.id)
      }
    } catch (err) {
      failed++
      markFailedClaims(activeConnEvents)
      d.log.error(
        {
          connectionId: connection.id,
          err: err instanceof Error ? err.name : "unknown",
        },
        "could not apply an Okta policy event to the connection's mail credential epochs",
      )
    }
  }

  if (d.replay && failedClaims.size > 0) {
    for (const key of failedClaims) {
      await d.replay
        .release(key)
        .catch(() =>
          d.log.warn(
            { connectionId: connection.id },
            "could not release an Okta event hook replay claim",
          ),
        )
    }
  }

  // ⚠ ONE FAILURE FAILS THE DELIVERY so Okta sends it again; the people who
  // were raised are raised again, which changes nothing, and any failed
  // device-revocation claim was released so the retry finishes it.
  if (failed > 0) return { outcome: "unavailable" }

  const done = {
    outcome: "processed" as const,
    received: events.length,
    ...counts,
    unknown,
    raised: raised.size,
    connectionRaised: wholeConnection,
  }
  d.log.info(
    {
      connectionId: connection.id,
      ...counts,
      received: events.length,
      unknown,
      connectionRaised: wholeConnection,
    },
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
