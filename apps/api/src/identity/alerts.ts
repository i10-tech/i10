import { renderSsoBypassUsed, renderSsoCertificateExpiring } from "@repo/emails"
import type { AuthEmailSender } from "../auth-email/deliver.js"
import { formatWhen } from "../webhooks/health-notice.js"
import { may, type RoleStore } from "../console/roles.js"
import type { Logger } from "./ports.js"

/**
 * The two alert emails sso.md defers to #345: a bypass sign-in, and a SAML
 * certificate about to expire.
 *
 * ⚠ THROUGH OUR OWN SYSTEM SENDER, like every notice we send as ourselves
 * (console/member-mail.ts, webhooks/health-notice.ts): our coded sender and
 * tenant, never a `core.domains` row and never a new SES identity.
 *
 * ⚠ A FAILURE TO SEND IS LOGGED AND SWALLOWED. Both run beside a sign-in or a
 * nightly pass; neither may fail because an address was missing or mail was
 * down. The audit event is the notice of record.
 *
 * ⚠ OWNERS AND ADMINS FROM OUR TABLE (#335), ADDRESSES FROM CLERK. The set is
 * everybody who may manage SSO (`sso:manage`: owners and admins today), so the
 * day the IT-admin role is added it is told too without a change here.
 */

export interface IdentityMail {
  bypassUsed(input: {
    to: string
    workspace: string
    person: string
    at: Date
    idempotencyKey: string
  }): Promise<void>
  certificateExpiring(input: {
    to: string
    workspace: string
    connection: string
    days: number
    notAfter: Date
    idempotencyKey: string
  }): Promise<void>
}

export function identityMail({
  sender,
  consoleUrl,
}: {
  sender: AuthEmailSender
  consoleUrl: string
}): IdentityMail {
  const url = `${consoleUrl.replace(/\/$/, "")}/settings/sso`
  return {
    async bypassUsed(input) {
      const rendered = await renderSsoBypassUsed({
        workspace: input.workspace,
        person: input.person,
        when: formatWhen(input.at),
        url,
      })
      await sender.send({
        to: input.to,
        ...rendered,
        idempotencyKey: input.idempotencyKey,
      })
    },
    async certificateExpiring(input) {
      const rendered = await renderSsoCertificateExpiring({
        workspace: input.workspace,
        connection: input.connection,
        days: input.days,
        expires: input.notAfter.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }),
        url,
      })
      await sender.send({
        to: input.to,
        ...rendered,
        idempotencyKey: input.idempotencyKey,
      })
    },
  }
}

export interface AlertDeps {
  mail: IdentityMail
  roles: Pick<RoleStore, "list">
  workspaceOrg(tenantId: string): Promise<string | null>
  workspaceName(tenantId: string): Promise<string | null>
  connectionName(tenantId: string, connectionId: string): Promise<string | null>
  /** Clerk's sign-in addresses of these members. */
  addresses(orgId: string, userIds: string[]): Promise<string[]>
  /** A person's primary address, for naming them in the mail. */
  addressOf(userId: string): Promise<string | null>
  log: Logger
  now?: () => Date
}

export interface IdentityAlerts {
  /** `sso.bypass_used`: the other owners and admins hear of it. */
  bypassUsed(
    tenantId: string,
    input: { userId: string; sessionId: string },
  ): Promise<void>
  /** `sso.certificate.expiring`: owners and SSO admins hear of it. */
  certificateExpiring(
    tenantId: string,
    input: {
      connectionId: string
      fingerprint: string
      notAfter: Date
      days: number
    },
  ): Promise<void>
}

export function identityAlerts(d: AlertDeps): IdentityAlerts {
  /** Everybody who manages SSO, minus `except`, as addresses. */
  async function managers(tenantId: string, except?: string): Promise<string[]> {
    const ids = (await d.roles.list(tenantId))
      .filter((r) => may(r.role, "sso:manage") && r.userId !== except)
      .map((r) => r.userId)
    if (ids.length === 0) return []
    const orgId = await d.workspaceOrg(tenantId)
    return orgId ? d.addresses(orgId, ids) : []
  }

  return {
    async bypassUsed(tenantId, input) {
      try {
        const to = await managers(tenantId, input.userId)
        if (to.length === 0) return
        const [workspace, person] = await Promise.all([
          d.workspaceName(tenantId),
          d.addressOf(input.userId),
        ])
        const at = (d.now ?? (() => new Date()))()
        // ⚠ ONE SEND PER RECIPIENT, EACH WITH ITS OWN KEY, so a retry after a
        // partial failure only sends what is missing; the session id makes the
        // key per bypass session, which is the "once" the rule asks for.
        for (const address of to) {
          await d.mail
            .bypassUsed({
              to: address,
              workspace: workspace ?? "your workspace",
              person: person ?? "A member",
              at,
              idempotencyKey: `sso-bypass:${tenantId}:${input.sessionId}:${address.toLowerCase()}`,
            })
            .catch((err: unknown) =>
              d.log.error({ err: String(err), tenantId }, "bypass alert email failed"),
            )
        }
      } catch (err) {
        d.log.error({ err: String(err), tenantId }, "could not send the bypass alert")
      }
    },

    async certificateExpiring(tenantId, input) {
      try {
        const to = await managers(tenantId)
        if (to.length === 0) return
        const [workspace, connection] = await Promise.all([
          d.workspaceName(tenantId),
          d.connectionName(tenantId, input.connectionId),
        ])
        for (const address of to) {
          await d.mail
            .certificateExpiring({
              to: address,
              workspace: workspace ?? "your workspace",
              connection: connection ?? "your SSO connection",
              days: input.days,
              notAfter: input.notAfter,
              idempotencyKey: `sso-cert:${tenantId}:${input.fingerprint}:${input.days}:${address.toLowerCase()}`,
            })
            .catch((err: unknown) =>
              d.log.error(
                { err: String(err), tenantId },
                "certificate expiry email failed",
              ),
            )
        }
      } catch (err) {
        d.log.error(
          { err: String(err), tenantId },
          "could not send the certificate expiry alert",
        )
      }
    },
  }
}
