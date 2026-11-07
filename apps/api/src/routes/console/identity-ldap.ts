import type { Context, Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import { OWNER_GUARDED, type Connection } from "../../identity/model.js"
import {
  FILTER_PLACEHOLDER,
  LDAP_PORTS,
  LDAP_SETTING_FIELDS,
  TEST_VALID_MS,
  TLS_MODES,
  completeSettings,
  ldapServiceInput,
  ldapSettingsInput,
  ldapTestInput,
  sealedLdap,
  storedLdap,
  testIsFresh,
  type LdapSettingsInput,
  type StoredLdap,
} from "../../identity/ldap.js"
import { PROBE_RESULTS, type LdapProbe } from "../../identity/ldap-probe.js"
import type { fixedWindow, Limit } from "../../identity/rate-limit.js"

/**
 * A connection's LDAP pass-through (#344, sso.md 2.8 decision 6): where authd
 * asks the company's own directory about the password of an account the
 * connection manages, instead of asking Clerk.
 *
 *   GET  /identity/connections/:id/ldap          what is set (never the service secret)
 *   PUT  /identity/connections/:id/ldap          host, port, TLS, CA, base, filter, enabled (step-up)
 *   PUT  /identity/connections/:id/ldap/service  the service account's DN and secret (step-up)
 *   POST /identity/connections/:id/ldap/test     bind, search, optionally bind as a test user (step-up)
 *
 * ⚠ THE TRUST RULE (sso.md 2.14). These decide whose directory a company's
 * people's passwords are asked of. Once a connection is `active` (or
 * `disabled`), changing or enabling any of them needs `owners:manage` as well
 * as step-up, and every change is audited with the actor and without the
 * secret. On `draft` and `testing`, `sso:manage` is enough. The one move an
 * admin keeps on a live connection is turning pass-through OFF: it removes a
 * way in (IMAP) rather than adding one.
 *
 * ⚠ ANY CHANGE TURNS PASS-THROUGH OFF AND CLEARS THE TEST. "Enabled" is only
 * ever true for the settings a test passed on: the test records the revision
 * it ran against, and enabling needs a pass for the CURRENT revision made in
 * the last 24 hours. Changing a setting while enabled would otherwise run
 * untested settings against the company's directory.
 *
 * ⚠ THE SERVICE SECRET IS WRITE-ONLY, sealed with the connection's other
 * secrets, and the test password is used for one request and kept nowhere.
 */

export interface LdapConsoleDeps {
  probe: LdapProbe
  /** The shared fixed-window counter (identity/rate-limit.ts). */
  take: ReturnType<typeof fixedWindow>
  now?: () => Date
}

/** Tests open connections from our API to a company's directory: capped. */
const TEST_LIMIT: Limit = { max: 10, windowSeconds: 60 }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

/** The state refuses the move; the caller can fix it and retry. */
const conflict = (reason: string, message: string) =>
  ({ statusCode: 409, name: "ldap_refused" as const, reason, message }) as const

class LdapRefused extends Error {
  constructor(readonly reason: "incomplete" | "not_tested") {
    super(reason)
    this.name = "LdapRefused"
  }
}

const REFUSALS: Record<LdapRefused["reason"], string> = {
  incomplete:
    "Set the host, port, TLS mode, search base, user filter and the service account first.",
  not_tested:
    "Run the setup test on these settings first. A pass is good for 24 hours, for the settings it ran on.",
}

function setupView(connection: Connection, now: Date): Record<string, unknown> {
  const s = storedLdap(connection)
  const fresh = testIsFresh(s, now)
  return {
    host: s.host ?? null,
    port: s.port ?? null,
    tlsMode: s.tlsMode ?? null,
    // A public certificate, so it is shown back.
    caPem: s.caPem ?? null,
    searchBase: s.searchBase ?? null,
    userFilter: s.userFilter ?? null,
    enabled: s.enabled === true,
    serviceSet: s.serviceSet === true,
    tested: fresh,
    testedAt: fresh ? (s.testedAt ?? null) : null,
    testValidSeconds: TEST_VALID_MS / 1000,
    ports: LDAP_PORTS,
    tlsModes: TLS_MODES,
    filterPlaceholder: FILTER_PLACEHOLDER,
    results: PROBE_RESULTS,
  }
}

/** The settings in the body that differ from what is stored. */
function changedSettings(input: LdapSettingsInput, current: StoredLdap): string[] {
  return LDAP_SETTING_FIELDS.filter(
    (k) =>
      input[k] !== undefined &&
      JSON.stringify(input[k] ?? null) !== JSON.stringify(current[k] ?? null),
  )
}

export function mountIdentityLdap(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }
  const clock = () => (d.identity?.ldap?.now ?? (() => new Date()))()

  /** The connection the route names, or the response that says why not. */
  const load = async (c: Context) => {
    const id = d.identity
    if (!id?.ldap) return { error: c.json(notWired("LDAP pass-through"), 501) }
    if (!(await allowed(c, "sso:manage")))
      return { error: c.json(forbidden("Only an admin can change SSO settings."), 403) }
    const connectionId = c.req.param("id") ?? ""
    if (!UUID.test(connectionId)) return { error: c.json(notFound(), 404) }
    const { tenantId } = c.get("auth")
    const connection = await id.store.connection(tenantId, connectionId)
    if (!connection) return { error: c.json(notFound(), 404) }
    return { id, ldap: id.ldap, connection, tenantId }
  }

  /** ⚠ THE TRUST RULE, in one place for every write. */
  const trustRefusal = async (c: Context, connection: Connection) => {
    if (!OWNER_GUARDED.includes(connection.status)) return null
    if (await allowed(c, "owners:manage")) return null
    return c.json(
      forbidden(
        "Only an owner can change which directory an active connection asks about passwords. Ask an owner, or disable the connection first and have an owner make the change.",
      ),
      403,
    )
  }

  app.get("/identity/connections/:id/ldap", async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    return c.json(setupView(loaded.connection, clock()))
  })

  app.put("/identity/connections/:id/ldap", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, connection, tenantId } = loaded
    const body = await readJson(c)
    const parsed = ldapSettingsInput.safeParse(body ?? null)
    if (!parsed.success)
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid settings."),
        422,
      )
    const input = parsed.data
    if (Object.keys(input).length === 0)
      return c.json(validation("Send at least one setting to change."), 422)

    const before = storedLdap(connection)
    const changed = changedSettings(input, before)
    /*
     * ⚠ WHAT NEEDS AN OWNER ON A LIVE CONNECTION: any change to a setting, and
     * turning pass-through ON. Turning it OFF alone is an admin's.
     */
    const loosens = changed.length > 0 || input.enabled === true
    if (loosens) {
      const refusal = await trustRefusal(c, connection)
      if (refusal) return refusal
    }

    const now = clock()
    const { userId } = c.get("user")
    // Filled in the lock's callback; an object, so the reads below see it.
    const applied = {
      changed: [] as string[],
      before: false,
      after: false,
      to: {} as Record<string, unknown>,
    }
    let after: Connection | null
    try {
      after = await id.store.setConnectionSecrets(tenantId, connection.id, (cur) => {
        const stored = storedLdap({ config: cur.config })
        const sealed = sealedLdap(cur.secrets)
        const moved = changedSettings(input, stored)
        const next: StoredLdap = { ...stored }
        for (const k of LDAP_SETTING_FIELDS)
          if (input[k] !== undefined) Object.assign(next, { [k]: input[k] })
        if (moved.length > 0) {
          next.revision = (stored.revision ?? 0) + 1
          next.testedAt = null
          next.enabled = false
        }
        if (input.enabled !== undefined) {
          if (input.enabled) {
            if (!completeSettings(next, sealed)) throw new LdapRefused("incomplete")
            if (!testIsFresh(next, now)) throw new LdapRefused("not_tested")
          }
          next.enabled = input.enabled
        }
        applied.changed = moved
        applied.before = stored.enabled === true
        applied.after = next.enabled === true
        // ⚠ NEVER THE SERVICE ACCOUNT; the CA is a public certificate and is
        // named by `changed`, not repeated.
        applied.to = Object.fromEntries(
          moved
            .filter((k) => k !== "caPem")
            .map((k) => [k, (next as Record<string, unknown>)[k] ?? null]),
        )
        return { secrets: cur.secrets, config: { ...cur.config, ldap: next } }
      })
    } catch (error) {
      if (!(error instanceof LdapRefused)) throw error
      await id.store.record(tenantId, {
        type: "connection.ldap_refused",
        actorUserId: userId,
        connectionId: connection.id,
        reason: error.reason,
        data: { status: connection.status },
      })
      return c.json(conflict(error.reason, REFUSALS[error.reason]), 409)
    }
    if (!after) return c.json(notFound(), 404)
    if (applied.changed.length > 0 || applied.before !== applied.after)
      await id.store.record(tenantId, {
        type: "connection.ldap_updated",
        actorUserId: userId,
        connectionId: connection.id,
        data: {
          changed: applied.changed,
          trust: loosens,
          status: connection.status,
          enabled: { from: applied.before, to: applied.after },
          to: applied.to,
        },
      })
    return c.json(setupView(after, now))
  })

  app.put("/identity/connections/:id/ldap/service", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, connection, tenantId } = loaded
    const refusal = await trustRefusal(c, connection)
    if (refusal) return refusal
    const parsed = ldapServiceInput.safeParse((await readJson(c)) ?? null)
    if (!parsed.success)
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid service account."),
        422,
      )
    const { bindDn, bindSecret } = parsed.data
    const was = { set: false, enabled: false }
    const after = await id.store.setConnectionSecrets(
      tenantId,
      connection.id,
      (cur) => {
        const stored = storedLdap({ config: cur.config })
        was.set = stored.serviceSet === true
        was.enabled = stored.enabled === true
        return {
          secrets: { ...cur.secrets, ldap: { bindDn, bindSecret } },
          config: {
            ...cur.config,
            ldap: {
              ...stored,
              serviceSet: true,
              revision: (stored.revision ?? 0) + 1,
              testedAt: null,
              enabled: false,
            },
          },
        }
      },
    )
    if (!after) return c.json(notFound(), 404)
    const { userId } = c.get("user")
    await id.store.record(tenantId, {
      type: "connection.secret_set",
      actorUserId: userId,
      connectionId: connection.id,
      // ⚠ THAT IT CHANGED, NEVER WHAT TO - not the DN either.
      data: {
        kind: "ldap_service",
        rotated: was.set,
        status: connection.status,
        passthroughTurnedOff: was.enabled,
      },
    })
    return c.json(setupView(after, clock()))
  })

  app.post("/identity/connections/:id/ldap/test", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, ldap, connection, tenantId } = loaded
    const parsed = ldapTestInput.safeParse((await readJson(c)) ?? null)
    if (!parsed.success)
      return c.json(validation(parsed.error.issues[0]?.message ?? "Invalid test."), 422)

    const verdict = await ldap.take(`ldaptest:${connection.id}`, TEST_LIMIT)
    if (!verdict.ok) {
      c.header("Retry-After", String(verdict.retryAfter))
      return c.json(
        {
          statusCode: 429,
          name: "rate_limit_exceeded",
          message: "Too many tests. Wait a minute and try again.",
        },
        429,
      )
    }

    const stored = storedLdap(connection)
    let settings
    try {
      const secrets = await id.store.connectionSecrets(tenantId, connection.id)
      settings = completeSettings(stored, secrets ? sealedLdap(secrets) : {})
    } catch (error) {
      id.log.error(
        {
          connectionId: connection.id,
          err: error instanceof Error ? error.name : "unknown",
        },
        "could not open a connection's LDAP service account",
      )
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Could not run the test right now. Try again in a moment.",
        },
        503,
      )
    }
    if (!settings) return c.json(conflict("incomplete", REFUSALS.incomplete), 409)

    const outcome = await ldap.probe.run({
      ...settings,
      address: parsed.data.address,
      ...(parsed.data.password !== undefined ? { password: parsed.data.password } : {}),
    })

    /*
     * ⚠ A PASS IS RECORDED AGAINST THE REVISION IT RAN ON, under the row lock.
     * If the settings changed while the test was running the pass is for
     * settings that no longer exist, and is dropped.
     */
    const pass = { recorded: false }
    if (outcome.result === "ok") {
      const at = clock()
      await id.store.setConnectionSecrets(tenantId, connection.id, (cur) => {
        const now = storedLdap({ config: cur.config })
        if ((now.revision ?? 0) !== (stored.revision ?? 0))
          return { secrets: cur.secrets, config: cur.config }
        pass.recorded = true
        return {
          secrets: cur.secrets,
          config: { ...cur.config, ldap: { ...now, testedAt: at.toISOString() } },
        }
      })
    }
    const { userId } = c.get("user")
    await id.store.record(tenantId, {
      type: "connection.ldap_tested",
      actorUserId: userId,
      connectionId: connection.id,
      reason: outcome.result,
      // ⚠ NO ADDRESS, NO PASSWORD: whether a user bind was tried, and why a
      // search found nobody.
      data: {
        userBind: parsed.data.password !== undefined,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        recorded: pass.recorded,
        status: connection.status,
      },
    })
    return c.json({ result: outcome.result, recorded: pass.recorded })
  })
}
