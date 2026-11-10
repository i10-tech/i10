import type { CreateMailbox, Mailbox } from "@repo/contracts"
import type { ClerkUser } from "../projection/clerk-user.js"
import type { StorageAllocations } from "./allocation.js"

/**
 * Giving a person a mailbox.
 *
 * ⚠ THE MAILBOX IS NOT CREATED HERE SO MUCH AS *EARNED*. Nothing in this module
 * writes `authd.accounts` directly. It establishes that the person may have a
 * mailbox, adds the address to their Clerk user, and then lets the existing
 * projection derive the row exactly as it does for a webhook. One writer, one
 * derivation - a second INSERT path would be free to disagree with the
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
   * `null` means Clerk has no such user - which, for a caller we authenticated
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
   * attach `me@microsoft.com` to their Clerk user as a verified address - the
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
   * projection must never write `active` - a Clerk profile edit says nothing
   * about whether an invoice cleared, and putting it in that upsert would
   * switch every suspended mailbox back on the next time its owner changed
   * their name. Provisioning may write it because it just checked the
   * entitlement that `active` represents.
   *
   * When `displayName` is given, it is stored on the account row in the same
   * write so authd serves it as the mailbox's display name (#407).
   */
  activate(userId: string, displayName?: string): Promise<Mailbox | null>
}

/**
 * ⚠ THE SLICE OF THE METER THIS NEEDS, AND NOTHING MORE - the same narrowing,
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

/**
 * Whether a person's account is managed by an SSO connection and whether that
 * connection has a working mail sign-in lane on (#407).
 *
 *   - `unmanaged`: not in `authd.managed_accounts`; authd checks their Clerk password.
 *   - `off`: in `authd.managed_accounts`, and the connection is missing, inactive,
 *     has no live domain proof, or has neither OIDC mail nor complete LDAP
 *     pass-through enabled. authd refuses their mail bind.
 *   - `oidc` | `ldap`: in `authd.managed_accounts`, and the connection's mail
 *     lane is live; authd verifies their mail password against the IdP.
 */
export type ManagedMailLane = "unmanaged" | "off" | "oidc" | "ldap"

export type ManagedMailLaneCheck = (userId: string) => Promise<ManagedMailLane>

export interface ProvisionDeps {
  identity: MailboxIdentity
  directory: MailboxDirectory
  capacity: Capacity
  project: Projector
  /** `mailboxes`. Passed in so the core owes nothing to the metering package. */
  featureId: string
  now?: () => Date
  /**
   * Whether the caller is a managed SSO account and whether their connection's
   * mail sign-in lane is on (#407). Defaults to `"unmanaged"` when omitted.
   */
  mailLane?: ManagedMailLaneCheck
  /**
   * Allocation and the pool (B3). Without it a mailbox is created as before and
   * a request for storage is refused, since saving one with nothing to check it
   * against is how a pool is overfilled.
   */
  storage?: StorageAllocations
  /**
   * Whether this person is an owner or admin of the workspace that owns the
   * mailbox's domain - the only people who may size an inbox.
   *
   * ⚠ ASKED ABOUT THE TENANT, NOT TAKEN FROM THE REQUEST. This route has no
   * organization in its session, so the answer comes from the workspace the
   * DOMAIN belongs to, which is the one whose pool the mailbox would draw on.
   */
  canAllocate?: (userId: string, tenantId: string) => Promise<boolean>
}

export type ProvisionOutcome =
  | { status: "created"; mailbox: Mailbox }
  /** They signed up passwordless and are not managed by SSO. See `create`. */
  | { status: "password_required"; reason: string }
  /** Their account is managed by SSO, and the connection's mail sign-in lane is off. */
  | { status: "mail_signin_off"; reason: string }
  /** The address cannot be a mailbox here - wrong domain, or not ours. */
  | { status: "rejected"; reason: string }
  /** Taken, or they already have one. */
  | { status: "conflict"; reason: string }
  | { status: "limit"; reason: string }
  /** They asked to size the inbox and are not an owner or admin of the workspace. */
  | { status: "forbidden"; reason: string }

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
     * ⚠ THE SIGN-IN CHECK COMES FIRST, BEFORE THE DOMAIN AND BEFORE THE
     * ADDRESS. Not for tidiness: a user who cannot sign in to mail cannot hold
     * a mailbox at all, so every later check is a question about an address they
     * were never going to get. Answering "that address is taken" first would
     * tell somebody who cannot provision anything which addresses exist.
     *
     * ⚠ AND THE RULE MATCHES authd'S BIND PATH (#407). An IMAP or SMTP login is
     * an LDAP bind: for an unmanaged account authd delegates the password to
     * Clerk (`passwordEnabled`), and for a managed SSO account (`authd.managed_accounts`)
     * authd never asks Clerk - it checks the company IdP through the connection's
     * OIDC mail lane or LDAP pass-through. A managed account whose connection has
     * no working mail lane on cannot sign in even if a Clerk password existed, and
     * one whose lane IS on needs no Clerk password.
     */
    async create(userId, input) {
      const person = await deps.identity.get(userId)
      if (!person) {
        return { status: "rejected", reason: "No such user." }
      }

      const lane = await (deps.mailLane?.(userId) ?? "unmanaged")
      if (lane === "off") {
        return {
          status: "mail_signin_off",
          reason:
            "Your account signs in with single sign-on, and mail sign-in is not " +
            "turned on for your connection yet. Ask your admin to turn on mail " +
            'sign-in on the SSO connection page (Settings, Single sign-on, the connection, "Mail sign-in").',
        }
      }
      if (lane === "unmanaged" && !person.passwordEnabled) {
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
      // mailbox on acme.com consumes acme's seats, whoever holds it - the same
      // derivation the projection uses for `accounts.tenant_id`, and the only
      // one that cannot disagree with how the seat is later counted.
      const capacity = await deps.capacity.check({
        tenantId,
        featureId: deps.featureId,
        requested: 1,
        at: now(),
      })

      // ⚠ ONLY `exceeded` REFUSES, WHICH IS THE SAME READING domains/store.ts
      // TAKES. `overage` means the plan allows it and it is billable - turning
      // that into a refusal would silently make every metered plan a hard cap
      // and sell nobody the seat they were willing to pay for.
      if (capacity.status === "exceeded") {
        return {
          status: "limit",
          reason: "You have used every mailbox your plan includes.",
        }
      }

      // ⚠ STORAGE IS CHECKED BEFORE ANYTHING REACHES CLERK, because an address
      // added there cannot be taken back by refusing here. Sizing an inbox is an
      // owner or admin's act, so a member who sends `storage_allocation` is
      // refused rather than ignored. On a prepaid plan the allocation is
      // required: the pool is the sum of every inbox's share, so an inbox with
      // none would sit outside it. This read is the fast refusal; the write
      // below re-checks under a lock, which is the real one.
      const requested = input.storage_allocation
      if (!deps.storage) {
        if (requested !== undefined) {
          return {
            status: "rejected",
            reason: "Storage allocation is not configured on this deployment.",
          }
        }
      } else {
        if (requested !== undefined && !(await deps.canAllocate?.(userId, tenantId))) {
          return {
            status: "forbidden",
            reason: "Only an owner or admin of the workspace can allocate storage.",
          }
        }

        const model = await deps.storage.model(tenantId)
        if (model.kind === "pool") {
          if (requested === undefined) {
            return {
              status: "rejected",
              reason:
                "Your plan's storage is a pool an owner or admin splits across " +
                "inboxes. Ask one to set up this mailbox with a storage allocation.",
            }
          }
          const { pool } = await deps.storage.overview(tenantId)
          if (requested > (pool.remaining ?? 0)) {
            return {
              status: "limit",
              reason: "That is more storage than is left in your pool.",
            }
          }
        }
      }

      await deps.identity.addVerifiedAddress({ userId, address })

      // ⚠ RE-READ RATHER THAN PATCHED LOCALLY. The projection derives the
      // mailbox from the WHOLE user - which address is primary, what the other
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

      const displayName = input.display_name?.trim() || undefined

      // ⚠ WITH AN ALLOCATION, ACTIVATING AND ALLOCATING ARE ONE WRITE under the
      // pool lock, so the inbox is never live outside the pool and two creations
      // cannot both take the last of it. Without one there is nothing to
      // allocate: on pay as you go the inbox carries the default quota, and the
      // reconcile gives it that.
      if (requested !== undefined) {
        const saved = await deps.storage!.allocate({
          tenantId,
          address,
          bytes: requested,
          activate: true,
          ...(displayName !== undefined ? { displayName } : {}),
        })
        if (saved.status === "over_pool") {
          return {
            status: "limit",
            reason: "That is more storage than is left in your pool.",
          }
        }
        if (saved.status !== "ok") {
          return {
            status: "rejected",
            reason: "The mailbox could not be created. Try again.",
          }
        }
      }

      const mailbox =
        requested !== undefined
          ? await deps.directory.current(userId)
          : await deps.directory.activate(userId, displayName)
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

export type DirectoryMailboxOutcome =
  | { status: "created" | "exists"; address: string }
  /** No Clerk user, or no verified primary address: nothing to give a mailbox to. */
  | { status: "gone" }
  /** The primary address is not on a domain THIS workspace hosts mail for. */
  | { status: "domain_not_hosted" }
  /** Another account or alias already holds the address. */
  | { status: "address_taken" }
  | { status: "limit" }

/**
 * A mailbox for a person a company's directory activated (#344, sso.md 2.8).
 *
 * ⚠ THE SAME TWO STEPS AS `create`, NOT A THIRD PATH. The projection derives
 * the row from the Clerk user and `directory.activate` flips the gate; nothing
 * here writes `authd.accounts` itself. What differs is who is asking: a
 * directory, for a person who may never have signed in, whose account has no
 * password and whose address is already a verified, primary Clerk address (the
 * apply job put it there). So there is no password check and no "add the
 * address" step, and the workspace the directory belongs to must OWN the
 * domain: a directory can never give anyone a mailbox on somebody else's, or
 * on i10's own.
 *
 * ⚠ IDEMPOTENT. A person who already has this mailbox is `exists` and nothing
 * is written - the apply job runs this again on every push.
 */
export async function provisionForDirectory(
  deps: ProvisionDeps,
  input: { tenantId: string; userId: string },
): Promise<DirectoryMailboxOutcome> {
  const person = await deps.identity.get(input.userId)
  if (!person) return { status: "gone" }
  const primary = (person.user.email_addresses ?? []).find(
    (e) =>
      e.id === person.user.primary_email_address_id &&
      e.verification?.status === "verified",
  )
  if (!primary) return { status: "gone" }
  const address = primary.email_address.trim().toLowerCase()

  if ((await deps.directory.domainOwner(domainOf(address))) !== input.tenantId)
    return { status: "domain_not_hosted" }

  const existing = await deps.directory.current(input.userId)
  if (existing?.active && existing.address === address)
    return { status: "exists", address }
  if (existing?.address !== address) {
    if (await deps.directory.addressTaken(address)) return { status: "address_taken" }
    const capacity = await deps.capacity.check({
      tenantId: input.tenantId,
      featureId: deps.featureId,
      // A row on another domain may be another workspace's seat: count it here.
      requested: existing && domainOf(existing.address) === domainOf(address) ? 0 : 1,
      at: (deps.now ?? (() => new Date()))(),
    })
    if (capacity.status === "exceeded") return { status: "limit" }
  }

  const projected = await deps.project(person.user)
  if (projected.email !== address) return { status: "domain_not_hosted" }
  const mailbox = await deps.directory.activate(input.userId)
  if (!mailbox) return { status: "gone" }
  return { status: "created", address }
}
