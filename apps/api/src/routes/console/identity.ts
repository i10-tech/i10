import type { Context, Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, mayRemove, type Permission } from "../../console/roles.js"
import { deprovision, type DeprovisionDeps } from "../../identity/managed.js"
import {
  OWNER_GUARDED,
  SETUP_STATUSES,
  ENFORCEMENTS,
  PROTOCOLS,
  RELINK_MODES,
  STATUSES,
  type Connection,
  type Enforcement,
  type Protocol,
  type ConnectionStatus,
  type RelinkMode,
} from "../../identity/model.js"
import type {
  ConnectionPatch,
  ClerkIdentity,
  IdentityStore,
  Logger,
  SsoPolicyStore,
} from "../../identity/ports.js"
import type { SsoGateChecker } from "../../identity/gate.js"
import type { EnforcementGate } from "../../identity/enforcement.js"
import { mountIdentityBreakGlass } from "./identity-break-glass.js"
import { mountIdentityFeatureGates, refuseFeature } from "./identity-features.js"
import { mountIdentityApiKeys } from "./identity-api-keys.js"
import { mountIdentitySiem, type SiemConsoleDeps } from "./identity-siem.js"
import type { FeatureGate } from "../../identity/features.js"
import type { ConnectionHealthStore } from "../../identity/health.js"
import { healthOf } from "../../identity/health.js"
import { mountIdentitySetupLinks } from "./identity-setup-links.js"
import {
  capabilitiesOf,
  mfaUnprovableMessage,
} from "../../identity/idp-capabilities.js"
import { oidcReady } from "../../identity/oidc.js"
import { OIDC_PRESETS, presetOf } from "../../identity/oidc-presets.js"
import { mountIdentityOidc, type OidcConsoleDeps } from "./identity-oidc.js"
import { mountIdentityGroups } from "./identity-groups.js"
import { mountIdentityRelinks } from "./identity-relinks.js"
import { mountIdentitySaml, type SamlConsoleDeps } from "./identity-saml.js"
import { samlReady } from "../../identity/saml.js"
import { SAML_PRESETS, samlPresetOf } from "../../identity/saml-presets.js"
import { mountIdentityMail, type MailConsoleDeps } from "./identity-mail.js"
import { mountIdentityScim, type ScimConsoleDeps } from "./identity-scim.js"
import { mountIdentityLdap, type LdapConsoleDeps } from "./identity-ldap.js"
import {
  mountIdentityWorkspacePolicy,
  type WorkspacePolicyConsoleDeps,
} from "./identity-workspace-policy.js"

/**
 * The identity core's console API (#337). The screens are #340's; these are
 * the routes they will call, and what the end-to-end run uses today.
 *
 *   GET    /identity/connections                         list, with domains, and the IdP presets
 *   POST   /identity/connections                         create a draft
 *   PATCH  /identity/connections/:id                     status, policy, mapping
 *   GET    /identity/connections/:id/test-runs            its test runs, newest first (#340)
 *   POST   /identity/connections/:id/domains             cover an access domain
 *   DELETE /identity/connections/:id/domains/:domainId   stop covering it
 *   GET    /identity/settings, PUT /identity/settings     deprovisioning mode
 *   GET    /identity/events                              the audit log
 *   GET    /identity/members/:userId/sessions            a member's bound sessions
 *   POST   /identity/members/:userId/sessions/:sid/revoke
 *   POST   /identity/members/:userId/deprovision         (step-up)
 *   ...    /identity/connections/:id/oidc[/secret|/keys] OIDC settings (#338, identity-oidc.ts)
 *   ...    /identity/connections/:id/group-rules[/:ruleId] group-to-role rules (#341, identity-groups.ts)
 *   ...    /identity/connections/:id/relinks[/:requestId/...] changed-subject requests (sso.md 2.22, identity-relinks.ts)
 *   ...    /identity/connections/:id/saml[/...]         SAML settings (#339, identity-saml.ts)
 *   ...    /identity/directories[/:id[/tokens|/conflicts]] SCIM directories (#342, identity-scim.ts)
 *   ...    /identity/connections/:id/ldap[/service|/test] LDAP pass-through for IMAP (#344, identity-ldap.ts)
 *   ...    /identity/connections/:id/bypass[/:userId]     the bypass list (#340, identity-break-glass.ts)
 *   ...    /identity/owner-exemption[/...]               the owner exemption (#340, identity-break-glass.ts)
 *   ...    /identity/connections/:id/setup-links[/...]   setup links (#340, identity-setup-links.ts)
 *   ...    /identity/session-policy, /second-factor-policy, /ip-allowlist (#345, identity-workspace-policy.ts)
 *
 * ⚠ EVERY ROUTE CHECKS OUR ROLES TABLE (#335): `sso:manage` for setup,
 * `owners:manage` for what deprovisioning does, and the removal rule
 * (`mayRemove`) for another person's sessions. Every change that decides who
 * gets in needs step-up, and every setup change is an audit event with the
 * actor.
 */

export interface IdentityConsoleDeps {
  store: IdentityStore
  clerk: ClerkIdentity
  gate: SsoGateChecker
  /** The protocols an engine exists for in this process; `test` only in development. */
  protocols: readonly Protocol[]
  /** The OIDC engine's console half (#338). Absent: OIDC routes answer 501. */
  oidc?: OidcConsoleDeps
  /** The SAML engine's console half (#339). Absent: SAML routes answer 501. */
  saml?: SamlConsoleDeps
  /** SCIM directories (#342). Absent: their routes answer 501. */
  scim?: ScimConsoleDeps
  /** Mail from the directory (#344): groups as lists, a leaver's mailbox. Absent: 501. */
  mail?: MailConsoleDeps
  /** LDAP pass-through for managed accounts' IMAP (#344). Absent: its routes answer 501. */
  ldap?: LdapConsoleDeps
  /**
   * Enforcement, break-glass and setup links (#340). Absent: their routes
   * answer 501, and no connection can be made "required".
   */
  policy?: SsoPolicyStore
  /** The enforcement gate's cache, dropped when a workspace's facts change. */
  enforcement?: Pick<EnforcementGate, "forgetTenant">
  /**
   * The workspace's session policy, second-factor rule and IP allowlist
   * (#345). Absent: their routes answer 501.
   */
  workspacePolicy?: WorkspacePolicyConsoleDeps
  /**
   * The plan flags (#345). Absent: no plan limits, as with every flag on.
   */
  features?: FeatureGate
  /** Connection health, counted from the audit log (#345). Absent: no `health`. */
  health?: ConnectionHealthStore
  /** The SIEM export to the customer's bucket (#345). Absent: its routes answer 501. */
  siem?: SiemConsoleDeps
  deprovision: DeprovisionDeps
  log: Logger
}

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const SESSION_ID = /^sess_[A-Za-z0-9]{1,64}$/

/** A passed test run counts this long towards "required" (sso.md 2.10). */
export const TEST_RUN_WINDOW_MS = 24 * 60 * 60 * 1000

const REQUIRED_MODES: readonly Enforcement[] = ["required_domain", "required_all"]
const STRICTNESS: Record<Enforcement, number> = {
  off: 0,
  optional: 1,
  required_domain: 2,
  required_all: 3,
}

/**
 * What a PATCH does to enforcement (#340): whether the connection BECOMES
 * live and required by it (newly active with a required mode, or a required
 * mode changed while active), and whether that, or loosening or tightening a
 * guarded connection's enforcement, is an owner's move. Turning a guarded
 * connection from `off` to `optional` enforces nothing, so stays an admin's.
 */
export function enforcementChange(
  before: Pick<Connection, "status" | "enforcement">,
  patch: Pick<ConnectionPatch, "status" | "enforcement">,
): { becomesRequired: boolean; ownerOnly: boolean } {
  const status = patch.status ?? before.status
  const enforcement = patch.enforcement ?? before.enforcement
  const changed = enforcement !== before.enforcement
  const requiredBefore =
    before.status === "active" && REQUIRED_MODES.includes(before.enforcement)
  const requiredAfter = status === "active" && REQUIRED_MODES.includes(enforcement)
  const becomesRequired = requiredAfter && (!requiredBefore || changed)
  const guardedChange =
    OWNER_GUARDED.includes(before.status) &&
    changed &&
    (REQUIRED_MODES.includes(enforcement) ||
      STRICTNESS[enforcement] < STRICTNESS[before.enforcement])
  return { becomesRequired, ownerOnly: becomesRequired || guardedChange }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function view(connection: Connection) {
  const caps = capabilitiesOf(connection.protocol, connection.provider)
  return {
    id: connection.id,
    name: connection.name,
    protocol: connection.protocol,
    provider: connection.provider,
    status: connection.status,
    enforcement: connection.enforcement,
    jitEnabled: connection.jitEnabled,
    mfaRequired: connection.mfaRequired,
    relink: connection.relink,
    upnAsEmail: connection.upnAsEmail,
    maxSessionSeconds: connection.maxSessionSeconds,
    idleTimeoutSeconds: connection.idleTimeoutSeconds,
    config: connection.config,
    attributeMapping: connection.attributeMapping,
    capabilities: {
      label: caps.label,
      canProveMfa: caps.canProveMfa,
      canProveFreshAuth: caps.canProveFreshAuth,
      mfaSetting: caps.mfaSetting,
      freshAuthSetting: caps.freshAuthSetting,
      mfaUnprovableReason:
        caps.canProveMfa === "no" ? mfaUnprovableMessage(caps) : null,
    },
  }
}

/**
 * A connection's health for the console (#345), or null when it cannot be read.
 *
 * ⚠ A HEALTH READ THAT FAILS IS NULL, NOT AN ERROR: the connection list is how
 * an admin fixes a connection, and it must load when the health query does not.
 */
async function healthView(
  store: ConnectionHealthStore | undefined,
  tenantId: string,
  connection: Pick<Connection, "id" | "status">,
  now: Date,
  log: Logger,
) {
  if (!store) return null
  try {
    return healthOf(await store.counts(tenantId, connection.id), connection.status, now)
  } catch (err) {
    log.error({ err: String(err), tenantId }, "could not read connection health")
    return null
  }
}

/** Seconds, null, or invalid. At least five minutes, at most ninety days. */
function seconds(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== "number" || !Number.isInteger(value)) return "invalid"
  return value >= 300 && value <= 90 * 24 * 3600 ? value : "invalid"
}

/** The PATCH body as a patch, or a message saying what is wrong with it. */
export function readPatch(body: Record<string, unknown>): ConnectionPatch | string {
  const patch: ConnectionPatch = {}
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100)
      return "name must be 1 to 100 characters."
    patch.name = body.name.trim()
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as ConnectionStatus))
      return "status is not valid."
    patch.status = body.status as ConnectionStatus
  }
  if (body.enforcement !== undefined) {
    if (!ENFORCEMENTS.includes(body.enforcement as Enforcement))
      return "enforcement is not valid."
    patch.enforcement = body.enforcement as Enforcement
  }
  if (body.relink !== undefined) {
    if (!RELINK_MODES.includes(body.relink as RelinkMode))
      return "relink must be ask or auto."
    patch.relink = body.relink as RelinkMode
  }
  for (const key of ["jitEnabled", "mfaRequired", "upnAsEmail"] as const) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== "boolean") return `${key} must be true or false.`
    patch[key] = body[key]
  }
  for (const key of ["maxSessionSeconds", "idleTimeoutSeconds"] as const) {
    const value = seconds(body[key])
    if (value === "invalid") return `${key} must be null or 300 to 7776000 seconds.`
    if (value !== undefined) patch[key] = value
  }
  if (body.attributeMapping !== undefined) {
    const m = body.attributeMapping
    if (
      !m ||
      typeof m !== "object" ||
      Array.isArray(m) ||
      Object.values(m).some((v) => typeof v !== "string")
    )
      return "attributeMapping must map names to names."
    patch.attributeMapping = m as Record<string, string>
  }
  return patch
}

export function mountIdentity(app: Hono, d: ConsoleDeps): void {
  // ⚠ FIRST: Hono runs middleware in registration order, and the plan flags
  // must refuse before any of the routes below runs.
  mountIdentityFeatureGates(app, d)
  mountIdentityApiKeys(app, d)
  mountIdentitySiem(app, d)
  mountIdentityOidc(app, d)
  mountIdentityGroups(app, d)
  mountIdentityRelinks(app, d)
  mountIdentitySaml(app, d)
  mountIdentityScim(app, d)
  mountIdentityMail(app, d)
  mountIdentityLdap(app, d)
  mountIdentityBreakGlass(app, d)
  mountIdentitySetupLinks(app, d)
  mountIdentityWorkspacePolicy(app, d)
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }
  /** Whether the signed-in person may act on `member` as removing them would. */
  const outranked = async (c: Context, member: string) => {
    if (!d.roles) return "forbidden" as const
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const [actor, target] = await Promise.all([
      d.roles.store.roleOf(tenantId, userId),
      d.roles.store.roleOf(tenantId, member),
    ])
    return mayRemove(actor ?? "member", target ?? "member")
  }

  /**
   * ⚠ A DOMAIN IS TRUST TOO (#338): which addresses a connection may sign in
   * and claim. On an active or disabled connection only an owner changes it,
   * as with the issuer and keys - or an admin could move a domain from the
   * owner-guarded connection to one they run. The refusal, or null to go on.
   */
  const domainGuard = async (c: Context, tenantId: string, connectionId: string) => {
    const target = await d.identity!.store.connection(tenantId, connectionId)
    if (!target) return c.json(notFound(), 404)
    if (OWNER_GUARDED.includes(target.status) && !(await allowed(c, "owners:manage")))
      return c.json(
        forbidden("Only an owner can change the domains of an active connection."),
        403,
      )
    return null
  }

  app.get("/identity/connections", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO connections"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see SSO settings."), 403)
    const { tenantId } = c.get("auth")
    const rows = await id.store.connections(tenantId)
    const now = new Date()
    return c.json({
      data: await Promise.all(
        rows.map(async (r) => ({
          ...view(r),
          domains: r.domains,
          health: await healthView(id.health, tenantId, r, now, d.identity!.log),
        })),
      ),
      protocols: id.protocols,
      presets: {
        oidc: Object.values(OIDC_PRESETS).map((p) => ({
          id: p.id,
          label: p.label,
          issuerHint: p.issuerHint,
          requires: p.requires,
          clientAuthMethods: p.clientAuth,
        })),
        saml: Object.values(SAML_PRESETS).map((p) => ({
          id: p.id,
          label: p.label,
          entityIdHint: p.entityIdHint,
          requires: p.requires,
        })),
      },
    })
  })

  /**
   * ⚠ THE RAW CLAIMS ARE AN ADMIN'S TO READ, and only this workspace's: they
   * are the IdP's answer about a real person (name, email, groups). Nothing
   * secret is in them - the bridge keeps the assertion's fields, never the
   * token or the assertion itself.
   */
  app.get("/identity/connections/:id/test-runs", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO test runs"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see SSO settings."), 403)
    const connectionId = c.req.param("id")
    if (!UUID.test(connectionId)) return c.json(notFound(), 404)
    const { tenantId } = c.get("auth")
    if (!(await id.store.connection(tenantId, connectionId)))
      return c.json(notFound(), 404)
    const limit = Number(c.req.query("limit") ?? 10)
    const runs = await id.store.testRuns(
      tenantId,
      connectionId,
      Number.isInteger(limit) ? limit : 10,
    )
    return c.json({ data: runs })
  })

  app.post("/identity/connections", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO connections"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can change SSO settings."), 403)
    const body = (await readJson(c)) ?? {}
    const name = typeof body.name === "string" ? body.name.trim() : ""
    const protocol = body.protocol as Protocol
    const provider =
      typeof body.provider === "string" ? body.provider.trim() : "generic"
    if (!name || name.length > 100)
      return c.json(validation("name must be 1 to 100 characters."), 422)
    /*
     * ⚠ ONLY A PROTOCOL THIS PROCESS HAS AN ENGINE FOR. `test` exists only
     * where the test engine is on; OIDC and SAML arrive with #338 and #339.
     */
    if (!PROTOCOLS.includes(protocol) || !id.protocols.includes(protocol))
      return c.json(validation("That protocol is not available."), 422)
    if (!/^[a-z0-9_-]{1,32}$/.test(provider))
      return c.json(validation("provider is not valid."), 422)
    /*
     * ⚠ AN OIDC CONNECTION IS ONE OF THE PRESETS (#338), and `google` only
     * where our own Google client is configured: without it there is no client
     * to sign anybody in with.
     */
    if (protocol === "oidc") {
      const preset = presetOf(provider)
      if (!preset) return c.json(validation("provider is not valid for OIDC."), 422)
      if (preset.id === "google" && !id.oidc?.engine.google)
        return c.json(validation("Google Workspace sign-in is not available."), 422)
    }
    // A SAML connection is one of its presets too (#339).
    if (protocol === "saml" && !samlPresetOf(provider))
      return c.json(validation("provider is not valid for SAML."), 422)
    // ⚠ THE PLAN FLAG FOLLOWS THE PROTOCOL: Google's one-click preset is its
    // own flag, then OIDC and SAML (sso.md decision 4).
    const refused = await refuseFeature(
      d,
      c,
      protocol === "saml"
        ? "sso_saml"
        : provider === "google"
          ? "sso_google"
          : "sso_oidc",
    )
    if (refused) return refused
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const made = await id.store.createConnection(tenantId, {
      name,
      protocol,
      provider,
      createdBy: userId,
    })
    await id.store.record(tenantId, {
      type: "connection.created",
      actorUserId: userId,
      connectionId: made.id,
      data: { protocol, provider, name },
    })
    return c.json(view(made), 201)
  })

  app.patch("/identity/connections/:id", requireFreshAuth, async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO connections"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can change SSO settings."), 403)
    const connectionId = c.req.param("id")
    if (!UUID.test(connectionId)) return c.json(notFound(), 404)
    const patch = readPatch((await readJson(c)) ?? {})
    if (typeof patch === "string") return c.json(validation(patch), 422)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const before = await id.store.connection(tenantId, connectionId)
    if (!before) return c.json(notFound(), 404)
    /*
     * ⚠ REFUSE MFA REQUIREMENTS THE IdP CANNOT PROVE (P0 #5, sso.md 2.22).
     * Turning `mfaRequired` on when `canProveMfa === "no"` would refuse every
     * sign-in (`mfa_required`); existing rows that already have it on stay on
     * when patching other fields so no data is silently migrated.
     */
    if (patch.mfaRequired === true && !before.mfaRequired) {
      const caps = capabilitiesOf(before.protocol, before.provider)
      if (caps.canProveMfa === "no")
        return c.json(
          {
            statusCode: 422,
            name: "mfa_unprovable",
            code: "mfa_unprovable",
            message: mfaUnprovableMessage(caps),
          },
          422,
        )
    }
    /*
     * ⚠ THE UPN IS AN ADDRESS ONLY FOR ENTRA (sso.md 2.22): other IdPs send an
     * email or nothing, and an opt-in with no meaning there would only be a
     * switch nobody could reason about. Switching it off is always fine.
     */
    if (patch.upnAsEmail === true && before.provider !== "entra")
      return c.json(
        {
          statusCode: 422,
          name: "upn_not_supported",
          code: "upn_not_supported",
          message: "Using the user principal name as the email is only for Microsoft Entra.",
        },
        422,
      )
    /*
     * ⚠ WHAT A CHANGED LOGIN OR A MISSING EMAIL MEANS IS AN OWNER'S TO SET,
     * in either direction and on any status (sso.md 2.22): `auto` moves a
     * person's link on the IdP's word, and the UPN turns an address nobody
     * vouched for into a way to claim an account.
     */
    if (
      ((patch.relink !== undefined && patch.relink !== before.relink) ||
        (patch.upnAsEmail !== undefined && patch.upnAsEmail !== before.upnAsEmail)) &&
      !(await allowed(c, "owners:manage"))
    )
      return c.json(
        forbidden(
          "Only an owner can change what happens when a person's company login changes, or which claim stands in for a missing email.",
        ),
        403,
      )
    // ⚠ TURNING A FEATURE OFF IS NEVER REFUSED BY THE PLAN: only moving to
    // enforcement above "off", or JIT on, needs the flag. A workspace that
    // lost the feature must still be able to stand it down.
    if (patch.enforcement !== undefined && patch.enforcement !== "off") {
      const refused = await refuseFeature(d, c, "sso_enforcement")
      if (refused) return refused
    }
    if (patch.jitEnabled === true) {
      const refused = await refuseFeature(d, c, "jit_rules")
      if (refused) return refused
    }
    /*
     * ⚠ ACTIVATING NEEDS A LIVE DOMAIN. A connection with no domain would sign
     * nobody in, and one whose proof was displaced would claim accounts it no
     * longer has any right to.
     */
    if (patch.status === "active" && before.status !== "active") {
      if ((await id.store.liveDomains(tenantId, connectionId)).length === 0)
        return c.json(
          validation("Add a verified access domain before activating."),
          422,
        )
    }
    /*
     * ⚠ BACK TO DRAFT OR TESTING FROM ACTIVE OR DISABLED IS AN OWNER'S MOVE.
     * Trust changes on an active or disabled connection need an owner
     * (identity-oidc.ts); were an admin able to demote it, edit it and
     * reactivate it, that rule would be decoration. Disabling stays an
     * admin's, because stopping sign-ins is always the safe direction.
     */
    /*
     * ⚠ WEAKENING A LIVE CONNECTION IS AN OWNER'S MOVE TOO: turning off its
     * MFA requirement, or changing which claim is the email (and so who gets
     * claimed). Tightening stays an admin's.
     */
    if (
      OWNER_GUARDED.includes(before.status) &&
      (patch.mfaRequired === false || patch.attributeMapping !== undefined) &&
      !(await allowed(c, "owners:manage"))
    )
      return c.json(
        forbidden("Only an owner can loosen an active connection's checks."),
        403,
      )
    if (
      patch.status !== undefined &&
      OWNER_GUARDED.includes(before.status) &&
      (patch.status === "draft" || patch.status === "testing") &&
      !(await allowed(c, "owners:manage"))
    )
      return c.json(
        forbidden("Only an owner can move an active connection back to setup."),
        403,
      )
    /*
     * ⚠ TURNING JIT ON FOR A LIVE CONNECTION IS AN OWNER'S MOVE (#341): from
     * then on, anybody the IdP names at the connection's domains becomes a
     * member, with whatever role the group rules give. Turning it off stops
     * that, which is the safe direction, so it stays an admin's - as it does
     * when SCIM is on and only the directory should provision (sso.md 2.6).
     * ⚠ AND SO IS ACTIVATING A CONNECTION WITH JIT ON, or an admin would turn
     * it on in draft and then activate: the same step around the rule that
     * moving back to draft would be.
     */
    const jitTurnedOn =
      patch.jitEnabled === true &&
      !before.jitEnabled &&
      OWNER_GUARDED.includes(before.status)
    const goesLiveWithJit =
      patch.status === "active" &&
      !OWNER_GUARDED.includes(before.status) &&
      (patch.jitEnabled ?? before.jitEnabled)
    if ((jitTurnedOn || goesLiveWithJit) && !(await allowed(c, "owners:manage")))
      return c.json(
        forbidden("Only an owner can turn on JIT for an active connection."),
        403,
      )
    /*
     * ⚠ "REQUIRED" IS AN OWNER'S, AND ONLY AFTER A TEST RUN PASSED (#340,
     * sso.md 2.10). Requiring SSO locks every covered member out of every
     * other way in, so it needs proof, within a day, that the IdP signs
     * somebody in; and like turning JIT on it is an owner's move, including
     * activating a connection that already says "required" and loosening a
     * live one's enforcement.
     */
    const enforced = enforcementChange(before, patch)
    if (enforced.ownerOnly && !(await allowed(c, "owners:manage")))
      return c.json(
        forbidden("Only an owner can change whether an active connection is required."),
        403,
      )
    if (enforced.becomesRequired) {
      if (!id.policy) return c.json(notWired("SSO enforcement"), 501)
      const since = new Date(Date.now() - TEST_RUN_WINDOW_MS)
      if (!(await id.policy.passedTestRunSince(tenantId, connectionId, since)))
        return c.json(
          validation(
            "Run a test sign-in that passes first. Requiring SSO needs a passed test run in the last 24 hours.",
          ),
          422,
        )
    }
    // ⚠ A TEST RUN OR A SIGN-IN NEEDS SOMETHING TO TALK TO: an OIDC connection
    // is testable only once its issuer, client and credential are set (#338).
    if (
      before.protocol === "oidc" &&
      (patch.status === "active" || patch.status === "testing") &&
      patch.status !== before.status &&
      !oidcReady(before, id.oidc?.engine.google ?? false)
    )
      return c.json(
        validation(
          "Finish the connection's OIDC settings before testing or activating it.",
        ),
        422,
      )
    // The same for SAML: an entity id, an SSO URL and a certificate valid today.
    if (
      before.protocol === "saml" &&
      (patch.status === "active" || patch.status === "testing") &&
      patch.status !== before.status &&
      !(
        id.saml &&
        samlReady(before, await id.saml.store.certificates(tenantId, connectionId))
      )
    )
      return c.json(
        validation(
          "Finish the connection's SAML settings before testing or activating it.",
        ),
        422,
      )
    const after = await id.store.updateConnection(tenantId, connectionId, patch)
    if (!after) return c.json(notFound(), 404)
    id.enforcement?.forgetTenant(tenantId)
    await id.store.record(tenantId, {
      type: "connection.updated",
      actorUserId: userId,
      connectionId,
      data: {
        changed: Object.keys(patch),
        from: pick(view(before), patch),
        to: pick(view(after), patch),
      },
    })
    /*
     * ⚠ A CONNECTION LEAVING SETUP TAKES ITS SETUP LINKS WITH IT. They serve
     * only draft and testing anyway; revoked, an owner moving the connection
     * back to setup later does not bring an IT contact's old link back.
     */
    if (
      id.policy &&
      SETUP_STATUSES.includes(before.status) &&
      !SETUP_STATUSES.includes(after.status)
    ) {
      const revoked = await id.policy.revokeSetupLinksOf(
        tenantId,
        connectionId,
        "connection_left_setup",
        new Date(),
      )
      for (const linkId of revoked)
        await id.store.record(tenantId, {
          type: "setup_link.revoked",
          actorUserId: userId,
          connectionId,
          reason: "connection_left_setup",
          data: { setupLinkId: linkId, status: after.status },
        })
    }
    return c.json(view(after))
  })

  app.post("/identity/connections/:id/domains", requireFreshAuth, async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO connections"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can change SSO settings."), 403)
    const connectionId = c.req.param("id")
    const body = (await readJson(c)) ?? {}
    const joinDomainId = typeof body.joinDomainId === "string" ? body.joinDomainId : ""
    if (!UUID.test(connectionId) || !UUID.test(joinDomainId))
      return c.json(
        validation("joinDomainId must be one of this workspace's access domains."),
        422,
      )
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const guarded = await domainGuard(c, tenantId, connectionId)
    if (guarded) return guarded
    const added = await id.store.addDomain(tenantId, connectionId, joinDomainId)
    if (added === "not_found")
      return c.json(validation("Use a verified access domain of this workspace."), 422)
    if (added === "taken")
      return c.json(
        {
          statusCode: 409,
          name: "conflict",
          message: "Another connection covers that domain.",
        },
        409,
      )
    id.enforcement?.forgetTenant(tenantId)
    await id.store.record(tenantId, {
      type: "connection.domain_added",
      actorUserId: userId,
      connectionId,
      data: { joinDomainId },
    })
    return c.json({ ok: true })
  })

  app.delete(
    "/identity/connections/:id/domains/:domainId",
    requireFreshAuth,
    async (c) => {
      const id = d.identity
      if (!id) return c.json(notWired("SSO connections"), 501)
      if (!(await allowed(c, "sso:manage")))
        return c.json(forbidden("Only an admin can change SSO settings."), 403)
      const connectionId = c.req.param("id")
      const joinDomainId = c.req.param("domainId")
      if (!UUID.test(connectionId) || !UUID.test(joinDomainId))
        return c.json(notFound(), 404)
      const { tenantId } = c.get("auth")
      const { userId } = c.get("user")
      const guarded = await domainGuard(c, tenantId, connectionId)
      if (guarded) return guarded
      if (!(await id.store.removeDomain(tenantId, connectionId, joinDomainId)))
        return c.json(notFound(), 404)
      id.enforcement?.forgetTenant(tenantId)
      await id.store.record(tenantId, {
        type: "connection.domain_removed",
        actorUserId: userId,
        connectionId,
        data: { joinDomainId },
      })
      return c.json({ ok: true })
    },
  )

  app.get("/identity/settings", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO settings"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see SSO settings."), 403)
    const { tenantId } = c.get("auth")
    return c.json({ deprovision: await id.store.deprovisionMode(tenantId) })
  })

  app.put("/identity/settings", requireFreshAuth, async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO settings"), 501)
    /*
     * ⚠ AN OWNER'S CHOICE, NOT AN ADMIN'S. `account` makes deprovisioning a
     * ban of the whole i10 account, everywhere; who may set that is who may
     * hand the workspace on.
     */
    if (!(await allowed(c, "owners:manage")))
      return c.json(
        forbidden("Only an owner can change what deprovisioning does."),
        403,
      )
    const body = (await readJson(c)) ?? {}
    if (body.deprovision !== "membership" && body.deprovision !== "account")
      return c.json(validation("deprovision must be membership or account."), 422)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const before = await id.store.deprovisionMode(tenantId)
    await id.store.setDeprovisionMode(tenantId, body.deprovision, userId)
    await id.store.record(tenantId, {
      type: "settings.updated",
      actorUserId: userId,
      data: { deprovision: { from: before, to: body.deprovision } },
    })
    return c.json({ deprovision: body.deprovision })
  })

  app.get("/identity/events", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("The identity audit log"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see the identity audit log."), 403)
    const { tenantId } = c.get("auth")
    const limit = Number(c.req.query("limit") ?? 50)
    const subject = c.req.query("user")
    const rows = await id.store.events(tenantId, {
      limit: Number.isFinite(limit) ? limit : 50,
      ...(subject ? { subjectUserId: subject } : {}),
    })
    return c.json({ data: rows })
  })

  // ── A member's sessions (sso.md 2.5) ──────────────────────────────────────

  app.get("/identity/members/:userId/sessions", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("Member sessions"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const member = c.req.param("userId")
    // ⚠ YOUR OWN SESSIONS ARE YOURS TO SEE; ANYBODY ELSE'S NEED `members:manage`.
    if (member !== userId && !(await allowed(c, "members:manage")))
      return c.json(forbidden("Only an admin can see a member's sessions."), 403)
    const rows = await id.store.sessionsOf(tenantId, member)
    return c.json({
      data: rows.map((s) => ({
        sessionId: s.sessionId,
        connectionId: s.connectionId,
        boundAt: s.boundAt,
        freshAt: s.freshAt,
        lastSeenAt: s.lastSeenAt,
      })),
    })
  })

  app.post("/identity/members/:userId/sessions/:sessionId/revoke", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("Member sessions"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const member = c.req.param("userId")
    const sessionId = c.req.param("sessionId")
    if (!SESSION_ID.test(sessionId)) return c.json(notFound(), 404)
    // ⚠ ENDING SOMEBODY ELSE'S SESSION OBEYS THE RULE REMOVING THEM DOES: an
    // admin cannot sign an owner out.
    if (member !== userId && (await outranked(c, member)) !== "ok")
      return c.json(forbidden("You cannot end this person's sessions."), 403)
    const row = await id.store.sessionRow(tenantId, sessionId)
    if (!row || row.clerkUserId !== member || row.revokedAt)
      return c.json(notFound(), 404)
    // ⚠ CLERK FIRST: our row says revoked only once Clerk agreed.
    await id.clerk.revokeSession(sessionId)
    await id.store.revokeSessionRow(tenantId, sessionId, "admin", new Date())
    id.gate.forget({ userId: member, sessionId })
    await id.store.record(tenantId, {
      type: "session.revoked",
      actorUserId: userId,
      subjectUserId: member,
      sessionId,
      connectionId: row.connectionId,
      reason: "admin",
    })
    return c.json({ ok: true })
  })

  app.post("/identity/members/:userId/deprovision", requireFreshAuth, async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("Deprovisioning"), 501)
    if (!(await allowed(c, "members:manage")))
      return c.json(forbidden("Only an admin can deprovision a member."), 403)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const member = c.req.param("userId")
    if (member === userId)
      return c.json(
        validation("Leave the workspace instead of deprovisioning yourself."),
        422,
      )
    const done = await deprovision(id.deprovision, {
      tenantId,
      clerkUserId: member,
      actorUserId: userId,
      cause: "admin",
    })
    id.gate.forget({ userId: member })
    switch (done.outcome) {
      case "membership":
      case "account":
        return c.json(done)
      case "not_managed":
        return c.json(notFound("That person is not managed by this workspace."), 404)
      case "forbidden":
      case "owner_only":
        return c.json(forbidden("You cannot deprovision this person."), 403)
      case "last_owner":
        return c.json(
          {
            statusCode: 409,
            name: "last_owner",
            message: "A workspace needs an owner.",
          },
          409,
        )
      case "unconfirmed":
      case "workspace_gone":
        return c.json(
          {
            statusCode: 503,
            name: "service_unavailable",
            message: "Try again in a minute.",
          },
          503,
        )
    }
  })
}

function pick(
  view: Record<string, unknown>,
  patch: ConnectionPatch,
): Record<string, unknown> {
  return Object.fromEntries(Object.keys(patch).map((k) => [k, view[k]]))
}
