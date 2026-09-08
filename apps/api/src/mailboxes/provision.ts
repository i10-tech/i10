import type { CreateMailbox, Mailbox } from "@repo/contracts"
import type { ClerkUser } from "../projection/clerk-user.js"

/**
 * Giving a person a mailbox.
 *
 * ⚠ THE MAILBOX IS NOT CREATED HERE SO MUCH AS *EARNED*. Nothing in this module
 * writes `authd.accounts` directly. It establishes that the person may have a
 * mailbox, adds the address to their Clerk user, and then lets the existing
 * projection derive the row exactly as it does for a webhook. One writer, one
 * derivation — a second INSERT path would be free to disagree with the
 * projection about aliases, display names or the owning tenant, and the
 * disagreement would surface as mail being accepted for the wrong person.
 *
 * ⚠ AND A MAILBOX ONLY EVER BELONGS TO SOMEBODY WHO ALREADY SIGNED UP. There is
 * no "create the user too" branch. Signing up is Clerk's flow, with Clerk's
 * verification and Clerk's password rules; a second way in would be a second
 * account lifecycle to keep correct, and it is the one place where getting it
 * wrong hands somebody else's mail to a stranger.
 */

/** Clerk, narrowed to the two questions provisioning asks of it. */
export interface MailboxIdentity {
  /**
   * The user as Clerk has them now, in the shape the projection reads, plus
   * whether they hold a password.
   *
   * `null` means Clerk has no such user — which, for a caller we authenticated
   * from a Clerk session, means the account was deleted mid-request.
   */
  get(userId: string): Promise<{ user: ClerkUser; passwordEnabled: boolean } | null>

  /**
   * Attaches the address to the user, already verified.
   *
   * ⚠ VERIFIED WITHOUT A CHALLENGE, AND THAT IS SOUND ONLY BECAUSE WE ARE THE
   * ONES WHO WILL SERVE IT. The usual reason to verify an address is to prove
   * the person can read mail sent to it; here the address does not exist until
   * we create it, on a domain we host, and reading it is precisely the thing we
   * are about to grant. Sending a confirmation code to a mailbox that cannot
   * receive mail yet is a loop with no exit.
   */
  addVerifiedAddress(input: { userId: string; address: string }): Promise<void>
}

/** The projection's row, and the two facts only the database knows. */
export interface MailboxDirectory {
  /**
   * The tenant owning a VERIFIED, mailbox-hosting domain, or `null`.
   *
   * ⚠ THE SAME QUESTION `core.mailbox_domains()` ANSWERS FOR THE PROJECTION,
   * asked before we change anything in Clerk. Skipping it would let somebody
   * attach `me@microsoft.com` to their Clerk user as a verified address — the
   * projection would correctly refuse to make a row, but we would have written
   * a verified claim to a domain they do not own into an identity provider,
   * where it outlives the request and may be trusted by something else.
   */
  domainOwner(domain: string): Promise<string | null>

  /** Any account or alias already holding this address. */
  addressTaken(address: string): Promise<boolean>

  /** The mailbox this user already has, if any. */
  current(userId: string): Promise<Mailbox | null>

  /**
   * Flips the subscription gate on and reads the row back.
   *
   * ⚠ A SEPARATE STATEMENT FROM THE PROJECTION'S UPSERT, ON PURPOSE. The
   * projection must never write `active` — a Clerk profile edit says nothing
   * about whether an invoice cleared, and putting it in that upsert would
   * switch every suspended mailbox back on the next time its owner changed
   * their name. Provisioning may write it because it just checked the
   * entitlement that `active` represents.
   */
  activate(userId: string): Promise<Mailbox | null>
}

/**
 * ⚠ THE SLICE OF THE METER THIS NEEDS, AND NOTHING MORE — the same narrowing,
 * for the same reason, as `Capacity` in domains/store.ts. Taking the whole
 * `Meter` would hand mailbox provisioning `record()`, which writes billable
 * usage; creating a mailbox is not a metered event, it is a level that is
 * counted by asking the table.
 */
export interface Capacity {
  check(input: {
    tenantId: string
    featureId: string
    requested: number
    at: Date
  }): Promise<{ status: string }>
}

/** Writes the row from a Clerk user. `projectClerkUser`, injected. */
export type Projector = (user: ClerkUser) => Promise<{ email?: string }>

export interface ProvisionDeps {
  identity: MailboxIdentity
  directory: MailboxDirectory
  capacity: Capacity
  project: Projector
  /** `mailboxes`. Passed in so the core owes nothing to the metering package. */
  featureId: string
  now?: () => Date
}

export type ProvisionOutcome =
  | { status: "created"; mailbox: Mailbox }
  /** They signed up passwordless. See `create`. */
  | { status: "password_required"; reason: string }
  /** The address cannot be a mailbox here — wrong domain, or not ours. */
  | { status: "rejected"; reason: string }
  /** Taken, or they already have one. */
  | { status: "conflict"; reason: string }
  | { status: "limit"; reason: string }

/** The domain half of an address, lowercased. */
const domainOf = (address: string) =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase()

export interface MailboxProvisioning {
  create(userId: string, input: CreateMailbox): Promise<ProvisionOutcome>
  /** The caller's own mailbox, or `null`. */
  current(userId: string): Promise<Mailbox | null>
}

export function mailboxProvisioning(deps: ProvisionDeps): MailboxProvisioning {
  const now = deps.now ?? (() => new Date())

  return {
    current(userId) {
      return deps.directory.current(userId)
    },

    /**
     * ⚠ THE PASSWORD CHECK COMES FIRST, BEFORE THE DOMAIN AND BEFORE THE
     * ADDRESS. Not for tidiness: a passwordless user cannot hold a mailbox at
     * all, so every later check is a question about an address they were never
     * going to get. Answering "that address is taken" first would tell somebody
     * who cannot provision anything which addresses exist.
     *
     * ⚠ AND THE REASON IT IS A HARD REFUSAL RATHER THAN A PROMPT IS authd. An
     * IMAP or SMTP login is an LDAP bind, and authd answers that bind by
     * delegating the password to Clerk — that is the whole design, and it is
     * why no password material is stored anywhere in our database. A user who
     * signed up with Google or a magic link has no password for Clerk to
     * verify, so a mailbox created for them would be one nobody could ever log
     * in to: it would accept mail and then refuse its owner. Setting a password
     * is not a formality here, it is the credential the mail server runs on.
     */
    async create(userId, input) {
      const person = await deps.identity.get(userId)
      if (!person) {
        return { status: "rejected", reason: "No such user." }
      }

      if (!person.passwordEnabled) {
        return {
          status: "password_required",
          reason:
            "Set a password on your account before creating a mailbox. Mail " +
            "clients sign in with it, and accounts without one cannot.",
        }
      }

      const address = input.address
      const tenantId = await deps.directory.domainOwner(domainOf(address))
      if (!tenantId) {
        return {
          status: "rejected",
          reason: `We do not host mailboxes on ${domainOf(address)}.`,
        }
      }

      // ⚠ BOTH HALVES OF "TAKEN", AND THE SECOND IS THE EASY ONE TO FORGET. An
      // address may be free as a mailbox and still be somebody's alias, in
      // which case mail for it is already being delivered to them.
      if (await deps.directory.addressTaken(address)) {
        return { status: "conflict", reason: "That address is already taken." }
      }

      // ⚠ ONE MAILBOX PER PERSON, WHICH IS A CONSEQUENCE OF THE PROJECTION
      // RATHER THAN A POLICY INVENTED HERE. `authd.accounts` is keyed by Clerk
      // user id and `projectUser` makes exactly one of a person's hosted
      // addresses the mailbox and the rest aliases. Accepting a second one
      // would silently create an alias while answering 201 for a mailbox.
      const existing = await deps.directory.current(userId)
      if (existing) {
        return {
          status: "conflict",
          reason: `You already have a mailbox at ${existing.address}.`,
        }
      }

      // ⚠ AGAINST THE TENANT THAT OWNS THE DOMAIN, NOT THE CALLER'S OWN. A
      // mailbox on acme.com consumes acme's seats, whoever holds it — the same
      // derivation the projection uses for `accounts.tenant_id`, and the only
      // one that cannot disagree with how the seat is later counted.
      const capacity = await deps.capacity.check({
        tenantId,
        featureId: deps.featureId,
        requested: 1,
        at: now(),
      })

      // ⚠ ONLY `exceeded` REFUSES, WHICH IS THE SAME READING domains/store.ts
      // TAKES. `overage` means the plan allows it and it is billable — turning
      // that into a refusal would silently make every metered plan a hard cap
      // and sell nobody the seat they were willing to pay for.
      if (capacity.status === "exceeded") {
        return {
          status: "limit",
          reason: "You have used every mailbox your plan includes.",
        }
      }

      await deps.identity.addVerifiedAddress({ userId, address })

      // ⚠ RE-READ RATHER THAN PATCHED LOCALLY. The projection derives the
      // mailbox from the WHOLE user — which address is primary, what the other
      // verified ones are, the `updated_at` that guards out-of-order webhooks.
      // Constructing that from the address we just sent would be a second,
      // drifting copy of Clerk's state.
      const fresh = await deps.identity.get(userId)
      if (!fresh) {
        return { status: "rejected", reason: "No such user." }
      }

      const projected = await deps.project(fresh.user)
      if (!projected.email) {
        // The address reached Clerk but the projection refused it. The domain
        // stopped hosting mailboxes between the two, or the write lost the
        // `clerk_updated_at` guard to a concurrent one.
        return {
          status: "rejected",
          reason: "The mailbox could not be created. Try again.",
        }
      }

      const mailbox = await deps.directory.activate(userId)
      if (!mailbox) {
        return {
          status: "rejected",
          reason: "The mailbox could not be created. Try again.",
        }
      }

      return { status: "created", mailbox }
    },
  }
}
