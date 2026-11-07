import { describe, expect, it } from "bun:test"
import { completeLogin, startLogin, type BridgeDeps } from "../src/identity/bridge.js"
import { OIDC_PRESETS } from "../src/identity/oidc-presets.js"
import { toAssertion } from "../src/identity/oidc.js"
import { SAML_PRESETS } from "../src/identity/saml-presets.js"
import { ENTRA_UPN_ATTRIBUTE, toSamlAssertion } from "../src/identity/saml.js"
import { NAMEID, type VerifiedAssertion } from "../src/identity/saml-verify.js"
import { testEngine } from "../src/identity/test-engine.js"
import {
  refusalMessage,
  upnAsAddress,
  type Assertion,
  type Connection,
} from "../src/identity/model.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
  user,
} from "./identity-fakes.js"

/**
 * A changed IdP subject (sso.md 2.22) and the Entra UPN opt-in: the bridge
 * decisions with in-memory ports, and the two engines' claim reading. The
 * console routes are identity-relink-console.test.ts; the store is
 * identity-db.test.ts.
 */

const BINDING = "b".repeat(43)
const ADA = "user_ada"

function world(
  options: {
    connection?: Partial<Connection>
    users?: ReturnType<typeof user>[]
    exempt?: string[]
    scim?: string | null
  } = {},
) {
  const clock = new Date("2026-11-02T10:00:00Z").getTime()
  const store = memoryStore({ connections: [connection(options.connection)] })
  const clerk = memoryClerk(options.users ? { users: options.users } : {})
  const exempt = options.exempt ?? []
  const deps: BridgeDeps = {
    store: store.store,
    clerk: clerk.clerk,
    engines: new Map([["test", testEngine("https://auth.i10.localhost")]]),
    join: async () => "added",
    isExempt: async (_t, userId) => exempt.includes(userId),
    ...(options.scim !== undefined
      ? { preProvisioned: async () => options.scim! }
      : {}),
    log,
    now: () => new Date(clock),
  }
  const now = () => new Date(clock)
  const assertion = (over: Partial<Assertion> = {}): Assertion => ({
    subject: "okta|ada",
    email: "ada@acme.test",
    emailVerified: true,
    groupsState: "present",
    authTime: now(),
    amr: ["pwd"],
    ...over,
  })
  async function complete(
    over: Partial<Assertion> = {},
    purpose: "sign_in" | "test_run" = "sign_in",
  ) {
    const started = await startLogin(deps, {
      connectionId: CONNECTION,
      purpose,
      binding: BINDING,
      returnTo: null,
    })
    if (started.outcome !== "redirect") throw new Error("not started")
    const state = new URL(started.redirectUrl).searchParams.get("state")!
    return completeLogin(deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: assertion(over),
    })
  }
  const events = (type: string) => store.events.filter((e) => e.type === type)
  return { deps, store, clerk, exempt, assertion, complete, events, now }
}

/** Ada signed in once under `okta|ada`, so her account is linked and managed. */
async function linked(options: Parameters<typeof world>[0] = {}) {
  const w = world(options)
  const first = await w.complete()
  expect(first.outcome).toBe("signed_in")
  expect(w.store.identities).toHaveLength(1)
  return w
}

const RENAMED = { subject: "okta|ada-renamed" }

describe("a changed subject, relink: auto", () => {
  it("moves the link, audits it without the subjects or the address, and signs the person in", async () => {
    const w = await linked({ connection: { relink: "auto" } })
    const done = await w.complete(RENAMED)
    expect(done.outcome).toBe("signed_in")
    expect(w.store.identities).toHaveLength(1)
    expect(w.store.identities[0]!.subject).toBe("okta|ada-renamed")
    const [event] = w.events("identity.relinked")
    expect(event).toMatchObject({
      subjectUserId: ADA,
      connectionId: CONNECTION,
      data: { connectionId: CONNECTION, via: "auto" },
    })
    const logged = JSON.stringify(event)
    for (const secret of ["okta|ada", "okta|ada-renamed", "ada@acme.test"])
      expect(logged).not.toContain(secret)
    expect(event!.data!.from).not.toBe(event!.data!.to)
    expect(w.events("identity.relink_requested")).toHaveLength(0)
    // The next sign-in under the new subject is a plain link.
    expect((await w.complete(RENAMED)).outcome).toBe("signed_in")
    expect(w.events("identity.relinked")).toHaveLength(1)
  })

  it("refuses an address the IdP did not vouch for, before anything moves", async () => {
    const w = await linked({ connection: { relink: "auto" } })
    const done = await w.complete({ ...RENAMED, emailVerified: false })
    expect(done).toMatchObject({ outcome: "refused", reason: "email_unverified" })
    expect(w.store.identities[0]!.subject).toBe("okta|ada")
    expect(w.store.relinks).toHaveLength(0)
  })

  it("refuses an address off the domains this connection proved", async () => {
    const w = await linked({ connection: { relink: "auto" } })
    const done = await w.complete({ ...RENAMED, email: "ada@elsewhere.test" })
    expect(done).toMatchObject({ outcome: "refused", reason: "domain_not_verified" })
    expect(w.store.identities[0]!.subject).toBe("okta|ada")
    expect(w.store.relinks).toHaveLength(0)
  })

  it("asks an owner when the address is not one the linked account holds", async () => {
    // A directory (SCIM) says the new subject is Ada, but Clerk does not
    // hold the asserted address on her account.
    const w = await linked({ connection: { relink: "auto" }, scim: ADA })
    const done = await w.complete({ ...RENAMED, email: "ada.new@acme.test" })
    expect(done).toMatchObject({ outcome: "refused", reason: "subject_changed" })
    expect(w.store.identities[0]!.subject).toBe("okta|ada")
    expect(w.store.relinks).toHaveLength(1)
    expect(w.events("identity.relink_requested")).toHaveLength(1)
    expect(w.events("identity.relinked")).toHaveLength(0)
  })

  it("leaves an owner or admin's link to an owner, whatever the setting", async () => {
    const w = await linked({ connection: { relink: "auto" } })
    w.exempt.push(ADA)
    const done = await w.complete(RENAMED)
    expect(done).toMatchObject({ outcome: "refused", reason: "subject_changed" })
    expect(w.store.identities[0]!.subject).toBe("okta|ada")
    expect(w.store.relinks).toHaveLength(1)
  })

  it("moves nothing for a person who is refused for another reason", async () => {
    const w = await linked({ connection: { relink: "auto" } })
    w.clerk.users.get(ADA)!.banned = true
    const done = await w.complete(RENAMED)
    expect(done).toMatchObject({ outcome: "refused", reason: "account_banned" })
    expect(w.store.identities[0]!.subject).toBe("okta|ada")
    expect(w.store.relinks).toHaveLength(0)
  })
})

describe("a changed subject, relink: ask", () => {
  it("refuses with the plain message and files one request an owner can approve", async () => {
    const w = await linked()
    const done = await w.complete(RENAMED)
    expect(done).toEqual({ outcome: "refused", reason: "subject_changed" })
    expect(refusalMessage("subject_changed")).toContain("company login changed")
    expect(refusalMessage("subject_changed")).toContain("administrator")
    expect(w.store.identities[0]!.subject).toBe("okta|ada")
    expect(w.store.relinks).toHaveLength(1)
    const [request] = w.store.relinks
    expect(request!.newSubject).toBe("okta|ada-renamed")
    expect(request!.emailHash).not.toContain("ada@")
    expect(request!.expiresAt.getTime() - w.now().getTime()).toBe(7 * 24 * 3600_000)
    const [event] = w.events("identity.relink_requested")
    expect(JSON.stringify(event)).not.toContain("ada@acme.test")
    expect(JSON.stringify(event)).not.toContain("okta|ada")
  })

  it("files it once however many times the person retries, and audits it once", async () => {
    const w = await linked()
    for (let i = 0; i < 3; i++)
      expect(await w.complete(RENAMED)).toMatchObject({ reason: "subject_changed" })
    expect(w.store.relinks).toHaveLength(1)
    expect(w.events("identity.relink_requested")).toHaveLength(1)
    // A different new subject replaces the request: one pending per identity.
    await w.complete({ subject: "okta|ada-again" })
    expect(w.store.relinks).toHaveLength(1)
    expect(w.store.relinks[0]!.newSubject).toBe("okta|ada-again")
    expect(w.events("identity.relink_requested")).toHaveLength(2)
  })

  it("lets the next sign-in through once the link has been moved", async () => {
    const w = await linked()
    await w.complete(RENAMED)
    const [request] = w.store.relinks
    const approved = await w.store.store.approveRelink(TENANT, {
      connectionId: CONNECTION,
      requestId: request!.id,
      now: w.now(),
    })
    expect(approved.outcome).toBe("moved")
    expect((await w.complete(RENAMED)).outcome).toBe("signed_in")
    expect(w.store.relinks).toHaveLength(0)
  })
})

describe("test runs never move a link", () => {
  it("shows would_relink for auto and subject_changed for ask, and writes nothing else", async () => {
    const auto = await linked({ connection: { relink: "auto" } })
    expect((await auto.complete(RENAMED, "test_run")).outcome).toBe("tested")
    const run = auto.store.testRuns.at(-1) as Record<string, unknown>
    expect(run).toMatchObject({ outcome: "passed", reason: null })
    expect(run.resolution).toMatchObject({
      path: "linked",
      wouldRelink: true,
      clerkUserId: ADA,
    })
    expect(auto.store.identities[0]!.subject).toBe("okta|ada")
    expect(auto.events("identity.relinked")).toHaveLength(0)

    const ask = await linked()
    expect((await ask.complete(RENAMED, "test_run")).outcome).toBe("tested")
    const refused = ask.store.testRuns.at(-1) as Record<string, unknown>
    expect(refused).toMatchObject({ outcome: "failed", reason: "subject_changed" })
    expect(ask.store.identities[0]!.subject).toBe("okta|ada")
    expect(ask.store.relinks).toHaveLength(0)
    expect(ask.events("identity.relink_requested")).toHaveLength(0)
  })
})

describe("the Entra UPN as an email (opt-in)", () => {
  const entra = (over: Partial<Connection> = {}) => ({
    provider: "entra",
    upnAsEmail: true,
    ...over,
  })
  const oidc = (claims: Record<string, unknown>, conn: Partial<Connection>) =>
    toAssertion(
      { iss: "x", aud: "y", iat: 0, exp: 0, sub: "oid-ada", ...claims } as never,
      { attributeMapping: {}, ...conn },
      { provider: OIDC_PRESETS.entra, mfaAcrValues: [] },
    )!

  it("refuses a member Entra sent no email for while the opt-in is off", async () => {
    const claims = { preferred_username: "ada@acme.test" }
    const a = oidc(claims, { provider: "entra", upnAsEmail: false })
    expect(a.email).toBeNull()
    const w = world({ connection: { provider: "entra" } })
    expect(await w.complete({ ...a, subject: "oid-ada" })).toMatchObject({
      outcome: "refused",
      reason: "no_email",
    })
  })

  it("signs the member in on a proved domain, marked as a UPN and never as IdP-verified", async () => {
    const a = oidc({ preferred_username: "Ada@Acme.test" }, entra())
    expect(a).toMatchObject({
      email: "ada@acme.test",
      emailVerified: false,
      emailSource: "upn",
    })
    const w = world({ connection: entra() })
    expect((await w.complete(a)).outcome).toBe("signed_in")
    expect(w.store.identities[0]!.email).toBe("ada@acme.test")
  })

  it("refuses a UPN on a domain the workspace has not proved", async () => {
    const a = oidc({ preferred_username: "ada@tenant.onmicrosoft.com" }, entra())
    const w = world({ connection: entra() })
    expect(await w.complete(a)).toMatchObject({
      outcome: "refused",
      reason: "domain_not_verified",
    })
  })

  it("never counts a guest's UPN", async () => {
    const a = oidc({ preferred_username: "ada_gmail.com#EXT#@acme.test" }, entra())
    expect(a.email).toBeNull()
    expect(upnAsAddress("ada_gmail.com#ext#@acme.test")).toBeNull()
    const w = world({ connection: entra() })
    expect(await w.complete(a)).toMatchObject({
      outcome: "refused",
      reason: "no_email",
    })
  })

  it("ignores the UPN whenever a real email claim exists", () => {
    const a = oidc(
      { email: "real@acme.test", xms_edov: true, preferred_username: "upn@acme.test" },
      entra(),
    )
    expect(a).toMatchObject({ email: "real@acme.test", emailVerified: true })
    expect(a.emailSource).toBeUndefined()
  })

  it("is for Entra only: another provider's preferred_username is not an address", () => {
    const a = oidc(
      { preferred_username: "ada@acme.test" },
      {
        provider: "okta",
        upnAsEmail: true,
      },
    )
    expect(a.email).toBeNull()
  })

  it("does not vouch for a UPN the connection has not opted into", async () => {
    const w = world({ connection: { provider: "entra", upnAsEmail: false } })
    expect(
      await w.complete({ emailSource: "upn", emailVerified: false }),
    ).toMatchObject({ outcome: "refused", reason: "email_unverified" })
    const other = world({ connection: { provider: "okta", upnAsEmail: true } })
    expect(
      await other.complete({ emailSource: "upn", emailVerified: false }),
    ).toMatchObject({ outcome: "refused", reason: "email_unverified" })
  })

  it("records which claim the address came from in a test run", async () => {
    const w = world({ connection: entra() })
    const a = oidc({ preferred_username: "ada@acme.test" }, entra())
    await w.complete(a, "test_run")
    const run = w.store.testRuns.at(-1) as { claims: Record<string, unknown> }
    expect(run.claims.emailSource).toBe("upn")
    const plain = world()
    await plain.complete({}, "test_run")
    expect(
      (plain.store.testRuns.at(-1) as { claims: Record<string, unknown> }).claims
        .emailSource,
    ).toBe("email")
  })

  describe("on SAML", () => {
    const verified = (attributes: Record<string, string[]>): VerifiedAssertion => ({
      id: "_a1",
      issuer: "https://sts.windows.net/tid/",
      nameId: "entra-oid-ada",
      nameIdFormat: NAMEID.persistent,
      sessionIndex: "s1",
      issueInstant: new Date("2026-11-02T12:00:00Z"),
      authnInstant: new Date("2026-11-02T12:00:00Z"),
      authnContextClassRef: null,
      validUntil: new Date("2026-11-02T12:05:00Z"),
      attributes: Object.assign(Object.create(null), attributes),
      encrypted: false,
    })
    const saml = (attributes: Record<string, string[]>, conn: Partial<Connection>) =>
      toSamlAssertion(
        verified(attributes),
        { attributeMapping: {}, ...conn },
        { preset: SAML_PRESETS.entra, subjectAttribute: null, mfaContextClasses: [] },
      )!

    it("reads the name attribute only when Entra sent no email", () => {
      const a = saml({ [ENTRA_UPN_ATTRIBUTE]: ["ada@acme.test"] }, entra())
      expect(a).toMatchObject({
        email: "ada@acme.test",
        emailVerified: false,
        emailSource: "upn",
      })
      expect(
        saml({ [ENTRA_UPN_ATTRIBUTE]: ["ada@acme.test"] }, { provider: "entra" }).email,
      ).toBeNull()
      const real = saml(
        { email: ["real@acme.test"], [ENTRA_UPN_ATTRIBUTE]: ["upn@acme.test"] },
        entra(),
      )
      expect(real).toMatchObject({ email: "real@acme.test", emailVerified: true })
      expect(real.emailSource).toBeUndefined()
      expect(
        saml({ [ENTRA_UPN_ATTRIBUTE]: ["g_gmail.com#EXT#@acme.test"] }, entra()).email,
      ).toBeNull()
    })

    it("signs in on a proved domain and not on another", async () => {
      const ok = world({ connection: entra() })
      expect(
        (await ok.complete(saml({ [ENTRA_UPN_ATTRIBUTE]: ["ada@acme.test"] }, entra())))
          .outcome,
      ).toBe("signed_in")
      const off = world({ connection: entra() })
      expect(
        await off.complete(
          saml({ [ENTRA_UPN_ATTRIBUTE]: ["ada@tenant.onmicrosoft.com"] }, entra()),
        ),
      ).toMatchObject({ reason: "domain_not_verified" })
    })
  })
})
