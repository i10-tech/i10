import type { AuditEvent } from "./ports.js"
import type {
  GroupFilter,
  GroupRowView,
  StoredGroup,
  StoredUser,
  UserFilter,
  UserRowView,
} from "./scim.js"

/**
 * What SCIM directories need from our database (#342): `DirectoryStore`,
 * with its Postgres half in identity/scim-store.ts and a fake beside the
 * tests; and the Clerk calls provisioning makes that the identity core did
 * not (`ClerkProvisioning`, identity/clerk.ts).
 */

export const DIRECTORY_PROVIDERS = ["okta", "entra", "google", "generic"] as const
export type DirectoryProvider = (typeof DIRECTORY_PROVIDERS)[number]

/**
 * Why a person a directory sent is not (fully) in the workspace. Kept on
 * their row, shown on the directory's page (#340), audited when it changes.
 *
 *   workspace_full       accepted, and on the waiting list (sso.md 2.7)
 *   blocked              on the workspace's block list (#326): row kept, no account work
 *   banned               a Clerk ban that is not the directory's: the ban wins
 *   domain_not_verified  not on a domain the workspace holds a live proof for
 *   address_taken        Clerk holds the address on an account we may not claim
 *   ambiguous_account    more than one Clerk account holds it verified
 *   managed_elsewhere    another workspace manages that account
 *   role_exempt          an owner or admin: SCIM never takes one over (decision 7)
 *   already_linked       another person in this directory is linked to that account
 *   no_email             nothing to make an account with
 *   profile_incomplete   no given or family name, which Clerk requires: nothing made up
 *   last_owner           deactivated, but the workspace's last owner cannot go
 *   account_deleted      the Clerk account was deleted; not made again on our own
 */
export const DIRECTORY_CONFLICTS = [
  "workspace_full",
  "blocked",
  "banned",
  "domain_not_verified",
  "address_taken",
  "ambiguous_account",
  "managed_elsewhere",
  "role_exempt",
  "already_linked",
  "no_email",
  "profile_incomplete",
  "last_owner",
  "account_deleted",
  "no_sso_connection",
] as const
export type DirectoryConflict = (typeof DIRECTORY_CONFLICTS)[number]

export const GOOGLE_WATCH_EVENTS = ["add", "update", "delete", "undelete"] as const
export type GoogleWatchEvent = (typeof GOOGLE_WATCH_EVENTS)[number]

export type DirectorySyncStatus = "ok" | "failed"

export interface Directory {
  id: string
  tenantId: string
  name: string
  provider: DirectoryProvider
  enabled: boolean
  adminEmail: string | null
  domain: string | null
  lastSyncAt: Date | null
  lastSyncStatus: DirectorySyncStatus | null
  lastSyncError: string | null
  createdAt: Date
  updatedAt: Date
}

export interface WatchChannelRow {
  id: string
  tenantId: string
  directoryId: string
  event: GoogleWatchEvent
  resourceId: string
  tokenHash: string
  expiresAt: Date
  createdAt: Date
}

export interface DirectoryToken {
  id: string
  directoryId: string
  /** The token's first characters, never the token. */
  hint: string
  createdBy: string | null
  createdAt: Date
  expiresAt: Date | null
  revokedAt: Date | null
  lastUsedAt: Date | null
}

export interface DirectorySummary extends Directory {
  tokens: DirectoryToken[]
  users: number
  conflicts: number
  /** Outbox entries not applied yet. */
  pending: number
}

/** What a SCIM request's token resolves to, read with no workspace in scope. */
export interface TokenRow {
  id: string
  tenantId: string
  directoryId: string
  tokenHash: string
  expiresAt: Date | null
  revokedAt: Date | null
  lastUsedAt: Date | null
}

export interface DirectoryUserRow extends UserRowView {
  tenantId: string
  directoryId: string
  displayName: string | null
  givenName: string | null
  familyName: string | null
  email: string | null
  clerkUserId: string | null
  conflict: DirectoryConflict | null
  conflictDetail: Record<string, unknown> | null
  conflictAt: Date | null
  bannedByDirectory: boolean
  deletedAt: Date | null
}

export interface DirectoryGroupRow extends GroupRowView {
  tenantId: string
  directoryId: string
}

/** A group a person is in, as #341's rules will read it. */
export interface DirectoryGroupRef {
  id: string
  directoryId: string
  displayName: string
  externalId: string | null
}

export interface OutboxEntry {
  id: string
  directoryUserId: string
}

/** A write, the outbox entries it made in the same transaction, and the audit event. */
export interface Written<T> {
  row: T
  outbox: OutboxEntry[]
}

export interface Page<T> {
  total: number
  rows: T[]
}

export interface ListInput<F> {
  filter: F | null
  startIndex: number
  count: number
}

export interface DirectoryStore {
  // ── the console ──
  createDirectory(
    tenantId: string,
    input: {
      name: string
      provider: DirectoryProvider
      enabled?: boolean
      adminEmail?: string | null
      domain?: string | null
      createdBy: string
    },
  ): Promise<Directory>
  directories(tenantId: string): Promise<DirectorySummary[]>
  directory(tenantId: string, id: string): Promise<Directory | null>
  updateDirectory(
    tenantId: string,
    id: string,
    patch: {
      name?: string
      enabled?: boolean
      adminEmail?: string | null
      domain?: string | null
    },
  ): Promise<Directory | null>
  noteDirectorySync(
    tenantId: string,
    id: string,
    input: { status: DirectorySyncStatus; error: string | null; at: Date },
  ): Promise<void>
  /** Enabled Google directories across workspaces, keyset-paged by id. */
  dueGoogleDirectories(
    after: string | null,
    limit: number,
  ): Promise<{ id: string; tenantId: string }[]>
  watchChannels(tenantId: string, directoryId: string): Promise<WatchChannelRow[]>
  saveWatchChannel(
    tenantId: string,
    input: {
      id: string
      directoryId: string
      event: GoogleWatchEvent
      resourceId: string
      tokenHash: string
      expiresAt: Date
    },
  ): Promise<WatchChannelRow>
  deleteWatchChannels(
    tenantId: string,
    directoryId: string,
    ids?: readonly string[],
  ): Promise<WatchChannelRow[]>
  /** With no workspace in scope: the one watch channel this id names. */
  watchChannelById(id: string): Promise<WatchChannelRow | null>
  /**
   * A new token, and every older live one given `expires_at = now + overlap`
   * (revoked at once when the overlap is zero), in one transaction. Null when
   * there is no such directory.
   */
  issueToken(
    tenantId: string,
    directoryId: string,
    input: { tokenHash: string; hint: string; createdBy: string; overlapMs: number },
    now: Date,
  ): Promise<DirectoryToken | null>
  revokeToken(
    tenantId: string,
    directoryId: string,
    tokenId: string,
    at: Date,
  ): Promise<boolean>
  /** The people with a conflict, newest first. */
  conflicts(tenantId: string, directoryId: string): Promise<DirectoryUserRow[]>

  // ── a SCIM request's credentials ──
  /** With no workspace in scope: the one row this hash names. */
  tokenByHash(tokenHash: string): Promise<TokenRow | null>
  /** `last_used_at`, at most once a minute. */
  touchToken(tenantId: string, tokenId: string, at: Date): Promise<void>

  // ── Users ──
  listUsers(
    tenantId: string,
    directoryId: string,
    input: ListInput<UserFilter>,
  ): Promise<Page<DirectoryUserRow>>
  /** A live (not deleted) row of this directory. */
  user(
    tenantId: string,
    directoryId: string,
    id: string,
  ): Promise<DirectoryUserRow | null>
  /** `taken`: another live row of the directory has this userName. */
  createUser(
    tenantId: string,
    directoryId: string,
    input: StoredUser,
    audit: AuditEvent,
  ): Promise<Written<DirectoryUserRow> | "taken">
  /**
   * PUT and PATCH: `edit` gets the row as it is NOW, under a row lock, and
   * returns what to store. Null when there is no such live row.
   *
   * ⚠ A READ-MODIFY-WRITE UNDER ONE LOCK. An IdP that sends two PATCHes at
   * once must not have either applied to the other's stale copy.
   */
  editUser(
    tenantId: string,
    directoryId: string,
    id: string,
    edit: (current: DirectoryUserRow) => StoredUser,
    audit: (before: DirectoryUserRow, after: StoredUser) => AuditEvent,
  ): Promise<Written<DirectoryUserRow> | "taken" | null>
  /** Marks it deleted, takes it out of its groups, and writes the outbox entry. */
  deleteUser(
    tenantId: string,
    directoryId: string,
    id: string,
    audit: AuditEvent,
  ): Promise<Written<{ id: string }> | null>
  /** Each user's groups, for the `groups` attribute. */
  groupsOf(
    tenantId: string,
    userIds: string[],
  ): Promise<Map<string, { id: string; displayName: string }[]>>

  // ── Groups ──
  listGroups(
    tenantId: string,
    directoryId: string,
    input: ListInput<GroupFilter>,
  ): Promise<Page<DirectoryGroupRow>>
  group(
    tenantId: string,
    directoryId: string,
    id: string,
  ): Promise<DirectoryGroupRow | null>
  membersOf(
    tenantId: string,
    groupIds: string[],
  ): Promise<Map<string, { id: string; display: string }[]>>
  /**
   * `skipped`: member ids that name nobody live in this directory, left out
   * (an IdP may push a group before, or without, some of its members).
   */
  createGroup(
    tenantId: string,
    directoryId: string,
    input: StoredGroup,
    audit: AuditEvent,
  ): Promise<Written<DirectoryGroupRow> & { skipped: number }>
  editGroup(
    tenantId: string,
    directoryId: string,
    id: string,
    edit: (current: { row: DirectoryGroupRow; members: string[] }) => StoredGroup,
    audit: AuditEvent,
  ): Promise<(Written<DirectoryGroupRow> & { skipped: number }) | null>
  deleteGroup(
    tenantId: string,
    directoryId: string,
    id: string,
    audit: AuditEvent,
  ): Promise<Written<{ id: string }> | null>

  // ── The outbox and the apply job ──
  /** Entries not applied and older than `before`: what a kick re-schedules. */
  pending(
    tenantId: string,
    directoryId: string,
    before: Date,
    limit: number,
  ): Promise<OutboxEntry[]>
  /**
   * The row, deleted or not, with its directory's state, and the newest
   * unapplied entry for it: what `markApplied` may stamp once the row has
   * been carried out. Null once the row is gone.
   */
  forApply(
    tenantId: string,
    directoryUserId: string,
  ): Promise<{
    row: DirectoryUserRow & { directoryEnabled: boolean }
    upTo: string | null
  } | null>
  /**
   * What the workspace's ENABLED directories say about this account, from
   * their live rows linked to it: `active` while any says so, `inactive` when
   * all say not, `unknown` when none knows it.
   *
   * ⚠ A ROW HOLDING `last_owner` COUNTS AS ACTIVE. The workspace's last owner
   * is never taken out, so a directory that switched them off must not also
   * lock them out of SSO; the conflict is on their row for an admin to see.
   */
  personStatus(
    tenantId: string,
    clerkUserId: string,
    /** A row to leave out: the one being deactivated must not vote on itself. */
    except?: string,
  ): Promise<"active" | "inactive" | "unknown">
  /** The groups this person is in, across the workspace's enabled directories. */
  personGroups(tenantId: string, clerkUserId: string): Promise<DirectoryGroupRef[]>
  /** `taken`: another live row of the same directory is linked to that account. */
  linkUser(
    tenantId: string,
    id: string,
    clerkUserId: string,
  ): Promise<"linked" | "taken">
  /** True when this call changed it (null clears it). */
  setConflict(
    tenantId: string,
    id: string,
    conflict: DirectoryConflict | null,
    detail: Record<string, unknown> | null,
    at: Date,
  ): Promise<boolean>
  /** Whether any row of this person in the workspace, deleted or not, holds a ban of ours. */
  bannedByDirectory(tenantId: string, clerkUserId: string): Promise<boolean>
  /**
   * On every row of this person in the workspace. Lifting it also drops the
   * deleted rows that were only kept to remember the ban.
   */
  setBannedByDirectory(
    tenantId: string,
    clerkUserId: string,
    banned: boolean,
  ): Promise<void>
  markApplied(
    tenantId: string,
    directoryUserId: string,
    upTo: string,
    at: Date,
  ): Promise<void>
  /** One more failed attempt on every pending entry of this row. */
  noteFailure(tenantId: string, directoryUserId: string, reason: string): Promise<void>
  /** A row marked deleted goes for good (and its outbox entries with it). */
  purgeUser(tenantId: string, id: string): Promise<void>
  /** A new outbox entry for a live row: "look at this person again". */
  requeue(
    tenantId: string,
    directoryId: string,
    id: string,
  ): Promise<OutboxEntry | null>
  /** The workspace's access domains with a live proof (verified, not lapsed, not displaced). */
  liveDomains(tenantId: string): Promise<string[]>
  /** The waiting list (#327): a request "from directory", once. */
  fileWaitlist(
    tenantId: string,
    input: { userId: string; email: string },
  ): Promise<void>
  /** Answers this person's open request from the directory. */
  closeWaitlist(tenantId: string, userId: string, accepted: boolean): Promise<void>

  // ── The bridge ──
  /**
   * Live rows of the workspace's enabled directories whose `externalId` or
   * `userName` is this subject, or whose address is this one: who they are
   * linked to (null when no account was made or claimed yet) and whether the
   * directory says they are active.
   */
  provisioned(
    tenantId: string,
    input: { subject: string; email: string },
  ): Promise<{ clerkUserId: string | null; active: boolean; by: "subject" | "email" }[]>
}

/**
 * The Clerk calls provisioning needs beyond `ClerkIdentity`. Every method
 * throws when Clerk cannot be asked, and answers an outcome only for what
 * Clerk actually said.
 */
export interface ClerkProvisioning {
  /**
   * A user with this address and no password (`skip_password_requirement`):
   * made at SCIM time, so authd's projection, fed by Clerk's webhooks, has
   * them before they ever sign in. `taken`: Clerk says the address is held
   * (`form_identifier_exists`). `incomplete`: Clerk requires a field we did not
   * send (`form_data_missing`, a first or last name).
   */
  createUser(input: {
    email: string
    firstName: string
    lastName: string
    externalId: string
  }): Promise<
    | { outcome: "created"; id: string }
    | { outcome: "taken" }
    | { outcome: "incomplete" }
  >
  /** Adds a verified address and makes it primary. `taken`: another account holds it. */
  addPrimaryEmail(userId: string, email: string): Promise<"added" | "taken">
  makePrimary(userId: string, emailId: string): Promise<void>
  unban(userId: string): Promise<void>
}
