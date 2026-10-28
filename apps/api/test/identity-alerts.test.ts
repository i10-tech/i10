import { describe, expect, it } from "bun:test"
import { renderSsoBypassUsed, renderSsoCertificateExpiring } from "@repo/emails"
import { identityAlerts, type IdentityMail } from "../src/identity/alerts.js"
import { enforcementGate } from "../src/identity/enforcement.js"
import type { Role, RoleRow } from "../src/console/roles.js"
import type { EnforcementRead } from "../src/identity/ports.js"
import { CONNECTION, ORG, TENANT, log, memoryClerk, user } from "./identity-fakes.js"
import { memoryPolicy } from "./identity-policy-fakes.js"

/**
 * The two alert emails sso.md defers to #345: a bypass sign-in goes to the
 * workspace's OTHER managers once per session, and a certificate expiring goes
 * to everybody who manages SSO at each threshold. Neither can fail its flow.
 */

const roleRow = (userId: string, role: Role): RoleRow => ({
  userId,
  role,
  membershipId: null,
  source: "changed",
  grantedBy: null,
})

const ADDRESSES: Record<string, string> = {
  user_owner: "owner@acme.test",
  user_owner2: "owner2@acme.test",
  user_admin: "admin@acme.test",
  user_m: "member@acme.test",
}

function world(over: { sendFails?: boolean; org?: string | null } = {}) {
  const sent: Array<{ kind: string; to: string; key: string; person?: string }> = []
  const errors: string[] = []
  const mail: IdentityMail = {
    async bypassUsed(i) {
      if (over.sendFails) throw new Error("ses down")
      sent.push({ kind: "bypass", to: i.to, key: i.idempotencyKey, person: i.person })
    },
    async certificateExpiring(i) {
      if (over.sendFails) throw new Error("ses down")
      sent.push({ kind: "cert", to: i.to, key: i.idempotencyKey })
    },
  }
  const alerts = identityAlerts({
    mail,
    roles: {
      list: async () => [
        roleRow("user_owner", "owner"),
        roleRow("user_owner2", "owner"),
        roleRow("user_admin", "admin"),
        roleRow("user_m", "member"),
      ],
    },
    workspaceOrg: async () => (over.org === undefined ? ORG : over.org),
    workspaceName: async () => "Acme",
    connectionName: async () => "Acme Okta",
    addresses: async (_org, ids) => ids.map((id) => ADDRESSES[id]!).filter(Boolean),
    addressOf: async (id) => ADDRESSES[id] ?? null,
    log: { ...log, error: (_o, m) => void errors.push(m) },
  })
  return { alerts, sent, errors }
}

describe("the bypass alert", () => {
  it("goes to the other owners and admins, never the person who bypassed", async () => {
    const w = world()
    await w.alerts.bypassUsed(TENANT, { userId: "user_owner", sessionId: "sess_1" })
    expect(w.sent.map((s) => s.to).sort()).toEqual([
      "admin@acme.test",
      "owner2@acme.test",
    ])
    expect(w.sent.every((s) => s.person === "owner@acme.test")).toBe(true)
  })

  it("never reaches a plain member", async () => {
    const w = world()
    await w.alerts.bypassUsed(TENANT, { userId: "user_admin", sessionId: "sess_1" })
    expect(w.sent.map((s) => s.to)).not.toContain("member@acme.test")
  })

  it("is keyed by session and recipient, so a retry sends only what is missing", async () => {
    const w = world()
    await w.alerts.bypassUsed(TENANT, { userId: "user_owner", sessionId: "sess_9" })
    expect(w.sent.map((s) => s.key).sort()).toEqual([
      `sso-bypass:${TENANT}:sess_9:admin@acme.test`,
      `sso-bypass:${TENANT}:sess_9:owner2@acme.test`,
    ])
  })

  it("logs and swallows a send failure", async () => {
    const w = world({ sendFails: true })
    await w.alerts.bypassUsed(TENANT, { userId: "user_owner", sessionId: "sess_1" })
    expect(w.errors).toContain("bypass alert email failed")
  })

  it("does nothing for a workspace Clerk has no organisation for", async () => {
    const w = world({ org: null })
    await w.alerts.bypassUsed(TENANT, { userId: "user_owner", sessionId: "sess_1" })
    expect(w.sent).toEqual([])
  })
})

describe("the certificate alert", () => {
  const cert = {
    connectionId: CONNECTION,
    fingerprint: "ab".repeat(32),
    notAfter: new Date("2026-11-04T00:00:00Z"),
  }

  it("goes to every owner and admin, once per threshold and recipient", async () => {
    const w = world()
    await w.alerts.certificateExpiring(TENANT, { ...cert, days: 7 })
    expect(w.sent.map((s) => s.to).sort()).toEqual([
      "admin@acme.test",
      "owner2@acme.test",
      "owner@acme.test",
    ])
    expect(new Set(w.sent.map((s) => s.key)).size).toBe(3)
    await w.alerts.certificateExpiring(TENANT, { ...cert, days: 1 })
    expect(new Set(w.sent.map((s) => s.key)).size).toBe(6)
  })

  it("logs and swallows a send failure", async () => {
    const w = world({ sendFails: true })
    await w.alerts.certificateExpiring(TENANT, { ...cert, days: 0 })
    expect(w.errors).toContain("certificate expiry email failed")
  })
})

describe("the bypass alert, from the enforcement gate", () => {
  const read: EnforcementRead = {
    required: true,
    connections: [
      {
        id: CONNECTION,
        enforcement: "required_domain",
        createdAt: new Date("2026-10-01T00:00:00Z"),
        domains: ["acme.test"],
        bypassed: true,
      },
    ],
    exemption: true,
    privileged: false,
    managed: false,
    session: null,
  }

  it("fires once per bypass session, and a failing alert does not fail the request", async () => {
    const policy = memoryPolicy({ reads: { [TENANT]: read } })
    const told: string[] = []
    const gate = enforcementGate({
      store: policy.store,
      clerk: memoryClerk({ users: [user()] }).clerk,
      log,
      onBypass: async (i) => {
        told.push(i.sessionId)
        throw new Error("mail down")
      },
    })
    for (let i = 0; i < 4; i++)
      expect(await gate.check(TENANT, "user_ada", "sess_1")).toEqual({ status: "pass" })
    await gate.check(TENANT, "user_ada", "sess_2")
    expect(told).toEqual(["sess_1", "sess_2"])
  })
})

describe("the copy", () => {
  it("is plain, sentence case, and has no em dash", async () => {
    const mails = [
      await renderSsoBypassUsed({
        workspace: "Acme",
        person: "ada@acme.test",
        when: "6 October 2026, 10:40 UTC",
        url: "https://console.i10.tech/settings/sso",
      }),
      ...(await Promise.all(
        [30, 7, 1, 0].map((days) =>
          renderSsoCertificateExpiring({
            workspace: "Acme",
            connection: "Acme Okta",
            days,
            expires: "13 October 2026",
            url: "https://console.i10.tech/settings/sso",
          }),
        ),
      )),
    ]
    for (const m of mails) {
      for (const part of [m.subject, m.html, m.text ?? ""])
        expect(part).not.toContain(String.fromCodePoint(0x2014))
      expect(m.subject).toMatch(/^[A-Z][a-z]/)
    }
    expect(mails[0]!.subject).toBe("Someone skipped SSO to sign in to Acme")
    expect(mails[1]!.subject).toBe(
      "The SSO certificate for Acme Okta expires in 30 days",
    )
    expect(mails[3]!.subject).toBe("The SSO certificate for Acme Okta expires in 1 day")
    expect(mails[4]!.subject).toBe("The SSO certificate for Acme Okta has expired")
  })
})
