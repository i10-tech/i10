import type { ClerkClient, User } from "@clerk/backend"
import type { ClerkUser } from "../projection/clerk-user.js"
import type { MailboxIdentity } from "./provision.js"

/**
 * Clerk, adapted to what provisioning needs.
 *
 * ⚠ THIS FILE EXISTS TO TRANSLATE BETWEEN TWO SHAPES OF THE SAME USER. The SDK
 * returns a camelCase `User` resource; the projection reads the snake_case
 * payload Clerk puts on the WIRE in webhooks (`email_addresses`,
 * `primary_email_address_id`, `updated_at`). They describe one object and they
 * are not the same type. Teaching the projection to accept both would give the
 * rule that decides who receives mail two code paths and one test suite.
 */
export function clerkIdentity(clerk: ClerkClient): MailboxIdentity {
  return {
    async get(userId) {
      let user: User
      try {
        user = await clerk.users.getUser(userId)
      } catch (error) {
        // ⚠ ONLY 404 BECOMES `null`. Every other failure — a timeout, a 5xx, a
        // revoked secret key — must propagate, because "Clerk did not answer"
        // and "there is no such user" lead to opposite responses: a retry and
        // a refusal. Collapsing them is the same mistake as answering LDAP
        // `invalidCredentials` during a Clerk outage.
        if (notFound(error)) return null
        throw error
      }

      return { user: toWire(user), passwordEnabled: user.passwordEnabled }
    },

    async addVerifiedAddress({ userId, address }) {
      await clerk.emailAddresses.createEmailAddress({
        userId,
        emailAddress: address,
        verified: true,
        // ⚠ NOT PRIMARY, DELIBERATELY. The primary address is where Clerk sends
        // its own mail — password resets above all. Pointing that at a mailbox
        // the person has not set up in a client yet is how somebody locks
        // themselves out: the reset link is delivered to the thing they need
        // the reset in order to read. The projection does not need it either;
        // `projectUser` already picks the hosted address when the primary is
        // not one.
        primary: false,
      })
    },
  }
}

/**
 * The SDK resource, in the wire shape `projectUser` reads.
 *
 * ⚠ `verification.status` IS PASSED THROUGH RATHER THAN ASSUMED VERIFIED. The
 * projection drops unverified addresses on purpose, and it is the only thing
 * standing between a Gmail somebody merely typed and a row that makes Stalwart
 * accept mail for it.
 */
function toWire(user: User): ClerkUser {
  return {
    id: user.id,
    primary_email_address_id: user.primaryEmailAddressId,
    first_name: user.firstName,
    last_name: user.lastName,
    updated_at: user.updatedAt,
    email_addresses: user.emailAddresses.map((e) => ({
      id: e.id,
      email_address: e.emailAddress,
      verification: { status: e.verification?.status ?? null },
    })),
  }
}

/**
 * ⚠ DUCK-TYPED ON PURPOSE. `ClerkAPIResponseError` carries `status`, but
 * narrowing by class would couple this to an export the SDK is free to move
 * between majors — and the failure mode of getting it wrong is silent: an
 * instanceof that stops matching turns every deleted user into a 500. Reading
 * the field degrades safely, because anything unrecognised is rethrown.
 */
function notFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: number }).status === 404
  )
}
