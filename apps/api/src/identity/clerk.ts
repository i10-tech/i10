import type { ClerkClient } from "@clerk/backend"
import { notFound } from "../mailboxes/clerk.js"
import { TICKET_SECONDS } from "./model.js"
import type { ClerkIdentity, ClerkUserSnapshot } from "./ports.js"

/**
 * `ClerkIdentity` on Clerk's backend API: the SDK where it covers the call,
 * a raw request where it does not.
 */

const codesOf = (error: unknown): string[] =>
  ((error as { errors?: { code?: unknown }[] } | null)?.errors ?? [])
    .map((e) => e.code)
    .filter((c): c is string => typeof c === "string")

function snapshot(user: {
  id: string
  banned: boolean
  firstName: string | null
  lastName: string | null
  primaryEmailAddressId: string | null
  emailAddresses: {
    id: string
    emailAddress: string
    verification: { status: string } | null
  }[]
  passwordEnabled: boolean
  twoFactorEnabled: boolean
  totpEnabled: boolean
  backupCodeEnabled: boolean
  externalAccounts: { id: string }[]
  phoneNumbers: { id: string }[]
  web3Wallets: { id: string }[]
  deleteSelfEnabled: boolean
  raw: unknown
}): ClerkUserSnapshot {
  return {
    id: user.id,
    banned: user.banned,
    firstName: user.firstName,
    lastName: user.lastName,
    primaryEmailId: user.primaryEmailAddressId,
    emails: user.emailAddresses.map((e) => ({
      id: e.id,
      address: e.emailAddress.toLowerCase(),
      verified: e.verification?.status === "verified",
    })),
    passwordEnabled: user.passwordEnabled,
    twoFactorEnabled: user.twoFactorEnabled,
    totpEnabled: user.totpEnabled,
    backupCodeEnabled: user.backupCodeEnabled,
    externalAccountIds: user.externalAccounts.map((a) => a.id),
    phoneIds: user.phoneNumbers.map((p) => p.id),
    web3WalletIds: user.web3Wallets.map((w) => w.id),
    // ⚠ FROM THE RAW JSON: the SDK's `User` drops `passkeys` (see devices/resume.ts).
    passkeyIds: ((user.raw as { passkeys?: { id?: unknown }[] } | null)?.passkeys ?? [])
      .map((p) => p.id)
      .filter((id): id is string => typeof id === "string"),
    deleteSelfEnabled: user.deleteSelfEnabled,
  }
}

/** Already gone is done: Clerk's 404 on a delete or revoke. */
async function gone(call: () => Promise<unknown>): Promise<void> {
  try {
    await call()
  } catch (error) {
    if (!notFound(error)) throw error
  }
}

export function clerkIdentityApi(
  clerk: ClerkClient,
  options: {
    secretKey: string
    /** Clerk's backend API, `https://api.clerk.com`. */
    apiUrl?: string
    fetch?: typeof fetch
  },
): ClerkIdentity {
  const apiUrl = (options.apiUrl ?? "https://api.clerk.com").replace(/\/$/, "")
  const call = options.fetch ?? fetch

  return {
    /*
     * ⚠ A RAW CALL, BECAUSE THE SDK CANNOT SAY IT. `second_factor_verification`
     * has been in Clerk's spec since `2025-11-10` and is in neither SDK
     * version's types (sso.md 1.1). Without it a person with Clerk 2FA stops at
     * `needs_second_factor` after their IdP already did MFA; with `fresh` the
     * sign-in completes and the session reads `fva [0,0]` (P1).
     */
    async mintSignInToken({ userId, orgId }) {
      const response = await call(`${apiUrl}/v1/sign_in_tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: userId,
          org_id: orgId,
          expires_in_seconds: TICKET_SECONDS,
          second_factor_verification: "fresh",
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = (await response.json().catch(() => null)) as {
        id?: unknown
        token?: unknown
      } | null
      if (
        !response.ok ||
        typeof body?.id !== "string" ||
        typeof body.token !== "string"
      )
        throw new Error(`clerk refused a sign-in token: ${response.status}`)
      return { id: body.id, token: body.token }
    },

    async revokeSignInToken(id) {
      try {
        await clerk.signInTokens.revokeSignInToken(id)
        return "revoked"
      } catch (error) {
        if (codesOf(error).includes("sign_in_token_cannot_be_revoked_code"))
          return "not_revocable"
        throw error
      }
    },

    async session(sessionId) {
      try {
        const s = await clerk.sessions.getSession(sessionId)
        return {
          id: s.id,
          userId: s.userId,
          clientId: s.clientId,
          status: s.status,
          createdAt: new Date(s.createdAt),
        }
      } catch (error) {
        if (notFound(error)) return null
        throw error
      }
    },

    async lastStrategy(clientId) {
      try {
        return (
          (await clerk.clients.getClient(clientId)).lastAuthenticationStrategy ?? null
        )
      } catch (error) {
        if (notFound(error)) return null
        throw error
      }
    },

    async revokeSession(sessionId) {
      try {
        await clerk.sessions.revokeSession(sessionId)
      } catch (error) {
        // Gone is done. Anything else throws: a revoke we cannot confirm is
        // not a revoke. (Revoking an already revoked session answers 200 with
        // `status: "revoked"`, probed on dev 2026-10-20, so it needs no case.)
        if (notFound(error)) return
        throw error
      }
    },

    /*
     * ⚠ EVERY PAGE. A claim revokes all of these, and a person with more than
     * one page of sessions must not keep the ones past the first.
     */
    async activeSessions(userId) {
      const out: { id: string; createdAt: Date }[] = []
      for (let offset = 0; ; offset += 100) {
        const { data } = await clerk.sessions.getSessionList({
          userId,
          status: "active",
          limit: 100,
          offset,
        })
        for (const s of data) out.push({ id: s.id, createdAt: new Date(s.createdAt) })
        if (data.length < 100) return out
      }
    },

    async user(userId) {
      try {
        return snapshot(await clerk.users.getUser(userId))
      } catch (error) {
        if (notFound(error)) return null
        throw error
      }
    },

    async usersByEmail(email) {
      const { data } = await clerk.users.getUserList({
        emailAddress: [email],
        limit: 10,
      })
      return data.map(snapshot)
    },

    /*
     * ⚠ NO PASSWORD, ONE VERIFIED ADDRESS, AND CLERK'S UNIQUENESS AS THE NET.
     * `skip_password_requirement` makes an account whose only way in is the
     * bridge's ticket; the address is created verified (Clerk's default for a
     * backend-created address), which is what the IdP vouched for. Two
     * creations for one address: Clerk lets one through and answers the other
     * `form_identifier_exists`, which the bridge turns into a re-resolve.
     */
    async createUser({ email, firstName, lastName }) {
      try {
        const made = await clerk.users.createUser({
          emailAddress: [email],
          skipPasswordRequirement: true,
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
        })
        return { outcome: "created", userId: made.id }
      } catch (error) {
        const codes = codesOf(error)
        if (codes.includes("form_identifier_exists")) return { outcome: "exists" }
        // ⚠ THE INSTANCE REQUIRES FIRST AND LAST NAME: an IdP that sends none
        // is the admin's mapping to fix, not an outage to retry (a 503).
        if (codes.includes("form_data_missing")) return { outcome: "incomplete" }
        throw error
      }
    },
    async updateProfile(userId, names) {
      await clerk.users.updateUser(userId, names)
    },
    async removePassword(userId) {
      await clerk.users.removePassword(userId, { signOutOfOtherSessions: true })
    },
    async deleteExternalAccount(userId, id) {
      await gone(() =>
        clerk.users.deleteUserExternalAccount({ userId, externalAccountId: id }),
      )
    },
    async deletePasskey(userId, id) {
      await gone(() =>
        clerk.users.deleteUserPasskey({ userId, passkeyIdentificationId: id }),
      )
    },
    async deletePhoneNumber(id) {
      await gone(() => clerk.phoneNumbers.deletePhoneNumber(id))
    },
    async deleteWeb3Wallet(userId, id) {
      await gone(() =>
        clerk.users.deleteUserWeb3Wallet({ userId, web3WalletIdentificationId: id }),
      )
    },
    async disableMfa(userId) {
      await gone(() => clerk.users.disableUserMFA(userId))
    },
    async deleteBackupCodes(userId) {
      await gone(() => clerk.users.deleteUserBackupCodes(userId))
    },
    async deleteEmailAddress(id) {
      await gone(() => clerk.emailAddresses.deleteEmailAddress(id))
    },
    async forbidSelfDelete(userId) {
      await clerk.users.updateUser(userId, { deleteSelfEnabled: false })
    },
    async ban(userId) {
      await clerk.users.banUser(userId)
    },
  }
}
