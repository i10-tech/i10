import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type * as oidc from "openid-client"
import { addMember, syncRole, type JoinRole, type Role } from "../src/console/roles.js"
import {
  completeLogin,
  startLogin,
  type BridgeDeps,
  type Engine,
} from "../src/identity/bridge.js"
import { ssoGate } from "../src/identity/gate.js"
import { capabilitiesOf } from "../src/identity/idp-capabilities.js"
import {
  startUrlFor,
  withSsoFreshness,
  type StepUpConnection,
} from "../src/identity/middleware.js"
import {
  assertionProvesMfa,
  type Assertion,
  type Connection,
  type Protocol,
} from "../src/identity/model.js"
import { OIDC_PRESETS } from "../src/identity/oidc-presets.js"
import { groupsStateOf, toAssertion } from "../src/identity/oidc.js"
import type { GroupRoleRule } from "../src/identity/ports.js"
import { SAML_PRESETS } from "../src/identity/saml-presets.js"
import { NAMEID, type VerifiedAssertion } from "../src/identity/saml-verify.js"
import {
  SAML_GROUPS_OVERAGE_ATTRIBUTE,
  samlGroupsStateOf,
  toSamlAssertion,
} from "../src/identity/saml.js"
import { testEngine } from "../src/identity/test-engine.js"
import { requireFreshAuth } from "../src/middleware/session.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import { mountIdentity } from "../src/routes/console/identity.js"
import {
  CONNECTION,
  ORG,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
  user,
} from "./identity-fakes.js"
import { ACME, rolesDeps, row } from "./role-fixtures.js"

/**
 * Group state tri-state, overage / two-branch absent role handling, IdP MFA and
 * fresh-auth capability enforcement, step-up fallback, and Entra future
 * `auth_time` skew (P0 #3 and P0 #5, sso.md 2.13-2.16 and 2.22).
 */

const BINDING = "b".repeat(43)

const rule = (
  over: Partial<GroupRoleRule> & Pick<GroupRoleRule, "groupValue" | "role">,
): GroupRoleRule => ({
  id: `00000000-0000-4000-9000-${String(over.precedence ?? 0).padStart(12, "0")}`,
  connectionId: CONNECTION,
  precedence: 0,
  ...over,
})

function stubEngine(protocol: Protocol): Engine {
  return {
    protocol,
    pkce: protocol === "oidc",
    begin: async (_c, attempt) => ({
      redirectUrl: `https://idp.acme.test/login?state=${attempt.state}`,
      requestId: protocol === "saml" ? "_req_1" : null,
    }),
  }
}

function bridgeWorld(
  options: {
    connection?: Partial<Connection>
    users?: ReturnType<typeof user>[]
    rules?: GroupRoleRule[]
    roles?: ReturnType<typeof row>[]
  } = {},
) {
  let clock = new Date("2026-11-02T12:00:00Z").getTime()
  const conn = connection({
    jitEnabled: true,
    status: "active",
    ...options.connection,
  })
  const store = memoryStore({
    connections: [conn],
    rules: options.rules ?? [],
  })
  const clerk = memoryClerk({ users: options.users ?? [] })
  const members = new Set((options.roles ?? []).map((r) => r.userId))
  const roles = rolesDeps({
    rows: options.roles ?? [],
    tenants: { [ORG]: ACME.tenantId },
    clerk: {
      create: async (_o, userId) => {
        if (members.has(userId)) return { outcome: "already_member" }
        members.add(userId)
        return { outcome: "created", membershipId: `mem_${userId}` }
      },
    },
  })
  const joined: { userId: string; role: JoinRole }[] = []
  const deps: BridgeDeps = {
    store: store.store,
    clerk: clerk.clerk,
    engines: new Map<Protocol, Engine>([
      ["test", testEngine("https://auth.i10.localhost")],
      ["oidc", stubEngine("oidc")],
      ["saml", stubEngine("saml")],
    ]),
    join: async ({ orgId, userId, role }) => {
      joined.push({ userId, role })
      return addMember(roles.d, { orgId, userId, role, source: "sso" })
    },
    isExempt: async (_t, userId) => {
      const r = await roles.d.store.roleOf(ACME.tenantId, userId)
      return r === "owner" || r === "admin"
    },
    jit: true,
    syncRole: (input) => syncRole(roles.d, { ...input, tenantId: ACME.tenantId }),
    log,
    now: () => new Date(clock),
  }

  const assertion = (over: Partial<Assertion> = {}): Assertion => ({
    subject: "idp|ada",
    email: "ada@acme.test",
    emailVerified: true,
    givenName: "Ada",
    familyName: "Lovelace",
    groups: [],
    groupsState: "present",
    authTime: new Date(clock),
    amr: ["pwd"],
    ...over,
  })

  async function startState(
    purpose: "sign_in" | "test_run" | "step_up" = "sign_in",
    stepUp?: { userId: string; sessionId: string },
  ) {
    const started = await startLogin(deps, {
      connectionId: conn.id,
      purpose,
      binding: BINDING,
      returnTo: "https://dash.i10.localhost/ok",
      ...(stepUp ? { stepUp } : {}),
    })
    if (started.outcome !== "redirect")
      throw new Error(`refused start: ${started.reason}`)
    return new URL(started.redirectUrl).searchParams.get("state")!
  }

  return {
    store,
    clerk,
    roles,
    joined,
    deps,
    conn,
    assertion,
    startState,
    now: () => new Date(clock),
    advance: (ms: number) => {
      clock += ms
    },
    roleOf: (userId: string) => roles.d.store.roleOf(ACME.tenantId, userId),
  }
}

describe("OIDC and SAML group state detection (P0 #3)", () => {
  it("marks OIDC _claim_names overage even when a partial groups list arrived", () => {
    expect(
      groupsStateOf(
        {
          _claim_names: { groups: "src1" },
          _claim_sources: {
            src1: {
              endpoint: "https://graph.windows.net/tid/users/oid/getMemberObjects",
            },
          },
        },
        "groups",
      ),
    ).toBe("overage")
    expect(
      groupsStateOf(
        { _claim_names: { groups: "src1" }, groups: ["partial-guid"] },
        "groups",
      ),
    ).toBe("overage")
    expect(groupsStateOf({ _claim_names: { team_ids: "src1" } }, "team_ids")).toBe(
      "overage",
    )

    const mapped = toAssertion(
      {
        iss: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0",
        sub: "entra|ada",
        aud: "client-acme",
        iat: 1_700_000_000,
        exp: 1_700_000_600,
        email: "ada@acme.test",
        xms_edov: true,
        _claim_names: { groups: "src1" },
      } as unknown as oidc.IDToken,
      { attributeMapping: {} },
      { provider: OIDC_PRESETS.entra, mfaAcrValues: [] },
    )
    expect(mapped?.groupsState).toBe("overage")
    expect(mapped?.groups).toEqual([])
  })

  it("distinguishes absent OIDC group claims from explicit empty and populated lists", () => {
    expect(groupsStateOf({}, "groups")).toBe("absent")
    expect(groupsStateOf({ groups: null }, "groups")).toBe("absent")
    expect(groupsStateOf({ groups: [] }, "groups")).toBe("present")
    expect(groupsStateOf({ groups: ["eng"] }, "groups")).toBe("present")
    expect(groupsStateOf({ groups: "eng" }, "groups")).toBe("present")

    const absent = toAssertion(
      {
        iss: "https://accounts.google.com",
        sub: "google|ada",
        aud: "client-google",
        iat: 1_700_000_000,
        exp: 1_700_000_600,
        email: "ada@acme.test",
        email_verified: true,
      } as unknown as oidc.IDToken,
      { attributeMapping: {} },
      { provider: OIDC_PRESETS.google, mfaAcrValues: [] },
    )
    expect(absent?.groupsState).toBe("absent")
    expect(absent?.groups).toEqual([])
  })

  it("marks SAML groups.link as overage and distinguishes absent from empty attributes", () => {
    const nullProto = (entries: Record<string, string[]>): Record<string, string[]> =>
      Object.assign(Object.create(null) as Record<string, string[]>, entries)

    const defaults = SAML_PRESETS.entra.attributes.groups
    expect(
      samlGroupsStateOf(
        nullProto({
          [SAML_GROUPS_OVERAGE_ATTRIBUTE]: [
            "https://graph.windows.net/tid/users/oid/getMemberObjects",
          ],
          groups: ["partial"],
        }),
        {},
        defaults,
      ),
    ).toBe("overage")
    expect(
      samlGroupsStateOf(nullProto({ email: ["ada@acme.test"] }), {}, defaults),
    ).toBe("absent")
    expect(samlGroupsStateOf(nullProto({ groups: [] }), {}, defaults)).toBe("present")
    expect(
      samlGroupsStateOf(nullProto({ dept: ["eng"] }), { dept: "groups" }, defaults),
    ).toBe("present")

    const baseVerified = (attributes: Record<string, string[]>): VerifiedAssertion => ({
      id: "_a1",
      issuer: "https://sts.windows.net/tid/",
      nameId: "entra-oid-ada",
      nameIdFormat: NAMEID.persistent,
      sessionIndex: "s1",
      issueInstant: new Date("2026-11-02T12:00:00Z"),
      authnInstant: new Date("2026-11-02T12:00:00Z"),
      authnContextClassRef: null,
      validUntil: new Date("2026-11-02T12:05:00Z"),
      attributes: nullProto(attributes),
      encrypted: false,
    })

    const overage = toSamlAssertion(
      baseVerified({
        email: ["ada@acme.test"],
        [SAML_GROUPS_OVERAGE_ATTRIBUTE]: [
          "https://graph.windows.net/tid/users/oid/getMemberObjects",
        ],
      }),
      { attributeMapping: {} },
      { preset: SAML_PRESETS.entra, subjectAttribute: null, mfaContextClasses: [] },
    )
    expect(overage?.groupsState).toBe("overage")

    const absent = toSamlAssertion(
      baseVerified({ email: ["ada@acme.test"] }),
      { attributeMapping: {} },
      { preset: SAML_PRESETS.google, subjectAttribute: null, mfaContextClasses: [] },
    )
    expect(absent?.groupsState).toBe("absent")

    const empty = toSamlAssertion(
      baseVerified({ email: ["ada@acme.test"], groups: [] }),
      { attributeMapping: {} },
      { preset: SAML_PRESETS.okta, subjectAttribute: null, mfaContextClasses: [] },
    )
    expect(empty?.groupsState).toBe("present")
    expect(empty?.groups).toEqual([])
  })

  it("reads Okta SAML session.amr / amr attribute values for MFA proof", () => {
    const mk = (attributes: Record<string, string[]>) =>
      toSamlAssertion(
        {
          id: "_a1",
          issuer: "http://www.okta.com/exk1",
          nameId: "okta-ada",
          nameIdFormat: NAMEID.persistent,
          sessionIndex: "s1",
          issueInstant: new Date("2026-11-02T12:00:00Z"),
          authnInstant: new Date("2026-11-02T12:00:00Z"),
          authnContextClassRef:
            "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
          validUntil: new Date("2026-11-02T12:05:00Z"),
          attributes,
          encrypted: false,
        },
        { attributeMapping: {} },
        { preset: SAML_PRESETS.okta, subjectAttribute: null, mfaContextClasses: [] },
      )!

    expect(assertionProvesMfa(mk({ email: ["ada@acme.test"], amr: ["pwd"] }))).toBe(
      false,
    )
    expect(
      assertionProvesMfa(mk({ email: ["ada@acme.test"], amr: ["pwd", "mfa"] })),
    ).toBe(true)
    expect(
      assertionProvesMfa(
        mk({ email: ["ada@acme.test"], "session.amr": ["[pwd, otp]"] }),
      ),
    ).toBe(true)
  })
})

describe("bridge role preservation on missing groups and two-branch absent rule", () => {
  const adminRules = [rule({ groupValue: "eng-admins", role: "admin", precedence: 1 })]

  async function seedManagedAdmin(w: ReturnType<typeof bridgeWorld>) {
    await w.store.store.link(TENANT, {
      connectionId: CONNECTION,
      subject: "idp|ada",
      clerkUserId: "user_ada",
      email: "ada@acme.test",
    })
    await w.store.store.claimManaged(TENANT, {
      clerkUserId: "user_ada",
      tenantId: TENANT,
      connectionId: CONNECTION,
      reason: "linked",
      emails: ["ada@acme.test"],
    })
  }

  it("keeps an admin's role and audits sign_in.groups_unavailable on overage, even after groups were seen before", async () => {
    const w = bridgeWorld({
      users: [user({ id: "user_ada" })],
      rules: adminRules,
      roles: [row("user_owner", "owner"), row("user_ada", "admin")],
    })
    await seedManagedAdmin(w)

    // First sign-in delivers groups normally so groupsLastSeenAt is recorded.
    const first = await completeLogin(w.deps, {
      state: await w.startState(),
      binding: BINDING,
      protocol: "test",
      assertion: w.assertion({ groups: ["eng-admins"], groupsState: "present" }),
    })
    expect(first.outcome).toBe("signed_in")
    expect(w.store.connections.get(CONNECTION)?.groupsLastSeenAt).toBeInstanceOf(Date)

    // Second sign-in hits Entra overage: must STILL keep admin, never demote.
    const second = await completeLogin(w.deps, {
      state: await w.startState(),
      binding: BINDING,
      protocol: "test",
      assertion: w.assertion({ groups: [], groupsState: "overage" }),
    })
    expect(second.outcome).toBe("signed_in")
    expect(await w.roleOf("user_ada")).toBe("admin")
    const event = w.store.events.find((e) => e.type === "sign_in.groups_unavailable")
    expect(event).toMatchObject({
      type: "sign_in.groups_unavailable",
      subjectUserId: "user_ada",
      connectionId: CONNECTION,
      reason: "overage",
    })
    expect(JSON.stringify(event?.data ?? {})).not.toContain("ada@acme.test")
    expect(w.store.events.filter((e) => e.type === "role.synced")).toHaveLength(0)
  })

  it("keeps an admin's role and audits absent when the connection has NEVER delivered groups (Google OIDC / missing scope)", async () => {
    const w = bridgeWorld({
      connection: { groupsLastSeenAt: null },
      users: [user({ id: "user_ada" })],
      rules: adminRules,
      roles: [row("user_owner", "owner"), row("user_ada", "admin")],
    })
    await seedManagedAdmin(w)

    const done = await completeLogin(w.deps, {
      state: await w.startState(),
      binding: BINDING,
      protocol: "test",
      assertion: w.assertion({ groups: [], groupsState: "absent" }),
    })
    expect(done.outcome).toBe("signed_in")
    expect(await w.roleOf("user_ada")).toBe("admin")
    expect(w.store.connections.get(CONNECTION)?.groupsLastSeenAt).toBeNull()
    const event = w.store.events.find((e) => e.type === "sign_in.groups_unavailable")
    expect(event).toMatchObject({
      type: "sign_in.groups_unavailable",
      subjectUserId: "user_ada",
      connectionId: CONNECTION,
      reason: "absent",
    })
    expect(JSON.stringify(event?.data ?? {})).not.toContain("ada@acme.test")
  })

  it("treats absent as empty [] and demotes once the connection HAS delivered groups before (Okta filter match none)", async () => {
    const w = bridgeWorld({
      users: [user({ id: "user_ada" })],
      rules: adminRules,
      roles: [row("user_owner", "owner"), row("user_ada", "member")],
    })
    await seedManagedAdmin(w)

    // Sign-in 1: Okta sends groups: ["eng-admins"] -> promoted to admin, groupsLastSeenAt set.
    const promoted = await completeLogin(w.deps, {
      state: await w.startState(),
      binding: BINDING,
      protocol: "test",
      assertion: w.assertion({ groups: ["eng-admins"], groupsState: "present" }),
    })
    expect(promoted.outcome).toBe("signed_in")
    expect(await w.roleOf("user_ada")).toBe("admin")
    expect(w.store.connections.get(CONNECTION)?.groupsLastSeenAt).toBeInstanceOf(Date)

    // Sign-in 2: Ada removed from eng-admins in Okta; Okta omits `groups` (`absent`).
    w.advance(60_000)
    const demoted = await completeLogin(w.deps, {
      state: await w.startState(),
      binding: BINDING,
      protocol: "test",
      assertion: w.assertion({ groups: [], groupsState: "absent" }),
    })
    expect(demoted.outcome).toBe("signed_in")
    expect(await w.roleOf("user_ada")).toBe("member")
    expect(w.store.events.some((e) => e.type === "sign_in.groups_unavailable")).toBe(
      false,
    )
    expect(w.store.events.at(-2)).toMatchObject({
      type: "role.synced",
      subjectUserId: "user_ada",
    })
  })

  it("joins a brand-new JIT user with default member role AND records sign_in.groups_unavailable", async () => {
    for (const groupsState of ["overage", "absent"] as const) {
      const w = bridgeWorld({
        rules: adminRules,
        roles: [row("user_owner", "owner")],
      })
      const done = await completeLogin(w.deps, {
        state: await w.startState(),
        binding: BINDING,
        protocol: "test",
        assertion: w.assertion({
          subject: `idp|new_${groupsState}`,
          email: "newperson@acme.test",
          groups: [],
          groupsState,
        }),
      })
      expect(done.outcome).toBe("signed_in")
      expect(w.joined).toHaveLength(1)
      expect(w.joined[0]!.role).toBe("member")
      expect(await w.roleOf(w.joined[0]!.userId)).toBe("member")
      const event = w.store.events.find((e) => e.type === "sign_in.groups_unavailable")
      expect(event).toMatchObject({
        type: "sign_in.groups_unavailable",
        subjectUserId: w.joined[0]!.userId,
        connectionId: CONNECTION,
        reason: groupsState,
      })
      expect(JSON.stringify(event?.data ?? {})).not.toContain("newperson@acme.test")
    }
  })

  it("includes groupsState in test-run claims and unavailable reason in resolution", async () => {
    const w = bridgeWorld({
      users: [user({ id: "user_ada" })],
      rules: adminRules,
      roles: [row("user_owner", "owner"), row("user_ada", "admin")],
    })
    await seedManagedAdmin(w)

    const overageDone = await completeLogin(w.deps, {
      state: await w.startState("test_run"),
      binding: BINDING,
      protocol: "test",
      assertion: w.assertion({ groups: [], groupsState: "overage" }),
    })
    expect(overageDone.outcome).toBe("tested")

    const jitAbsentDone = await completeLogin(w.deps, {
      state: await w.startState("test_run"),
      binding: BINDING,
      protocol: "test",
      assertion: w.assertion({
        subject: "idp|new",
        email: "new@acme.test",
        groups: [],
        groupsState: "absent",
      }),
    })
    expect(jitAbsentDone.outcome).toBe("tested")

    const runs = await w.store.store.testRuns(TENANT, CONNECTION, 10)
    expect(runs).toHaveLength(2)
    expect(runs[0]!.claims.groupsState).toBe("absent")
    expect(runs[0]!.resolution).toMatchObject({
      path: "jit",
      wouldCreate: true,
      groupsUnavailable: "absent",
    })
    expect(runs[1]!.claims.groupsState).toBe("overage")
    expect(runs[1]!.resolution).toMatchObject({
      path: "linked",
      groupsUnavailable: "overage",
      roleKept: true,
    })
  })
})

describe("per-provider MFA and fresh-auth capability table (P0 #5, sso.md 2.22)", () => {
  it("matches the live probe results for Google, Entra, Okta and Generic", () => {
    expect(capabilitiesOf("oidc", "google")).toMatchObject({
      canProveMfa: "no",
      canProveFreshAuth: "no",
    })
    expect(capabilitiesOf("saml", "google")).toMatchObject({
      canProveMfa: "no",
      canProveFreshAuth: "no",
    })
    expect(capabilitiesOf("oidc", "entra")).toMatchObject({
      canProveMfa: "no",
      canProveFreshAuth: "with_setting",
    })
    expect(capabilitiesOf("oidc", "entra").freshAuthSetting).toContain("auth_time")
    expect(capabilitiesOf("saml", "entra")).toMatchObject({
      canProveMfa: "yes",
      canProveFreshAuth: "yes",
    })
    expect(capabilitiesOf("oidc", "okta")).toMatchObject({
      canProveMfa: "yes",
      canProveFreshAuth: "yes",
    })
    const oktaSaml = capabilitiesOf("saml", "okta")
    expect(oktaSaml).toMatchObject({
      canProveMfa: "with_setting",
      canProveFreshAuth: "with_setting",
    })
    expect(oktaSaml.mfaSetting).toContain("session.amr")
    expect(oktaSaml.freshAuthSetting).toContain("Honor Force Authentication")
    expect(capabilitiesOf("oidc", "generic")).toMatchObject({
      canProveMfa: "yes",
      canProveFreshAuth: "yes",
    })
    expect(capabilitiesOf("saml", "generic")).toMatchObject({
      canProveMfa: "yes",
      canProveFreshAuth: "yes",
    })
  })
})

describe("console API refusal and with_setting guidance on mfaRequired", () => {
  const ROLES: Record<string, Role> = {
    user_owner: "owner",
    user_admin: "admin",
  }

  function consoleWorld(connections: Connection[]) {
    const live = Object.fromEntries(connections.map((c) => [c.id, ["acme.test"]]))
    const store = memoryStore({ connections, live })
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("auth", {
        apiKeyId: "",
        tenantId: TENANT,
        scopes: [],
        mode: "live",
      } as never)
      c.set("user", {
        userId: c.req.header("x-user") ?? "user_admin",
        orgId: ORG,
      } as never)
      c.set("freshAuth", async () => ({ status: "fresh" }))
      await next()
    })
    mountIdentity(app, {
      roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
      identity: {
        store: store.store,
        clerk: memoryClerk().clerk,
        gate: { forget: () => {} },
        protocols: ["test", "oidc", "saml"],
        deprovision: {},
        log,
      },
    } as unknown as ConsoleDeps)

    const patch = (id: string, body: Record<string, unknown>, actor = "user_admin") =>
      app.request(`/identity/connections/${id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-user": actor,
        },
        body: JSON.stringify(body),
      })
    const list = (actor = "user_admin") =>
      app.request("/identity/connections", { headers: { "x-user": actor } })

    return { store, patch, list }
  }

  it("refuses turning mfaRequired on for Google OIDC, Google SAML and Entra OIDC with mfa_unprovable", async () => {
    const googleOidcId = "00000000-0000-4000-8000-000000000011"
    const googleSamlId = "00000000-0000-4000-8000-000000000012"
    const entraOidcId = "00000000-0000-4000-8000-000000000013"
    const w = consoleWorld([
      connection({ id: googleOidcId, protocol: "oidc", provider: "google" }),
      connection({ id: googleSamlId, protocol: "saml", provider: "google" }),
      connection({ id: entraOidcId, protocol: "oidc", provider: "entra" }),
    ])

    for (const [id, expectedName] of [
      [googleOidcId, "Google Workspace"],
      [googleSamlId, "Google Workspace"],
      [entraOidcId, "Microsoft Entra ID"],
    ] as const) {
      const res = await w.patch(id, { mfaRequired: true })
      expect(res.status).toBe(422)
      const body = (await res.json()) as {
        code: string
        name: string
        message: string
      }
      expect(body.code).toBe("mfa_unprovable")
      expect(body.name).toBe("mfa_unprovable")
      expect(body.message).toContain(expectedName)
      expect(w.store.connections.get(id)?.mfaRequired).toBe(false)
    }
  })

  it("allows turning mfaRequired on for Okta SAML and returns the required IdP setting text", async () => {
    const oktaSamlId = "00000000-0000-4000-8000-000000000014"
    const w = consoleWorld([
      connection({ id: oktaSamlId, protocol: "saml", provider: "okta" }),
    ])
    const res = await w.patch(oktaSamlId, { mfaRequired: true })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      mfaRequired: boolean
      capabilities: { canProveMfa: string; mfaSetting: string | null }
    }
    expect(body.mfaRequired).toBe(true)
    expect(body.capabilities.canProveMfa).toBe("with_setting")
    expect(body.capabilities.mfaSetting).toContain("session.amr")
  })

  it("keeps an already-enabled mfaRequired connection intact on unrelated edits and lets an owner turn it off", async () => {
    const legacyGoogleId = "00000000-0000-4000-8000-000000000015"
    const w = consoleWorld([
      connection({
        id: legacyGoogleId,
        protocol: "oidc",
        provider: "google",
        mfaRequired: true,
      }),
    ])

    const listed = (await (await w.list()).json()) as {
      data: {
        id: string
        mfaRequired: boolean
        capabilities: { canProveMfa: string; mfaUnprovableReason: string | null }
      }[]
    }
    expect(listed.data[0]).toMatchObject({
      id: legacyGoogleId,
      mfaRequired: true,
      capabilities: { canProveMfa: "no" },
    })
    expect(listed.data[0]!.capabilities.mfaUnprovableReason).toContain(
      "Google Workspace",
    )

    const renamed = await w.patch(legacyGoogleId, { name: "Google SSO" })
    expect(renamed.status).toBe(200)
    expect(w.store.connections.get(legacyGoogleId)?.mfaRequired).toBe(true)

    // A form that resends the whole state, MFA included, is not turning it on.
    const resent = await w.patch(legacyGoogleId, { name: "Google", mfaRequired: true })
    expect(resent.status).toBe(200)

    const turnedOff = await w.patch(
      legacyGoogleId,
      { mfaRequired: false },
      "user_owner",
    )
    expect(turnedOff.status).toBe(200)
    expect(w.store.connections.get(legacyGoogleId)?.mfaRequired).toBe(false)
  })
})

describe("step-up fallback and Entra future auth_time skew", () => {
  function stepUpApp(options: {
    connection: StepUpConnection
    ssoFresh: boolean
    clerkFresh: boolean
  }) {
    const app = new Hono()
    const reader = withSsoFreshness(
      async () => ({ status: options.clerkFresh ? "fresh" : "stale" }),
      async () => ({ status: "ok", userId: "user_ada", sessionId: "sess_1" }),
      {
        check: async () => ({ status: "pass" }),
        freshness: async () => ({ managed: true, fresh: options.ssoFresh }),
        forget: () => {},
      },
      startUrlFor("https://auth.i10.localhost", "/sso/step-up"),
      async () => options.connection,
      log,
    )
    app.use("*", async (c, next) => {
      c.set("freshAuth", reader)
      await next()
    })
    app.post("/sensitive", requireFreshAuth, (c) => c.text("ok"))
    return app
  }

  it("falls back to Clerk step-up (passkey / 2FA) for Google OIDC and Google SAML instead of SSO step-up", async () => {
    for (const protocol of ["oidc", "saml"] as const) {
      const stale = await stepUpApp({
        connection: { id: CONNECTION, protocol, provider: "google" },
        ssoFresh: true,
        clerkFresh: false,
      }).request("/sensitive", { method: "POST" })
      expect(stale.status).toBe(403)
      const body = (await stale.json()) as {
        name: string
        startUrl?: string
        clerk_error?: { reason?: string }
      }
      expect(body.name).toBe("invalid_access")
      expect(body.startUrl).toBeUndefined()
      expect(body.clerk_error?.reason).toBe("reverification-error")

      const fresh = await stepUpApp({
        connection: { id: CONNECTION, protocol, provider: "google" },
        ssoFresh: false,
        clerkFresh: true,
      }).request("/sensitive", { method: "POST" })
      expect(fresh.status).toBe(200)
    }
  })

  it("keeps SSO step-up for capable providers (Okta and Entra)", async () => {
    for (const conn of [
      { id: CONNECTION, protocol: "oidc" as const, provider: "okta" },
      { id: CONNECTION, protocol: "oidc" as const, provider: "entra" },
      { id: CONNECTION, protocol: "saml" as const, provider: "okta" },
      { id: CONNECTION, protocol: "saml" as const, provider: "entra" },
    ]) {
      const res = await stepUpApp({
        connection: conn,
        ssoFresh: false,
        clerkFresh: true,
      }).request("/sensitive", { method: "POST" })
      expect(res.status).toBe(403)
      const body = (await res.json()) as {
        statusCode: number
        name: string
        message: string
        startUrl: string
      }
      expect(body).toEqual({
        statusCode: 403,
        name: "sso_step_up_required",
        message: "Sign in with your company's SSO again before doing this.",
        startUrl: `https://auth.i10.localhost/sso/step-up?connection=${CONNECTION}`,
      })
    }
  })

  it("refuses step_up attempts in startLogin and completeLogin for Google SAML as well as Google OIDC", async () => {
    const w = bridgeWorld({
      connection: { protocol: "saml", provider: "google" },
    })
    await w.store.store.bindSession(TENANT, {
      sessionId: "sess_1",
      clerkUserId: "user_ada",
      connectionId: CONNECTION,
      identityId: null,
      idpSession: null,
      authTime: w.now(),
      at: w.now(),
      freshAt: w.now(),
    })
    const started = await startLogin(w.deps, {
      connectionId: CONNECTION,
      purpose: "step_up",
      binding: BINDING,
      returnTo: "https://dash.i10.localhost/ok",
      stepUp: { userId: "user_ada", sessionId: "sess_1" },
    })
    expect(started).toEqual({ outcome: "refused", reason: "step_up_unsupported" })

    // Even if an attempt row existed before a policy/capability change, completeLogin refuses too.
    const { hashSecret } = await import("../src/identity/model.js")
    await w.store.store.createAttempt({
      tenantId: TENANT,
      connectionId: CONNECTION,
      purpose: "step_up",
      stateHash: hashSecret("s_google_stepup"),
      bindingHash: hashSecret(BINDING),
      nonce: "n1",
      pkceVerifier: null,
      requestId: "_r1",
      returnTo: "https://dash.i10.localhost/ok",
      stepUpSessionId: "sess_1",
      loginHint: null,
      expiresAt: new Date(w.now().getTime() + 60_000),
    })
    const completed = await completeLogin(w.deps, {
      state: "s_google_stepup",
      binding: BINDING,
      protocol: "saml",
      assertion: w.assertion(),
    })
    expect(completed).toEqual({ outcome: "refused", reason: "step_up_unsupported" })
  })

  it("accepts Entra auth_time 39 seconds ahead, refuses 10 minutes ahead, and still refuses stale auth_time", async () => {
    const w = bridgeWorld({
      connection: { protocol: "oidc", provider: "entra" },
      users: [user({ id: "user_ada" })],
    })
    const linked = await w.store.store.link(TENANT, {
      connectionId: CONNECTION,
      subject: "entra|ada",
      clerkUserId: "user_ada",
      email: "ada@acme.test",
    })
    w.store.managed.set("user_ada", {
      clerkUserId: "user_ada",
      tenantId: TENANT,
      connectionId: CONNECTION,
      reason: "linked",
      emails: ["ada@acme.test"],
    })
    const oldAuth = new Date(w.now().getTime() - 20 * 60_000)
    await w.store.store.bindSession(TENANT, {
      sessionId: "sess_1",
      clerkUserId: "user_ada",
      connectionId: CONNECTION,
      identityId: linked.id,
      idpSession: null,
      authTime: oldAuth,
      at: oldAuth,
      freshAt: oldAuth,
    })

    const gate = ssoGate({
      store: w.store.store,
      clerk: w.clerk.clerk,
      log,
      now: () => w.now().getTime(),
    })
    expect(await gate.freshness("user_ada", "sess_1")).toEqual({
      managed: true,
      fresh: false,
    })

    // 1. Stale auth_time (> 5 minutes ago) is still refused.
    const staleState = await w.startState("step_up", {
      userId: "user_ada",
      sessionId: "sess_1",
    })
    const stale = await completeLogin(w.deps, {
      state: staleState,
      binding: BINDING,
      protocol: "oidc",
      assertion: w.assertion({
        subject: "entra|ada",
        authTime: new Date(w.now().getTime() - (5 * 60_000 + 1)),
      }),
    })
    expect(stale).toEqual({
      outcome: "refused",
      reason: "step_up_stale",
    })

    // 2. Future auth_time 10 minutes ahead is refused.
    const farFutureState = await w.startState("step_up", {
      userId: "user_ada",
      sessionId: "sess_1",
    })
    const farFuture = await completeLogin(w.deps, {
      state: farFutureState,
      binding: BINDING,
      protocol: "oidc",
      assertion: w.assertion({
        subject: "entra|ada",
        authTime: new Date(w.now().getTime() + 10 * 60_000),
      }),
    })
    expect(farFuture).toEqual({
      outcome: "refused",
      reason: "step_up_stale",
    })

    // 3. Entra's observed 39 seconds ahead is accepted, and gate.freshness sees it fresh at once.
    const entraState = await w.startState("step_up", {
      userId: "user_ada",
      sessionId: "sess_1",
    })
    const entraAhead = new Date(w.now().getTime() + 39_000)
    const accepted = await completeLogin(w.deps, {
      state: entraState,
      binding: BINDING,
      protocol: "oidc",
      assertion: w.assertion({
        subject: "entra|ada",
        authTime: entraAhead,
      }),
    })
    expect(accepted).toEqual({
      outcome: "stepped_up",
      returnTo: "https://dash.i10.localhost/ok",
    })
    expect(await gate.freshness("user_ada", "sess_1")).toEqual({
      managed: true,
      fresh: true,
    })
  })
})
