import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgSchema,
  halfvec,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"

/**
 * The transactional product: tenants, their domains and keys, and the mail they
 * send. Separate from `authd`, which is a read model of Clerk and is queried by
 * a different process in a different language.
 *
 * ⚠ EVERY TABLE HERE IS TENANT-SCOPED AND PROTECTED BY ROW LEVEL SECURITY. The
 * policies live in the migration, not here - Drizzle has no DDL for them - and
 * they read `app.tenant_id`, which `withTenant()` sets per transaction. A query
 * issued without that setting does not return an empty result - it raises,
 * deliberately, so a missing tenant context fails at the first query rather
 * than quietly returning nothing and looking like an empty account.
 *
 * It raises one of two errors, and the difference is worth knowing at 3am. A
 * connection that has never set the parameter says `unrecognized configuration
 * parameter "app.tenant_id"`. One that set it inside an EARLIER transaction
 * reverts to an empty value rather than to undefined, and says `invalid input
 * syntax for type uuid: ""`. Connections are pooled, so the second is the one
 * production will show you, and on its own it reads like a bad parameter
 * instead of a forgotten `withTenant()`.
 *
 * ⚠ RLS DOES NOT APPLY TO THE TABLE OWNER. The `i10` role owns these tables and
 * runs the migrations; the API and the worker connect as `i10_api`, which owns
 * nothing. Pointing the application at the owner turns every policy below into
 * a no-op with no error and no log line, which is why `assertRlsSubject()` in
 * client.ts refuses to start against an owning or BYPASSRLS role.
 */
export const core = pgSchema("core")

export const tenantStatus = core.enum("tenant_status", [
  "active",
  "suspended",
  "deleted",
])

export const messageStatus = core.enum("message_status", [
  "queued",
  "sending",
  "sent",
  "failed",
  "canceled",
])

/**
 * The two priority classes.
 *
 * ⚠ THESE ARE CLASSES, NOT TENANTS. Separating them stops one tenant's bulk
 * batch from queueing in front of another tenant's password reset, which is the
 * failure that matters most - latency on a reset is the product. It does
 * nothing about one tenant flooding the transactional class; that is what the
 * per-tenant admission limit at the API is for.
 *
 * Fairness WITHIN a class is deliberately left to a later step. Every job
 * carries its `tenant_id`, so the group key that BullMQ Pro's round-robin needs
 * already exists - the upgrade is two constructors, not a redesign.
 */
export const messageQueue = core.enum("message_queue", ["transactional", "bulk"])

export const messageEventType = core.enum("message_event_type", [
  "queued",
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "rejected",
  "failed",
  // Engagement, only for domains that opted in (#154). Added last: Postgres
  // enum order is fixed once written, and nothing sorts on it.
  "opened",
  "clicked",
  "unsubscribed",
])

/**
 * What a customer's endpoint can subscribe to.
 *
 * ⚠ THESE NAMES ARE A PUBLIC CONTRACT AND ARRIVE IN CUSTOMER CODE AS STRING
 * LITERALS. A rename is a breaking change to every `if (event.type === …)` any
 * customer has written, and it breaks silently - their handler stops matching
 * and does nothing. Add, never rename.
 *
 * ⚠ AND EVERY ONE OF THEM ORIGINATES AT SES, INCLUDING `email.sent`. The send
 * worker does not emit events: SES's configuration set publishes `Send` the
 * moment it accepts a message, so one ingestion path produces all of them in
 * one order from one source. Emitting `sent` ourselves and the rest from SES
 * would give two clocks, two failure modes, and a `sent` that can arrive for a
 * message SES later rejected.
 */
export const webhookEventType = core.enum("webhook_event_type", [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.opened",
  "email.clicked",
  "email.unsubscribed",
])

export const webhookDeliveryStatus = core.enum("webhook_delivery_status", [
  "pending",
  "delivered",
  /** Every attempt used. Terminal - the reconciler for this is a person. */
  "failed",
])

/**
 * How far along a domain's verification is.
 *
 * ⚠ RESEND'S VOCABULARY, VERBATIM, AND THAT IS THE POINT OF THE CHOICE. These
 * strings reach customer code as literals in `if (domain.status === ...)`, and
 * a migration from Resend that has to rewrite those comparisons is a migration
 * that does not happen. `temporary_failure` in particular is not a synonym for
 * `failed`: SES uses it for a DNS lookup that failed in a way worth retrying,
 * and collapsing the two would tell a customer their correct records are wrong.
 */
/**
 * Which MTA a domain's mail leaves through.
 *
 * ⚠ `auto` IS NOT A THIRD MTA, IT IS "ASK THE PLAN". Free tenants send through
 * our own MTA and paid ones through SES, and that mapping is policy that will
 * change. Storing the RESOLVED answer on every domain would freeze today's
 * policy into rows and make a pricing change a backfill; storing `auto` keeps
 * the decision in one place and leaves the column for the exceptions.
 *
 * ⚠ AND THE OVERRIDES EXIST FOR SUPPORT, NOT FOR CUSTOMERS. A domain pinned to
 * `direct` or `ses` ignores the plan entirely - for a customer whose
 * deliverability needs one specific path, or to move somebody off a route that
 * is having a bad day. It is a dashboard control, not an API field.
 */
export const deliveryRoute = core.enum("delivery_route", ["auto", "ses", "direct"])

/**
 * Which MTA actually carried one message. Stamped by the worker at send.
 *
 * ⚠ A SEPARATE TYPE FROM `delivery_route` BECAUSE `auto` IS NOT AN ANSWER. The
 * column above is a stored PREFERENCE and may say "ask the plan"; this one is
 * the record of what happened, and a message that was sent went one way or the
 * other. Reusing the override's type here would make `auto` representable on a
 * row describing the past, and the reporting query that counts direct against
 * SES would silently have a third bucket nobody meant to create.
 */
export const sentRoute = core.enum("sent_route", ["ses", "direct"])

export const domainStatus = core.enum("domain_status", [
  /** No identity has been created yet. */
  "not_started",
  /** Records issued, waiting for DNS to propagate. */
  "pending",
  "verified",
  /** SES gave up. The records are absent or wrong. */
  "failed",
  /** A retryable lookup failure. NOT the same as `failed`. */
  "temporary_failure",
])

/**
 * An SES tenant's sending status (#157), lowercased from SES's own values.
 *
 * ⚠ `reinstated` IS NOT `enabled`. SES re-enables a paused tenant into a grace
 * state where its open reputation findings are ignored until they resolve - it
 * can send, and it is on probation. The risk score reads the difference.
 */
export const sesSendingStatus = core.enum("ses_sending_status", [
  "enabled",
  "disabled",
  "reinstated",
])

export const suppressionReason = core.enum("suppression_reason", [
  "hard_bounce",
  "complaint",
  "manual",
  "unsubscribe",
])

/**
 * A customer of i10 - the unit of ownership, billing and isolation.
 *
 * ⚠ IT REFERENCES CLERK, IT IS NOT CLERK. `clerk_org_id` is nullable because a
 * solo developer signs up with no organization and must still be able to send.
 * Making the Clerk org the tenant would force everyone into an org and would
 * make reading your own data depend on Clerk being reachable. Clerk stays
 * authoritative for identity; ownership of mail is ours.
 */
export const tenants = core.table(
  "tenants",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),

    /** URL-safe handle. Stable once issued - it appears in dashboard links. */
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),

    clerkOrgId: text("clerk_org_id").unique(),

    /**
     * Who the tenant belongs to when there is no organization, and who survives
     * one being deleted. Not a foreign key: `authd.accounts` only ever holds
     * users with a mailbox on a domain we host, and most tenant owners will not
     * have one.
     */
    ownerClerkUserId: text("owner_clerk_user_id").notNull(),

    /**
     * Suspension is not deletion. A suspended tenant keeps its data and its
     * domains - it simply stops being allowed to send, which is a decision
     * billing makes and this column records.
     */
    status: tenantStatus("status").notNull().default("active"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tenants_owner_idx").on(t.ownerClerkUserId)],
)

/**
 * A domain a tenant has proven it controls.
 *
 * ⚠ `name` IS GLOBALLY UNIQUE, ACROSS TENANTS. Two tenants cannot both own
 * example.com, and that is a security property rather than a modelling
 * preference: a second tenant claiming a verified domain could send as it and
 * could receive its mail. The uniqueness is what makes verification mean
 * anything.
 *
 * ⚠ THIS TABLE REPLACES THE `MAIL_DOMAINS` ENV VAR. That variable is one global
 * list for the whole deployment, which is correct only while i10.tech is the
 * only domain. Once a customer hosts mailboxes, the question "may this address
 * become a local recipient" has a per-tenant answer and has to be a query.
 */
export const domains = core.table(
  "domains",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠ NOT GLOBALLY UNIQUE, AND THAT IS A DELIBERATE REVERSAL. It was, and the
     * consequence was that the first account to type `spotify.com` held it for
     * ever - without publishing a single record. The real owner then hit "That
     * domain is already registered" with no route past it. Exclusivity now
     * follows PROOF instead of arrival order: see the two indexes below and
     * migration 0039.
     */
    name: text("name").notNull(),

    /** What the domain is used for. A domain may do both, or only one. */
    sends: boolean("sends").notNull().default(true),
    hostsMailboxes: boolean("hosts_mailboxes").notNull().default(false),

    /**
     * The return path's subdomain, stored as the label only ("send"), not the
     * FQDN - derive the name with `returnPathDomain` rather than by hand.
     *
     * ⚠ ONE RETURN PATH FOR BOTH ROUTES. SES and our relay both write it as
     * the envelope sender, and its SPF record authorises both, so SPF passes
     * and aligns with the customer's `From:` whichever way the mail leaves.
     * Its MX must be Amazon's - see `returnPathDomain` for what that costs.
     * There used to be a second label, `bounce_subdomain`, with its MX pointed
     * at us; migration 0057 dropped it.
     *
     * ⚠ RELAXED ALIGNMENT IS WHAT MAKES A SUBDOMAIN ENOUGH. DMARC's default
     * `aspf=r` aligns anything under the organizational domain, so
     * `send.example.com` aligns with `From: someone@example.com`. Under
     * `aspf=s` it would not - which is a reason never to publish a DMARC record
     * for a customer with strict alignment on.
     */
    mailFromSubdomain: text("mail_from_subdomain").notNull().default("send"),

    /**
     * Which MTA this domain's API mail leaves through. `auto` asks the plan.
     *
     * ⚠ ON THE DOMAIN, NOT THE TENANT, BECAUSE DELIVERABILITY IS PER DOMAIN. A
     * customer with a warmed sending domain and a brand-new one has different
     * needs for each, and a tenant-level switch would force the same answer on
     * both.
     *
     * ⚠ THIS WAS ONE COLUMN CALLED `delivery_route` AND ONE VALUE COULD NOT SAY
     * ENOUGH. A domain has two kinds of mail leaving it - what the API sends
     * and what its mailboxes send - and they are different products with
     * different economics. One column forced the same answer on both, so a
     * customer whose people send through our own MTA could not also have their
     * transactional traffic on SES. Split 2026-09-16; the old column became
     * this one, so every existing preference kept applying to API mail.
     */
    transactionalRoute: deliveryRoute("transactional_route").notNull().default("auto"),

    /**
     * @deprecated Superseded by `transactionalRoute`. Dropped in a follow-up.
     *
     * ⚠ STILL HERE BECAUSE A RENAME IS NOT SAFE IN ONE DEPLOY. `ALTER TABLE
     * RENAME COLUMN` is instant, but between the migration and the last old pod
     * rolling there are readers in flight expecting the old name, and they fail
     * for the width of the rollout. Expand, backfill, switch readers, contract:
     * this column is backfilled into `transactional_route` by migration and
     * read by nothing from 2026-09-16.
     */
    deliveryRoute: deliveryRoute("delivery_route").notNull().default("auto"),

    /**
     * Which MTA this domain's MAILBOX mail leaves through. `auto` asks the plan.
     *
     * ⚠ STORED AND RENDERED, AND READ BY NOTHING YET. Stalwart chooses the
     * mailbox route itself by evaluating an expression against its own queue,
     * and that expression - plus the SES SMTP relay behind it - is not built.
     * The column exists so the preference has somewhere to live and the API can
     * answer with it; see docs/decisions/mail-routing.md. It is the same shape
     * of promise `delivery_route` made before anything read that either, which
     * is exactly why the note is here rather than implied.
     */
    mailboxRoute: deliveryRoute("mailbox_route").notNull().default("auto"),

    /**
     * Whether i10 serves this domain's mail records from its own nameservers.
     *
     * ⚠ IT CHANGES WHAT THE CUSTOMER MUST PUBLISH, WHICH IS WHY IT IS NOT A
     * SETTING TO TOGGLE. Delegated, they add three NS record sets and we serve
     * the rest; manual, they add six records themselves. Flipping it on a live
     * domain invalidates whichever set is already published, so it is chosen at
     * creation and changed only deliberately.
     *
     * ⚠ AND MANUAL IS THE DEFAULT, BECAUSE IT HAS NO DEPENDENCY ON US. Records
     * in the customer's own DNS keep resolving whatever happens to our
     * nameserver; a delegated domain stops resolving entirely. Until that is
     * served by something with real redundancy, the safer shape is the default.
     */
    delegated: boolean("delegated").notNull().default(false),

    /**
     * Open and click tracking (#154), which the worker turns into a choice of
     * SES configuration set - see `configurationSetFor` in send/ses.ts.
     *
     * ⚠ OFF BY DEFAULT, AND A PER-DOMAIN DECISION RATHER THAN OURS. Opens need
     * a pixel and clicks rewrite every link through a redirect; both are
     * personal data about the recipient, and the lawful basis for collecting
     * it is the domain owner's to hold.
     */
    openTracking: boolean("open_tracking").notNull().default(false),
    clickTracking: boolean("click_tracking").notNull().default(false),

    /**
     * BYODKIM. Both halves are published in the customer's DNS and neither is
     * secret: the selector is the label the key is served under, the public key
     * is the TXT record's payload. The private half is `dkimPrivateKeySealed`
     * below.
     *
     * ⚠ THE SELECTOR IS RANDOM RATHER THAN A FIXED `i10`, which is what makes
     * rotation possible at all - see domains/dkim.ts. A fixed one means a single
     * name per domain, so replacing a key is a destructive edit of a live record
     * with a window in which nothing verifies.
     */
    dkimSelector: text("dkim_selector"),
    dkimPublicKey: text("dkim_public_key"),

    /** The SES tenant this domain's sending is attributed to. */
    sesTenantName: text("ses_tenant_name"),
    /**
     * Which set of tenant associations `sesTenantName` was recorded with -
     * `TENANT_LAYOUT` in domains/identity.ts.
     *
     * ⚠ A NAME ALONE CANNOT SAY WHETHER THE ATTACH IS STILL ENOUGH. Adding a
     * configuration set (#154 added three) leaves every existing attach missing
     * it, and SES refuses a tenant send whose set the tenant does not hold. The
     * worker names a tenant only from `SENDABLE_LAYOUT` up, and the re-check
     * re-attaches anything older than `TENANT_LAYOUT`.
     */
    sesTenantLayout: integer("ses_tenant_layout"),

    /**
     * The DKIM private key, sealed with `WEBHOOK_SECRET_KEY`.
     *
     * ⚠ SEALED, WHICH IS WHAT LETS IT LIVE IN THIS TABLE AT ALL. A database
     * backup, a replica or a read-only analytics grant must never be enough to
     * sign mail as a customer's domain, and none of them are: the key that
     * opens this lives outside the database, so the ciphertext is inert without
     * it.
     *
     * ⚠ AN EARLIER DESIGN PUT A `dkim_private_key_ref` HERE INSTEAD - a pointer
     * into an external secret store, on the reasoning that the key must not be
     * in this table at any price. Sealing buys the same property without the
     * second system to run, so the column was superseded and never written;
     * migration 0034 dropped it. The comment above it survived the change and
     * claimed for a while that the private key was not in this table, directly
     * beside the column holding it.
     *
     * ⚠ AND IT IS NEVER RETURNED BY THE API. There is no "show me my DKIM key"
     * endpoint, for the same reason there is none for a webhook signing secret:
     * such a call is a better target than the database it would read from.
     */
    dkimPrivateKeySealed: text("dkim_private_key_sealed"),

    /**
     * Proves WHICH workspace published a delegation.
     *
     * ⚠ THE DELEGATION RECORDS CANNOT DO IT, WHICH IS WHY THIS EXISTS. Every
     * delegating customer is told to publish the same two nameservers, so what
     * lands in DNS is identical whoever produced it - and the zone claim fell
     * to arrival order, which is not evidence. A stranger could add a domain,
     * publish nothing, and have the real owner's NS records resolve to the
     * stranger's zone and verify them. See migration 0042 and ownership.ts.
     *
     * ⚠ IT IS NOW THE LABEL ON THE NAMESERVER NAMES, NOT A SEPARATE CHALLENGE
     * RECORD. It began as a token in a `_i10-challenge.<domain>` TXT record,
     * published beside the delegation to carry the identity the delegation
     * could not. Prefixing the nameservers with it instead -
     * `<claim>.ns1.i10.tech` - collapses the two into one fact: only the holder
     * of the domain's DNS can publish it, and the label says whose claim it is.
     * The challenge record is gone; see domains/zone.ts and domains/referral.ts.
     *
     * ⚠ WHICH MEANS EACH NAMESERVER NAME NEEDS A WILDCARD A RECORD -
     * `*.ns1.i10.tech`, pointed at the nameserver and NOT PROXIED. Without it
     * every claim's delegation points at a name that resolves to nothing.
     *
     * ⚠ DEFAULTED IN THE DATABASE so a row cannot exist without one, including
     * rows written by anything that is not this application.
     */
    delegationToken: text("delegation_token")
      .notNull()
      .default(sql`replace(gen_random_uuid()::text, '-', '')`),

    /**
     * ⚠ SES'S ANSWER, COPIED - NOT DERIVED FROM `verified_at`. A domain can be
     * `failed` or `temporary_failure` while `verified_at` is null, and those
     * three states are what a customer needs told apart: one means wait, one
     * means check your DNS, one means it never started.
     */
    status: domainStatus("status").notNull().default("not_started"),

    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    dnsCheckedAt: timestamp("dns_checked_at", { withTimezone: true }),

    /**
     * When another workspace proved this name and took it from this row.
     *
     * ⚠ THE LATEST PROOF WINS, SO THIS IS HOW THE LOSER FINDS OUT. A workspace
     * that verifies a name somebody else holds takes it - the case it exists
     * for is an owner who lost the account the domain was in and has to prove
     * it again from a new one. The old row is kept, set `failed` so it cannot
     * send, and stamped here so the console can say WHY rather than showing a
     * failure that reads like broken DNS.
     *
     * ⚠ AND WHILE IT IS SET, NOTHING BUT A PERSON'S VERIFY MAY MOVE THE ROW.
     * The SES identity is keyed on the name, so after a move SES's opinion is
     * the NEW holder's; a poll copying it here would re-verify the loser. See
     * `refresh`. Cleared by this row's own successful verify.
     */
    displacedAt: timestamp("displaced_at", { withTimezone: true }),

    /**
     * When the registrable domain was registered, from RDAP (#170).
     *
     * ⚠ LOOKED UP ONCE BY THE HOURLY RISK RUN, NOT ON EVERY SCORE. A
     * registration date does not change, and rdap.org allows ten requests in
     * ten seconds. Null with `rdap_checked_at` set means the registry has no
     * RDAP (many ccTLDs) - which the score reads as unknown, never as young.
     */
    registeredAt: timestamp("registered_at", { withTimezone: true }),
    rdapCheckedAt: timestamp("rdap_checked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("domains_tenant_idx").on(t.tenantId),

    /**
     * ⚠ ONE WORKSPACE, ONE ROW PER NAME. Without this, dropping the global
     * constraint would let a single tenant add `example.com` twice - two DKIM
     * keys and two record sets for one name, with no way to tell which of two
     * identical rows is the one that verified.
     */
    unique("domains_tenant_name_unique").on(t.tenantId, t.name),

    /**
     * ⚠ THE EXCLUSIVITY, SCOPED TO PROOF. Any number of tenants may hold a name
     * as pending; exactly one may hold it verified. The second tenant to verify
     * gets 23505 on the UPDATE, which `domainStore.verify` turns into a
     * `conflict` - true, and the only safe direction for the race to fall.
     */
    uniqueIndex("domains_verified_name_unique")
      .on(t.name)
      .where(sql`${t.status} = 'verified'`),
  ],
)

/**
 * Which domain row holds the DNS zones for a delegated name.
 *
 * ⚠ THIS IS THE HALF OF `domains_verified_name_unique` THAT INDEX CANNOT COVER,
 * AND THE REASON IS CIRCULAR. A delegated domain is verified when SES resolves
 * `<selector>._domainkey.<domain>`, and that lookup follows the customer's NS
 * records into a zone we serve - so publishing the zone is not a record of a
 * claim, it is the act that MANUFACTURES the proof the claim is granted on.
 * Exclusivity therefore cannot wait for `status = 'verified'`: nothing can
 * verify until its zone already answers.
 *
 * ⚠ WITHOUT IT, `create` PUBLISHED THE ZONE UNVERIFIED AND KEYED ON THE NAME
 * ALONE. `upsertZoneStatement` is `on conflict (name) do update`, so a second
 * tenant adding an already-delegated domain replaced the first tenant's zone
 * with their own DKIM selector, underneath NS records the real owner had
 * published - and then verified against it. `remove` was the mirror: it dropped
 * the zones by name with no ownership test at all.
 *
 * ⚠ SO IT IS FIRST-COME, WHICH IS A DELIBERATE AND BOUNDED STEP BACK TOWARDS
 * WHAT 0039 REMOVED. A stranger can hold the DELEGATED mode for a name they do
 * not own. They cannot verify it - SES reads the real owner's DNS, which does
 * not point here - cannot send from it, and cannot stop the owner using the
 * MANUAL record path, which is the default and needs nothing from us. A name
 * that cannot be delegated is an inconvenience; a name somebody else can sign
 * as is a takeover. Only one of those is worth accepting.
 */
export const delegations = core.table(
  "delegations",
  {
    /**
     * The customer's domain, e.g. `example.com` - NOT the three zone names
     * under it. Those are derived by `delegatedZoneNames` and always move
     * together, so one row arbitrates all three and they cannot be split.
     */
    name: text("name").notNull(),

    domainId: uuid("domain_id").notNull(),

    tenantId: uuid("tenant_id").notNull(),

    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * ⚠ NAMED RATHER THAN LEFT TO POSTGRES, because `domainStore.create` chooses
     * what to tell the customer by reading which constraint fired. The default
     * would be `delegations_pkey`, which is a name an later `ALTER` could move
     * out from under that branch without anything failing.
     */
    primaryKey({ name: "delegations_name_unique", columns: [t.name] }),

    /** One claim per domain row, so a retry cannot claim the same name twice. */
    unique("delegations_domain_unique").on(t.domainId),

    index("delegations_tenant_idx").on(t.tenantId),

    /*
     * ⚠ NAMED TO MATCH THE DATABASE, which got them from the hand-written 0041
     * rather than from Drizzle's `<table>_<col>_<ref>_<col>_fk` default. Left to
     * the default, the snapshot described constraints that do not exist under
     * those names - invisible until a migration tries to drop one.
     */
    foreignKey({
      name: "delegations_domain_fk",
      columns: [t.domainId],
      foreignColumns: [domains.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "delegations_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete("cascade"),
  ],
)

/**
 * An offer to move a domain to whoever holds an email address.
 *
 * ⚠ ADDRESSED TO AN EMAIL, NOT A WORKSPACE, because the person receiving it
 * may not have an account yet. It is accepted by somebody signed in with that
 * address VERIFIED at Clerk, into whichever workspace they are in when they
 * press Accept - so a forwarded link is useless to anybody else, and there is
 * no token to leak.
 *
 * ⚠ TWO AUDIENCES, SO TWO POLICIES, BOTH DECLARED HERE AND GENERATED. The
 * sending workspace sees its own offers by `app.tenant_id`, exactly like every
 * other table. The recipient cannot - the row belongs to somebody else's
 * tenant - so a second policy admits rows whose `recipient_email` is one of
 * `app.recipient_emails`, which the API sets only from Clerk's verified
 * addresses for the signed-in person. Policies are permissive, so either one
 * suffices; neither widens the other.
 *
 * ⚠ THE RECIPIENT POLICY READS ITS SETTING WITH `missing_ok`, THE ONE PLACE IN
 * `core` THAT DOES. Every other policy raises when its setting is absent, so a
 * forgotten `withTenant()` fails loudly; here the setting is absent on every
 * ordinary query by design, and raising would break the sender's own reads.
 * An unset or empty value matches nothing.
 *
 * ⚠ THE DOMAIN'S NAME AND THE SENDER ARE COPIED ONTO THE ROW. The recipient
 * cannot read the sender's `domains` or `tenants` rows - RLS - so what they
 * are being offered has to travel with the offer.
 */
export const domainTransfers = core.table(
  "domain_transfers",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),

    /** The sending workspace. */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠ NOT A FOREIGN KEY, AND A CASCADE WOULD BE THE BUG. Accepting moves the
     * domain by deleting its row under the sender's tenant and inserting it
     * under the recipient's - so `on delete cascade` would erase the very
     * offer being accepted, mid-transaction, along with every earlier offer
     * for that domain. A deleted domain leaves its offer pointing at nothing,
     * and accepting it answers `missing`.
     */
    domainId: uuid("domain_id").notNull(),

    domainName: text("domain_name").notNull(),

    /** Stored lowercased; compared lowercased. */
    recipientEmail: text("recipient_email").notNull(),

    /** Who pressed Transfer, and from which workspace - shown to the recipient. */
    offeredBy: text("offered_by").notNull(),
    fromWorkspace: text("from_workspace").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** The workspace it landed in. */
    acceptedTenantId: uuid("accepted_tenant_id"),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
  },
  (t) => [
    index("domain_transfers_tenant_idx").on(t.tenantId),
    index("domain_transfers_recipient_idx").on(t.recipientEmail),

    /**
     * ⚠ ONE OPEN OFFER PER DOMAIN. Two would let two people accept the same
     * domain, and the second acceptance would find nothing to move. A new
     * offer cancels the old one first; see `offer`.
     */
    uniqueIndex("domain_transfers_open_unique")
      .on(t.domainId)
      .where(
        sql`${t.acceptedAt} is null and ${t.declinedAt} is null and ${t.canceledAt} is null`,
      ),

    pgPolicy("domain_transfers_sender", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
    pgPolicy("domain_transfers_recipient_read", {
      for: "select",
      using: sql`${t.recipientEmail} = any(string_to_array(nullif(current_setting('app.recipient_emails', true), ''), ','))`,
    }),
    /*
     * ⚠ UPDATE ONLY, NEVER INSERT OR DELETE. A recipient answers an offer; they
     * cannot make one or erase one. And the check keeps the row addressed to
     * them, so an answer cannot re-address it to somebody else.
     */
    pgPolicy("domain_transfers_recipient_answer", {
      for: "update",
      using: sql`${t.recipientEmail} = any(string_to_array(nullif(current_setting('app.recipient_emails', true), ''), ','))`,
      withCheck: sql`${t.recipientEmail} = any(string_to_array(nullif(current_setting('app.recipient_emails', true), ''), ','))`,
    }),
  ],
)

/**
 * Every API key i10 has issued. This table IS the credential store.
 *
 * ⚠ IT USED TO BE A THIN INDEX OF KEYS CLERK HELD, AND THE COMMENT HERE ARGUED
 * AGAINST EXACTLY WHAT IT NOW DOES - no hash, no scopes, no revocation, on the
 * grounds that a second source of truth for authentication "fails silently and
 * in the customer's favour". That reasoning was sound while Clerk was the first
 * source. It stopped applying when Clerk was removed: there is one source now,
 * and it is this table.
 *
 * ⚠ WHAT FORCED THE CHANGE WAS LATENCY, MEASURED RATHER THAN ASSUMED. Verifying
 * against Clerk cost ~900ms on a cache miss with a 60s TTL, which is most
 * requests for a customer who sends sporadically - larger than the SES call it
 * was authenticating. See drizzle/0031.
 *
 * ⚠ AND THE TENANT LINK DID NOT MOVE. It was already `tenant_id` here, mirrored
 * into a Clerk claim that auth/api-key.ts read on every request. Clerk's own
 * `subject` was never consulted.
 */
export const apiKeys = core.table(
  "api_keys",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: text("name").notNull(),

    /**
     * SHA-256 of the WHOLE key as presented, prefix included.
     *
     * ⚠ THE PLAINTEXT IS NEVER STORED AND CANNOT BE RECOVERED. It is returned
     * once, at creation, and a customer who loses it rotates rather than reads
     * it back.
     *
     * ⚠ AND HASHING THE PREFIX TOO IS WHAT RETIRES AN OLD HAZARD. While Clerk
     * issued these, `i10_live_` and `i10_test_` were nine characters each and
     * stripped to one identical secret, so the mode could never be read off the
     * string. Covered by the hash, they are simply two different keys.
     */
    secretHash: text("secret_hash").notNull().unique(),

    /**
     * The leading, non-secret part of the key - `i10_live_a1b2c3d4`. Shown in
     * the dashboard so a customer can tell two keys apart, and greppable in a
     * leak scan. It is not sufficient to authenticate.
     */
    prefix: text("prefix").notNull(),

    /**
     * `live` or `test`.
     *
     * ⚠ AUTHORITATIVE, WHERE IT WAS ONCE DISPLAY-ONLY. It is a property of the
     * row the hash matched, not of the string a caller sent.
     */
    mode: text("mode").notNull(),

    /**
     * ⚠ CARRIED, NOT ENFORCED. `ResolvedKey` exposes these and no route checks
     * them yet. Empty is "unrestricted", which is what every key has.
     */
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'`),

    /**
     * ⚠ REVOCATION IS IMMEDIATE, AND THAT IS THE WHOLE REASON IT LIVES HERE.
     * Under Clerk the floor was the cache TTL - a leaked production key stayed
     * live for up to a minute. Setting this and deleting the cache entry ends it
     * at once.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    /**
     * ⚠ COARSE BY CONSTRUCTION - written on a cache miss, so once a minute per
     * key rather than once per request. See `core.resolve_api_key`. It answers
     * "is this key still in use", which does not need to be exact.
     */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),

    /**
     * The Clerk user who minted it.
     *
     * ⚠ AUDIT ONLY, NEVER AUTHORIZATION. A sending key belongs to the
     * organisation; authorizing against its creator would mean offboarding one
     * employee takes production sending down with them. Authorization reads
     * `tenantId`, always.
     */
    createdBy: text("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_keys_tenant_idx").on(t.tenantId)],
)

/**
 * Ingress idempotency - layer one of three.
 *
 * A customer retrying `POST /emails` after a timeout must get the same message
 * id back, not a second email. `request_hash` separates a genuine retry from a
 * reused key carrying a different body; the latter is a 409, because silently
 * returning the first message would be worse than either sending or refusing.
 *
 * ⚠ THE ROW IS INSERTED BEFORE THE MESSAGES, NOT AFTER, AND THE PRIMARY KEY IS
 * WHAT SERIALISES A DOUBLE-POST. `insert … on conflict (tenant_id, key) do
 * nothing` blocks on a conflicting row that is still uncommitted, so of two
 * simultaneous retries one inserts and the other waits, then reads the ids the
 * winner wrote. Deciding outside the transaction - read, then insert - would
 * let both miss and both mint a full set of messages, which is the exact
 * duplicate this table exists to prevent.
 *
 * Rows are pruned after 24 hours. A key is a retry window, not a permanent
 * record, and keeping them forever makes this table the largest thing in the
 * database within a year.
 */
export const idempotencyKeys = core.table(
  "idempotency_keys",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    /**
     * Every id the key minted, in the order the caller submitted them.
     *
     * ⚠ AN ARRAY BECAUSE `POST /emails/batch` IS ONE KEY OVER 100 MESSAGES. A
     * single `message_id` can only replay a single send; a replayed batch would
     * have to answer with 99 nulls or with nothing, and an SDK that got nothing
     * back would send the batch again. Null only while the inserting
     * transaction is still open - a committed row always carries its ids.
     */
    messageIds: uuid("message_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.key] }),
    index("idempotency_keys_created_idx").on(t.createdAt),
  ],
)

/**
 * One row per message accepted, and the source of truth for whether it was sent.
 *
 * ⚠ THIS TABLE IS THE SEND LOCK, NOT BULLMQ. A BullMQ job lock expires, and a
 * worker that is merely slow - a blocked event loop, a long SES call without
 * lock renewal - has its job declared stalled and handed to a second worker.
 * That is the double-send path, and it opens under load. The guard is a
 * compare-and-swap here:
 *
 *   update core.messages set status='sending', attempts=attempts+1,
 *          claimed_by=$2, claimed_at=now()
 *    where id=$1 and created_at=$3 and status='queued' returning *
 *
 * No row back means another worker owns it and this one drops the job. Redis is
 * the transport; Postgres decides.
 *
 * ⚠ PARTITIONED BY `created_at`, MONTHLY, AND BY TIME RATHER THAN BY TENANT.
 * Tenant partitioning yields thousands of partitions and worse plans; time
 * partitioning makes retention a DROP, which is the only operation on this
 * table that is otherwise ruinous. The consequence is that the primary key must
 * include the partition key - hence `(id, created_at)` - and that a lookup by
 * bare id would have to touch every partition. It does not have to: the ids are
 * UUIDv7, so the timestamp is inside the id and the partition is derivable from
 * it.
 *
 * The partitions and the DEFAULT catch-all are created in the migration.
 */
export const messages = core.table(
  "messages",
  {
    id: uuid("id")
      .notNull()
      .default(sql`uuidv7()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    tenantId: uuid("tenant_id").notNull(),
    domainId: uuid("domain_id"),
    apiKeyId: uuid("api_key_id"),

    /**
     * The broadcast this message was fanned out from, if any.
     *
     * ⚠ NOT A FOREIGN KEY, LIKE EVERY OTHER REFERENCE ON THIS TABLE.
     * `core.messages` is partitioned, and a partitioned table cannot be the
     * referencing side of an FK to a non-partitioned one without the constraint
     * being declared on every partition - which the create-partition path would
     * have to know about and would silently omit for any partition made by
     * hand. The reference is enforced by the code that writes it, which is the
     * same position `domain_id` and `api_key_id` already take.
     *
     * ⚠ AND IT IS WHAT MAKES A BROADCAST'S NUMBERS DERIVED RATHER THAN STORED.
     * Every count on the broadcast page is an aggregate over the messages that
     * carry this id, joined to their events - so a late bounce moves the number
     * on its own, and there is no counter to drift.
     */
    broadcastId: uuid("broadcast_id"),

    queue: messageQueue("queue").notNull().default("transactional"),
    status: messageStatus("status").notNull().default("queued"),

    fromAddress: text("from_address").notNull(),
    toAddresses: text("to_addresses").array().notNull(),
    ccAddresses: text("cc_addresses")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    bccAddresses: text("bcc_addresses")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    replyTo: text("reply_to")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text("subject").notNull(),

    /**
     * The delivery attempt counter and its claim.
     *
     * A row left in `sending` past the claim timeout is genuinely ambiguous -
     * SES was called and the outcome was never recorded, and there is no way to
     * ask SES which it was. The sweeper resends it: a reset that never arrives
     * is a support ticket, a duplicate is a shrug. What makes that safe is that
     * the retry reuses the SAME RFC 5322 Message-ID, derived from `id`, so
     * receiving systems collapse the duplicate.
     */
    attempts: integer("attempts").notNull().default(0),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),

    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),

    /**
     * The relaying MTA's own id for the accepted message, and the join key for
     * its events.
     *
     * ⚠ THIS WAS `ses_message_id`, AND THE NAME WAS A ROUTING ASSUMPTION IN A
     * COLUMN. A direct-routed message has no SES id - it has whatever our own
     * MTA called it - so the old name would have meant writing a Stalwart queue
     * id into a column named for Amazon, and every reader would have had to
     * know that. Renamed 2026-09-16 alongside `sent_route`, which says which
     * provider the id belongs to.
     */
    providerMessageId: text("provider_message_id"),

    /**
     * @deprecated Superseded by `providerMessageId`. Dropped in a follow-up.
     *
     * ⚠ SAME EXPAND-AND-CONTRACT AS `delivery_route` ON `core.domains`, and it
     * matters more here: this table is the billing record, and the SES
     * reconcilers read it on a schedule. A column that vanished under a running
     * reconciler would turn a repair pass into an error pass. Backfilled into
     * `provider_message_id` by migration and read by nothing from 2026-09-16.
     */
    sesMessageId: text("ses_message_id"),

    /**
     * Which MTA carried it. Null until the worker has actually sent it.
     *
     * ⚠ NULLABLE ON PURPOSE: A QUEUED MESSAGE HAS NOT BEEN ROUTED YET. The
     * route is resolved at send, not at admission, because the domain's
     * preference or the tenant's plan can change while a message sits in the
     * queue - and stamping it early would record an intention rather than a
     * fact. It is also what makes "how much went direct" answerable without
     * joining anything.
     */
    sentRoute: sentRoute("sent_route"),

    lastError: text("last_error"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    // The queue drain and the sweeper both scan by status within a class.
    index("messages_claim_idx").on(t.queue, t.status, t.createdAt),
    // Every dashboard list is "this tenant's recent messages".
    index("messages_tenant_recent_idx").on(t.tenantId, t.createdAt),
    index("messages_ses_id_idx").on(t.sesMessageId),
    index("messages_provider_id_idx").on(t.providerMessageId),
  ],
)

/**
 * Bodies, kept out of `messages` on purpose.
 *
 * The hot paths - draining the queue, listing a tenant's recent sends, sweeping
 * stuck rows - never read the body, and an HTML body is orders of magnitude
 * larger than the row that describes it. Keeping them apart is what lets the
 * status table stay narrow enough for its indexes to matter.
 *
 * Partitioned on the same key as `messages`, so a retention DROP removes both.
 */
export const messageBodies = core.table(
  "message_bodies",
  {
    messageId: uuid("message_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    tenantId: uuid("tenant_id").notNull(),

    text: text("text"),
    html: text("html"),
    headers: jsonb("headers"),

    /**
     * Files to send with the message, in one of two shapes (#136, #168):
     *
     *   inline  `{ filename, content_type?, content }`, base64, exactly as the
     *           caller sent it. Every message starts like this.
     *   stored  `{ filename, content_type?, size, sha256 }`. The bytes are in
     *           R2 at `<tenant_id>/sha256/<hash>`, once per workspace however
     *           many messages carry them.
     *
     * ⚠ RAW AT ACCEPT, MOVED AFTER THE SEND (#188). Accept writes inline in the
     * same transaction as today, so nothing touches object storage before the
     * 202. The content-store job moves finished messages' files to R2 minutes
     * later and sets `attachments_stored_at`. Readers restore through
     * content/attachments.ts, so both shapes read the same.
     *
     * ⚠ THE BODY ROW IS THE ONLY REFERENCE TO AN OBJECT. There is no counter
     * to drift: an object is deleted once no `message_bodies` row names its
     * hash, so whatever removes bodies (retention, tenant deletion) frees their
     * objects without knowing they exist. The GIN index is what makes asking
     * that cheap.
     *
     * ⚠ AND IT IS WHY THIS TABLE IS SPLIT FROM `messages`. The claim, the
     * sweeper and every dashboard list read the status row; none of them read
     * this.
     */
    attachments: jsonb("attachments"),
    /** When the content-store job moved this row's files to R2. */
    attachmentsStoredAt: timestamp("attachments_stored_at", { withTimezone: true }),
    /**
     * The R2 objects this body's html references in place of data-URI images
     * (#168), by SHA-256. Null until the content-store job extracts any; see
     * content/inline.ts for the reference format.
     *
     * ⚠ IT IS WHAT THE OBJECT SWEEP COUNTS, HOWEVER THE BODY IS STORED. After
     * compaction the references live in a template's skeleton or in this
     * message's values, where no index can see them; this list stays on the
     * row, so an image is freed exactly when the last body using it goes.
     */
    inlineObjects: text("inline_objects").array(),

    /**
     * The caller's own labels, forwarded to SES as `EmailTags` and echoed back
     * on every event it publishes.
     *
     * ⚠ OURS WIN ON A COLLISION. `i10_message_id` is the join key between
     * `core.message_events` and this message; a customer tag able to overwrite
     * it would detach every event for that send from the row it describes.
     * Names beginning `i10_` are refused at the contract.
     */
    tags: jsonb("tags"),

    /**
     * The body, stored as a template and its values instead of in full
     * (#169, #171). Null until the content job compacts it.
     *
     * ⚠ COMPACTED ONLY AFTER A BYTE-EXACT CHECK, AND ONLY ONCE THE MESSAGE IS
     * DONE. The job reconstructs the body from the template and the values and
     * compares it with `html`/`text` before it nulls them; any difference and
     * the row is left as it was. It never touches a message still queued or
     * sending. Every reader restores through `restoreBodies` (content/
     * templates.ts), so a compacted row reads exactly like a full one.
     */
    templateId: uuid("template_id"),
    templateValues: jsonb("template_values"),
    compactedAt: timestamp("compacted_at", { withTimezone: true }),

    /**
     * The template version this message was sent from (#160). Null for a send
     * that gave its own `html`/`text`.
     *
     * ⚠ NOT `template_id` ABOVE, WHICH IS THE CONTENT JOB'S DISCOVERED SKELETON
     * (#171). This one is the customer's own template, named in the request;
     * it is provenance - "which version went out" - and the body is still
     * stored in full, where compaction deduplicates it like any other.
     */
    templateVersionId: uuid("template_version_id"),

    /**
     * The workspace's staff-approved template this message fitted exactly
     * (#222), set by the content job. Null for everything else.
     *
     * ⚠ IT IS HOW AN APPROVAL IS JUDGED BY ITS RESULTS. The hourly run counts
     * the bounces and complaints of exactly these messages, and revokes the
     * approval when they cross the thresholds. See risk/trusted.ts.
     */
    trustedTemplateId: uuid("trusted_template_id"),

    /**
     * When the content-store job's compaction pass last looked at this body
     * (#171). Set on EVERY body a pass reads - matched, linked or unique.
     *
     * ⚠ IT IS WHAT MAKES EVERY PASS PROGRESS. Without it a pass read the oldest
     * uncompacted bodies of the last week, and unique mail is never compacted,
     * so once a workspace had a batch's worth of unique finished bodies every
     * run re-read exactly those and never reached newer mail - reproduced:
     * five unique receipts starved six near-identical ones for good.
     */
    examinedAt: timestamp("examined_at", { withTimezone: true }),
    /**
     * The MinHash bands of an examined body that fitted no template (#171).
     *
     * ⚠ THE MEMORY THAT `examined_at` WOULD OTHERWISE ERASE. A template is
     * derived from TWO near-duplicates; once a body is marked examined it is
     * never re-read, so its twin arriving an hour later would find nobody to
     * pair with. A later pass looks its bands up here, through the GIN index,
     * and reads only the few bodies that share one.
     */
    contentBands: text("content_bands").array(),
    /**
     * When the hourly risk run credited and embedded this body (#170, #222).
     * The same progress rule as `examined_at`, for the risk half of the old
     * combined pass, so embeddings and trusted-template credit cannot starve.
     */
    analysedAt: timestamp("analysed_at", { withTimezone: true }),
    /**
     * When the content-store job fingerprinted this body for the farm checks
     * (#170, #171). Fingerprinting used to run in the API after accept; #171's
     * rule is that nothing beyond a hash runs on the send path.
     */
    fingerprintedAt: timestamp("fingerprinted_at", { withTimezone: true }),

    /**
     * Where this body went when it left Postgres (#188): a pack in R2 at
     * `<tenant_id>/packs/<pack_id>`, `pack_length` bytes from `pack_offset`.
     * Null while the body is still inline, and for compacted bodies, which
     * stay in Postgres as a template plus values.
     *
     * ⚠ SET IN THE SAME STATEMENT THAT CLEARS `html` AND `text`, and only after
     * the pack was uploaded and read back. A row either holds its body or
     * points at a pack that has it; never neither.
     */
    packId: uuid("pack_id"),
    packOffset: bigint("pack_offset", { mode: "number" }),
    packLength: integer("pack_length"),
    /**
     * The body's own AES-256-GCM key, wrapped by the master key (base64; see
     * content/seal.ts).
     *
     * ⚠ DELETING IT DELETES THE EMAIL. The sealed bytes stay in the pack until
     * no row names it, and nothing can open them without this.
     */
    bodyKey: text("body_key"),
    packedAt: timestamp("packed_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.createdAt] }),
    // What the compaction pass has not looked at yet.
    index("message_bodies_unexamined_idx")
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.examinedAt} is null and ${t.compactedAt} is null`),
    // Unmatched bodies a later near-duplicate can still pair with.
    index("message_bodies_candidates_idx")
      .using("gin", t.contentBands)
      .where(sql`${t.templateId} is null and ${t.compactedAt} is null`),
    // Linked bodies waiting for their template to be established.
    index("message_bodies_linked_idx")
      .on(t.templateId)
      .where(sql`${t.templateId} is not null and ${t.compactedAt} is null`),
    // What the risk run has not credited or embedded yet.
    index("message_bodies_unanalysed_idx")
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.analysedAt} is null`),
    // What the farm checks have not fingerprinted yet.
    index("message_bodies_unfingerprinted_idx")
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.fingerprintedAt} is null`),
    // Retention deletes by tenant and age; the content-store job finds work
    // the same way.
    index("message_bodies_tenant_created_idx").on(t.tenantId, t.createdAt),
    // What the content-store job still has to move.
    index("message_bodies_attachments_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.attachments} is not null and ${t.attachmentsStoredAt} is null`),
    // "Does any body still name this object?" - the object sweep's question.
    index("message_bodies_attachments_gin_idx").using(
      "gin",
      t.attachments.op("jsonb_path_ops"),
    ),
    // "Does any body still reference this image?" - the object sweep's other half.
    index("message_bodies_inline_objects_gin_idx").using("gin", t.inlineObjects),
    // "Does any body still use this template?" - the template sweep's question.
    index("message_bodies_template_idx")
      .on(t.templateId)
      .where(sql`${t.templateId} is not null`),
    // "Does any body still point into this pack?" - the pack sweep's question.
    index("message_bodies_pack_idx")
      .on(t.packId)
      .where(sql`${t.packId} is not null`),
    // Bodies still inline that may yet be packed (#188).
    index("message_bodies_unpacked_idx")
      .on(t.tenantId, t.createdAt)
      .where(
        sql`${t.packId} is null and ${t.compactedAt} is null and (${t.html} is not null or ${t.text} is not null)`,
      ),
  ],
)

/**
 * The delivery log, fed by SES event destinations and by our own transitions.
 *
 * ⚠ NO FOREIGN KEY TO `messages`, AND THAT IS DELIBERATE. Events arrive
 * asynchronously from an external system that has its own retry schedule; an FK
 * turns a race - an event landing while its message row is still being written,
 * or after retention has dropped it - into a failed insert and a lost event. An
 * index gives the joins without making SES's timing our correctness problem.
 *
 * `source_event_id` is SES's own id for the notification, and the unique index
 * on it makes SNS redelivery a no-op.
 */
export const messageEvents = core.table(
  "message_events",
  {
    id: uuid("id")
      .notNull()
      .default(sql`uuidv7()`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),

    tenantId: uuid("tenant_id").notNull(),
    messageId: uuid("message_id").notNull(),

    type: messageEventType("type").notNull(),
    sourceEventId: text("source_event_id"),
    payload: jsonb("payload"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index("message_events_message_idx").on(t.messageId, t.occurredAt),
    index("message_events_tenant_idx").on(t.tenantId, t.occurredAt),
    uniqueIndex("message_events_source_idx").on(t.sourceEventId, t.occurredAt),
  ],
)

/**
 * A customer's HTTP endpoint, and what it wants to hear about.
 *
 * ⚠ THE ENDPOINT IS THE UNIT OF ORDERING AND OF ISOLATION, WHICH IS WHY THE
 * DELIVERY QUEUE IS GROUPED BY ITS ID RATHER THAN BY TENANT. One customer's
 * staging endpoint timing out for an hour must not delay their production one,
 * and events for a single endpoint must arrive in the order they happened -
 * `email.sent` before `email.delivered`, or a customer's state machine reads
 * backwards. Per-endpoint grouping gives both.
 */
export const webhookEndpoints = core.table(
  "webhook_endpoints",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** ⚠ https only, and never a private address - see webhooks/endpoints.ts. */
    url: text("url").notNull(),
    description: text("description"),

    /**
     * The signing secret, ENCRYPTED AT REST.
     *
     * ⚠ IT CANNOT BE A HASH, WHICH IS WHY IT IS ENCRYPTED INSTEAD. A signature
     * is computed, not compared, so the worker needs the secret back - one-way
     * hashing is not available here the way it is for a password. What is
     * available is that a database dump alone is not enough: the key lives in
     * the environment, so an exfiltrated backup yields ciphertext.
     *
     * ⚠ AND THE PLAINTEXT IS SHOWN EXACTLY ONCE, AT CREATION. Storing it
     * retrievably would make "reveal my signing secret" an API call, and that
     * call is a far better target than the database.
     */
    secretCiphertext: text("secret_ciphertext").notNull(),

    events: webhookEventType("events").array().notNull(),

    enabled: boolean("enabled").notNull().default(true),

    /**
     * ⚠ AN ENDPOINT THAT HAS FAILED LONG ENOUGH IS TURNED OFF, AND THAT IS A
     * PROTECTION FOR US RATHER THAN A COURTESY TO THEM. A customer who deletes
     * their receiver without deleting the endpoint would otherwise have every
     * event they ever generate retried against a dead host, forever, at our
     * expense - and the queue those retries sit in is shared.
     */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_endpoints_tenant_idx").on(t.tenantId)],
)

/**
 * One attempt to tell one endpoint about one event.
 *
 * ⚠ A ROW PER (EVENT, ENDPOINT), WRITTEN BEFORE ANYTHING IS QUEUED. The same
 * discipline as the send path: the database is the record and the queue is a
 * prompt to look at it. A job whose row does not exist is dropped silently; a
 * row no job points at is late, and a sweep can find it.
 *
 * ⚠ AND IT CARRIES ITS OWN PAYLOAD RATHER THAN REBUILDING IT AT DELIVERY TIME.
 * A webhook says what was true when the event happened. Rebuilding from the
 * message row at attempt four would describe the message as it is now - a
 * `bounced` event whose body says `sent`, because a later retry succeeded.
 */
export const webhookDeliveries = core.table(
  "webhook_deliveries",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),

    eventType: webhookEventType("event_type").notNull(),
    /**
     * When the event HAPPENED, which is not when we heard about it.
     *
     * ⚠ THIS IS WHAT THE CUSTOMER'S ENVELOPE CARRIES, SO IT CANNOT BE
     * `created_at`. SNS can be delayed, and our ingestion can be down for an
     * hour and catch up afterwards - publishing the row's own creation time
     * would tell a customer a bounce from an hour ago happened just now, and
     * anyone measuring delivery latency would be measuring our backlog.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** The message this is about. No FK - see `messageEvents` for why. */
    messageId: uuid("message_id"),
    payload: jsonb("payload").notNull(),

    status: webhookDeliveryStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** The last HTTP status we saw, for "why is my endpoint not working". */
    responseStatus: integer("response_status"),
    lastError: text("last_error"),

    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.createdAt),
    index("webhook_deliveries_tenant_idx").on(t.tenantId, t.createdAt),
    // The queue for "what has not been delivered and is not moving".
    index("webhook_deliveries_pending_idx").on(t.status, t.createdAt),
  ],
)

/**
 * Addresses this tenant may no longer send to.
 *
 * Enforced at our API before a send reaches SES, so a customer who keeps a dead
 * address in their own database is refused with a reason rather than quietly
 * burning reputation on it. Scoped per tenant: one customer's hard bounce is not
 * evidence about another customer's relationship with the same person.
 */
export const suppressions = core.table(
  "suppressions",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Lowercased on write; comparisons here must never be case-sensitive. */
    address: text("address").notNull(),
    reason: suppressionReason("reason").notNull(),
    /** The message that caused it, for "why am I suppressed" in the dashboard. */
    messageId: uuid("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.address] }),
    /*
     * ⚠ THE ORDER EVERY READ WANTS, AND THE ONE THE PRIMARY KEY CANNOT GIVE.
     * The console, the API and the export all page newest first, and the
     * suppression rate that feeds the risk score (#170) is a count over a time
     * window per workspace. Without this both are a sort of the workspace's
     * whole list.
     */
    index("suppressions_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
)

/**
 * The current SES sending status of each workspace's tenant (#157).
 *
 * ⚠ ONE ROW PER WORKSPACE, READ ON EVERY SEND. `accept()` refuses a send for a
 * workspace SES has paused before handing it over, so the question has to be a
 * primary-key lookup - the history below is the record, this is the answer.
 *
 * ⚠ NO ROW MEANS ENABLED. Workspaces that were never paused, or have no
 * tenant yet, never get a row; only a status SES has actually reported writes
 * one.
 */
export const sesTenantStatus = core.table(
  "ses_tenant_status",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    status: sesSendingStatus("status").notNull(),
    /** SES's own words, e.g. "Status manually updated." Shown to the customer. */
    cause: text("cause"),
    /** `aws_managed` (SES or Trust & Safety) or `customer_managed` (us). */
    origin: text("origin"),
    /** When SES changed it - not when we heard. */
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    /** When the owner was emailed about the latest pause, so it is sent once. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    pgPolicy("ses_tenant_status_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * Every SES sending status change we have seen, per workspace (#157).
 *
 * ⚠ APPEND-ONLY, AND IT IS A RISK SIGNAL BEFORE IT IS A LOG. The risk score
 * (#170) reads how often and how recently SES paused a workspace, and an SES
 * pause is the strongest negative signal there is - so the history is kept even
 * after the workspace is reinstated and the current row says all is well.
 *
 * ⚠ THE SAME CHANGE CAN ARRIVE TWICE - the EventBridge event and the daily poll
 * both report it. `(tenant_id, status, changed_at)` is unique so the second is a
 * no-op rather than a second pause in the score.
 */
export const sesTenantStatusEvents = core.table(
  "ses_tenant_status_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    status: sesSendingStatus("status").notNull(),
    cause: text("cause"),
    origin: text("origin"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    /** `event` (EventBridge) or `poll` (the daily re-check found it). */
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ses_tenant_status_events_change_unique").on(
      t.tenantId,
      t.status,
      t.changedAt,
    ),
    index("ses_tenant_status_events_tenant_idx").on(t.tenantId, t.changedAt),
    pgPolicy("ses_tenant_status_events_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * A FREE workspace's sending tier (#165): how much it may send in a month, on
 * top of the free plan's 100 a day.
 *
 * ⚠ FREE WORKSPACES ONLY. A paid plan's allowance is what the customer bought
 * and no tier narrows it; abuse on paid plans is the risk score's job (#170).
 * Free workspaces get both - a hard monthly ceiling here, and the score.
 *
 * ⚠ NO `trusted`. #165 sketched one for paying customers, and paying customers
 * have no tier. Enterprise limits are custom plans, which already exist.
 */
export const sendingTier = core.enum("sending_tier", ["strict", "normal"])

/**
 * The tier a free workspace is on, when it is not the default (#165).
 *
 * ⚠ NO ROW MEANS `normal`. New workspaces start there (#170: "don't punish new
 * legitimate users"), so a row exists only once the score or a person moved it.
 *
 * ⚠ WHO MAY WRITE IT: the risk score (`source = 'score'`, #170) and staff
 * (`source = 'staff'`) through the future admin app (#217). Neither exists yet; the
 * store's `set` is the one door both will use, and it writes the audit row in
 * the same transaction.
 */
export const sendingTiers = core.table(
  "sending_tiers",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tier: sendingTier("tier").notNull(),
    /** `score` (#170) or `staff`. */
    source: text("source").notNull(),
    /** Why, in words a reviewer and an appeal can read. */
    reason: text("reason").notNull(),
    /** The staff member, or `risk-score`. */
    setBy: text("set_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    pgPolicy("sending_tiers_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * Every tier change, append-only (#165). "Every change is audited" - and the
 * risk score (#170) reads how often a workspace was demoted.
 */
export const sendingTierEvents = core.table(
  "sending_tier_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The tier before; `normal` when there was no row. */
    fromTier: sendingTier("from_tier").notNull(),
    toTier: sendingTier("to_tier").notNull(),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    setBy: text("set_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sending_tier_events_tenant_idx").on(t.tenantId, t.changedAt),
    pgPolicy("sending_tier_events_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/** How bad SES says a reputation finding is (#158). `high` is what pauses. */
export const sesFindingImpact = core.enum("ses_finding_impact", ["high", "low"])

/**
 * SES reputation findings against a workspace's tenant, one row per episode
 * (#158) - opened, seen again, resolved.
 *
 * ⚠ SES GIVES A FINDING NO ID. `ListRecommendations` has type, impact and a
 * `CreatedTimestamp`; the EventBridge event has type and impact and only the
 * envelope's `time`, which is not the same instant. Keyed on either timestamp,
 * the event and the poll would record one finding twice. So an episode is
 * "the open row for (tenant, type, impact)", and the partial unique index makes
 * a second open of the same thing - SNS redelivery, the nightly poll - an
 * update rather than a new finding.
 *
 * ⚠ IMPACT IS PART OF THE KEY. A LOW bounce finding and a HIGH one can be open
 * at once and resolve separately; merged, the LOW one resolving would close
 * the HIGH one we still need to show and score.
 *
 * ⚠ RESOLVED ROWS ARE KEPT. This is the risk engine's (#170) memory of how often
 * a workspace got close to a pause - worth more than the current state.
 */
export const sesReputationFindings = core.table(
  "ses_reputation_findings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * SES's type, lowercased: `bounce`, `complaint`, `feedback_3p`,
     * `ip_listing`, ... Text, not an enum - a type SES adds must not make the
     * webhook fail every delivery of it.
     */
    type: text("type").notNull(),
    impact: sesFindingImpact("impact").notNull(),
    /** SES's own words, e.g. "The bounce rate exceeded 15.0% ...". Shown. */
    description: text("description"),
    /** SES's `CreatedTimestamp` when the poll saw it first; the event time otherwise. */
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Who opened it: `event` (EventBridge) or `poll`. */
    source: text("source").notNull(),
    /** When the owner was emailed about this episode - HIGH only, once. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ses_reputation_findings_open_unique")
      .on(t.tenantId, t.type, t.impact)
      .where(sql`${t.resolvedAt} is null`),
    index("ses_reputation_findings_tenant_idx").on(t.tenantId, t.openedAt),
    pgPolicy("ses_reputation_findings_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * One row per workspace per day: SES's view of its reputation, and the rates we
 * count ourselves (#158).
 *
 * ⚠ THE RATES ARE OURS, NOT SES'S. No reputation API returns a tenant's bounce
 * or complaint rate, so they are counted from `message_events` - the same SES
 * notifications, per recipient, the numbers the console shows. Kept here
 * because the events age out with their partitions and the risk score (#170)
 * needs the trend for longer than that.
 *
 * ⚠ SOFT BOUNCES ARE COUNTED APART. SES's bounce rate is hard bounces only; a
 * soft-bounce rate climbing is a list going stale before it shows up there.
 */
export const sesReputationSnapshots = core.table(
  "ses_reputation_snapshots",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    /** SES's aggregate: both the customer- and the SES-managed status. */
    sendingStatus: sesSendingStatus("sending_status"),
    /** The worst open finding; null when there is none. */
    impact: sesFindingImpact("impact"),
    /** `standard`, `strict` or `none`, from the policy ARN. */
    policy: text("policy"),
    sends24h: integer("sends_24h").notNull(),
    hardBounces24h: integer("hard_bounces_24h").notNull(),
    softBounces24h: integer("soft_bounces_24h").notNull(),
    complaints24h: integer("complaints_24h").notNull(),
    sends7d: integer("sends_7d").notNull(),
    hardBounces7d: integer("hard_bounces_7d").notNull(),
    softBounces7d: integer("soft_bounces_7d").notNull(),
    complaints7d: integer("complaints_7d").notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day] }),
    pgPolicy("ses_reputation_snapshots_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * What a tenant is paying for, as Polar last told us.
 *
 * ⚠ THIS TABLE IS A COPY, NOT THE TRUTH. Polar is the state of record for
 * subscriptions - it took the money and it is what a dispute is settled
 * against. This row exists so the console can answer "what plan am I on"
 * without a round trip to Polar, and so the reconciler has something to compare
 * against; every value in it arrives from a signature-verified webhook.
 *
 * ⚠ AND IT IS WRITTEN BEFORE THE ENTITLEMENT MOVES. The order is deliberate:
 * row first, entitlement second. If the grant then fails, the truth is
 * already durable and the reconciler repairs the entitlement on its next pass.
 * Reversed, a crash between the two leaves a customer holding a paid plan that
 * nothing in our database records - invisible, and never revoked.
 *
 * ⚠ ONE ROW PER TENANT, NOT A HISTORY. `tenant_id` is unique so the upsert has
 * something to conflict on; what the customer is entitled to today is a single
 * question with a single answer. The audit trail lives in Polar, which keeps it
 * properly and is the thing anyone would actually be asked to produce.
 */
export const subscriptions = core.table(
  "subscriptions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),

    tenantId: uuid("tenant_id")
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠ ALSO UNIQUE, AND THAT IS A SAFETY PROPERTY. Two tenants pointing at one
     * Polar subscription would mean one payment entitling two accounts, and the
     * reconciler - which matches on this id - would flip the plan back and
     * forth between them on every pass.
     */
    polarSubscriptionId: text("polar_subscription_id").notNull().unique(),
    polarCustomerId: text("polar_customer_id").notNull(),
    polarProductId: text("polar_product_id").notNull(),

    /** Our plan id, from POLAR_PRODUCTS. What they bought. */
    planId: text("plan_id").notNull(),

    /**
     * ⚠ `text`, NOT AN ENUM, AND THE REASON IS THE RETRY LOOP. Polar owns this
     * vocabulary and can add to it; an enum would make an unrecognised status a
     * failed INSERT, which is a 500, which Polar retries for hours while the
     * customer's plan never lands. Storing what they said and deciding
     * separately (billing/events.ts) keeps a vocabulary change from being an
     * outage.
     */
    status: text("status").notNull(),

    /**
     * Set the moment a customer clicks cancel, while the subscription is still
     * active and paid for. Recorded so the console can say "ends on the 4th",
     * and deliberately not acted on - see billing/events.ts.
     */
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),

    /**
     * ⚠ POLAR'S CLOCK, AND THE ONLY THING THAT ORDERS TWO EVENTS. Deliveries
     * retry and overtake each other; a delayed `active` arriving after
     * `revoked` would re-grant a plan to a customer who churned. The upsert
     * refuses to move a row backwards past this value.
     */
    eventAt: timestamp("event_at", { withTimezone: true }).notNull(),

    /**
     * The plan the entitlement was last successfully moved to, and NULL until
     * one lands.
     *
     * ⚠ THIS COLUMN IS THE ENTIRE POINT OF THE RECONCILER. It is what makes
     * "the row was written but the entitlement never applied" a query rather
     * than an invisible state - where it is out of step with the plan the
     * subscription entitles, a customer is paying for something they do not
     * have, or holding something they no longer pay for.
     */
    grantedPlanId: text("granted_plan_id"),
    grantedAt: timestamp("granted_at", { withTimezone: true }),

    /**
     * The plan a deferred change is waiting to become, and when.
     *
     * ⚠ WITHOUT THESE A DOWNGRADE LEAVES NO TRACE UNTIL IT HAPPENS. Polar
     * applies a `next_period` change at the period boundary - which is the
     * point of requesting downgrades that way, since the customer keeps what
     * they paid for - so `plan_id` and `polar_product_id` both still name the
     * OLD plan for the rest of the period. The console could therefore only
     * say "Pro, renews on the 4th" to somebody who had just downgraded, which
     * reads as a button that did nothing.
     *
     * Mapped from Polar's `pending_update` on the subscription. NULL is the
     * normal state: no change is scheduled.
     */
    scheduledPlanId: text("scheduled_plan_id"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subscriptions_granted_idx").on(t.grantedPlanId, t.planId)],
)

/**
 * Where a plan came from, and who is allowed to overwrite it.
 *
 * ⚠ THE DISCRIMINATOR IS A MECHANISM, NOT A LABEL. `catalog` plans are seeded
 * from configuration and reconciled destructively by a push - the file wins,
 * and anything edited by clicking is reverted. `custom` plans belong to one
 * tenant, are created through the dashboard for a specific deal, and a push
 * never touches them. The second is the only reason the first can safely be
 * destructive.
 */
export const planSource = core.enum("plan_source", ["catalog", "custom"])

/**
 * One line of what a plan grants, as stored.
 *
 * ⚠ THIS TYPE IS AN ASSERTION ABOUT JSON, NOT A GUARANTEE. `$type` is erased at
 * runtime and the column can hold anything a migration or a psql session put
 * there, so every read parses it - see `parseEntitlements` in
 * src/metering/postgres.ts. It mirrors `Entitlement` in `@repo/metering`, and it
 * is declared here rather than imported so the schema stays free of a
 * dependency that drizzle-kit would have to resolve.
 */
export type StoredEntitlement =
  | {
      /** Used up and replenished: emails. Has a reset cycle. */
      kind: "consumable"
      featureId: string
      allowance: number | "unlimited"
      overage: "billable" | "never"
      interval: "day" | "week" | "month" | "year" | "lifetime"
      intervalCount?: number
    }
  | {
      /**
       * Held persistently: domains, mailboxes, storage.
       *
       * ⚠ NO `interval`, AND THE UNION IS WHY RATHER THAN A COMMENT. A domain
       * does not refill. A shape that can carry a reset interval is one
       * somebody eventually sets, after which the limit silently scopes itself
       * to a window and every domain created before the boundary stops
       * counting.
       */
      kind: "continuous"
      featureId: string
      allowance: number | "unlimited"
      overage: "billable" | "never"
    }

/**
 * The plan catalogue, and the bespoke plans beside it.
 *
 * ⚠ THE ENTITLEMENTS ARE `jsonb` RATHER THAN A CHILD TABLE, AND THE REASON IS
 * THAT THEY ARE NEVER READ APART FROM THEIR PLAN. Autumn modelled these as
 * `product_items` rows because it carries a full pricing model - tiers, prices,
 * proration. Ours are four fields, always loaded as a set, and a child table
 * would buy a second RLS policy, a second index and a join on the hot path of
 * every quota check in exchange for nothing.
 *
 * ⚠ AND A PLAN IS NOT TENANT-SCOPED THE WAY EVERY OTHER TABLE HERE IS. A
 * catalogue row has `tenant_id IS NULL` and is readable by everyone; a custom
 * row is readable only by its owner. The policy in the migration says so, and
 * its WITH CHECK excludes NULL - so `i10_api` can create a bespoke plan for the
 * tenant it is scoped to, and can never create or alter a catalogue one. That
 * is the "the file is the source of truth" rule, enforced by the database
 * rather than by reviewers.
 */
export const plans = core.table(
  "plans",
  {
    /** `free`, `pro`, or something a sales deal produced. */
    id: text("id").primaryKey(),
    source: planSource("source").notNull(),

    /**
     * ⚠ NULL FOR A CATALOGUE PLAN, AND A CHECK CONSTRAINT TIES IT TO `source`.
     * The two ways to get this wrong are both silent: a custom plan with no
     * owner is invisible to the tenant it was built for, and a catalogue plan
     * with one is a price list only one customer can see.
     */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    entitlements: jsonb("entitlements").$type<StoredEntitlement[]>().notNull(),

    /**
     * Where this plan sits relative to the others. Higher is more.
     *
     * ⚠ AN EXPLICIT NUMBER, NOT AN INFERENCE FROM PRICE OR ALLOWANCE. Whether a
     * plan change is an upgrade decides how Polar prorates it - charged now, or
     * deferred to the period end - so the answer has to be one somebody chose.
     * Inferring it from the `emails` allowance breaks the moment a plan is
     * cheaper on volume and dearer on seats, and inferring it from price means
     * storing a price we deliberately do not own.
     *
     * ⚠ TIES ARE NOT UPGRADES. Two plans at the same rank are a sideways move,
     * which is neither charged nor deferred - see `directionOf`.
     */
    rank: integer("rank").notNull().default(0),

    /**
     * How long a message lives, in days: its row, its body, its events and its
     * attachments, all together (docs/decisions/storage.md). Free 3, Pro 30;
     * a custom plan sets its own.
     *
     * ⚠ EVERYTHING GOES, NOT JUST THE BODY, LIKE RESEND. A log that lists mail
     * whose content is gone is a log nobody can use, and keeping recipients
     * and subjects longer than bodies is keeping personal data for no reason.
     *
     * ⚠ NEVER BELOW `RECONCILE_LOOKBACK_DAYS` + 1. The billing reconcile counts
     * `core.messages` against the meter over that window; deleting inside it
     * turns every expired message into a false surplus. The job clamps it.
     */
    retentionDays: integer("retention_days").notNull().default(30),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("plans_tenant_idx").on(t.tenantId)],
)

/**
 * Which plan a tenant is on, and the clock their windows are measured from.
 *
 * ⚠ SEPARATE FROM `subscriptions`, BECAUSE AN ASSIGNMENT DOES NOT REQUIRE A
 * PAYMENT. `core.subscriptions` is our copy of what Polar says was bought;
 * this is what we actually entitle the tenant to. They agree for every ordinary
 * customer and must be able to differ for the ones that matter - an enterprise
 * on a bespoke plan, an account comped by support, our own internal tenant.
 * Folding this into `subscriptions` would mean inventing a fake Polar
 * subscription id to put anybody on a plan they did not buy.
 *
 * ⚠ ONE ROW PER TENANT. What they are entitled to today is a single question
 * with a single answer; the history of how they got there lives in Polar and in
 * the audit trail, which keep it properly.
 */
export const planAssignments = core.table("plan_assignments", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),

  planId: text("plan_id")
    .notNull()
    .references(() => plans.id),

  /**
   * ⚠ SET ONCE, AND NEVER MOVED BY A PLAN CHANGE. Every reset boundary for this
   * tenant is derived from it, so rewriting it re-buckets all of their history
   * - and re-anchoring on assignment would hand every customer a free reset:
   * exhaust the allowance, change plan, start a fresh window, repeat. The
   * upsert in src/metering/postgres.ts deliberately omits this column from its
   * DO UPDATE, which is where the rule is actually enforced.
   */
  anchor: timestamp("anchor", { withTimezone: true }).notNull(),

  /**
   * The customer's own switch: "keep going past my plan and bill me".
   *
   * ⚠ OFF BY DEFAULT, AND IT IS THE CUSTOMER'S TO SET. It is the whole
   * difference between "your sends stopped" and "you owe us twenty-seven
   * dollars you did not expect", and only one of those is a decision we are
   * entitled to make on somebody's behalf.
   *
   * ⚠ AND IT GRANTS NOTHING ON ITS OWN. Each entitlement says whether that
   * feature may be exceeded at all; this only turns it on where the plan
   * already permits it. A tenant with this set still cannot buy a fourth
   * domain, because nobody sells a fourth domain.
   */
  overageEnabled: boolean("overage_enabled").notNull().default(false),

  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * When the tenant moved onto its CURRENT plan. The free plan's first-send
   * windows never reach before it, so mail sent on Pro never counts against a
   * free day or month after a downgrade (packages/metering `planSince`).
   *
   * ⚠ MOVED BY A TRIGGER, ONLY WHEN `plan_id` ACTUALLY CHANGES (0080). Not
   * `updated_at`: that bumps on every re-grant, including a Polar webhook
   * redelivered for the plan the tenant already holds, and a free workspace
   * handed a fresh window by a replay is the reset this whole design refuses.
   */
  planSince: timestamp("plan_since", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * How much disk each tenant's mailboxes occupy, as last sampled.
 *
 * ⚠ A SAMPLE, NOT A LEDGER, AND THE DIFFERENCE IS THE WHOLE DESIGN. Storage is
 * a LEVEL that goes up and down - a deleted folder frees space - so it cannot
 * be accumulated from events the way sends are. There is exactly one row per
 * tenant and it is overwritten; the history, if it is ever wanted, is a
 * different table with a different retention.
 *
 * ⚠ AND IT IS OUR COPY OF SOMEBODY ELSE'S NUMBER. Stalwart computes it and owns
 * it. This exists so the quota check is an indexed local read rather than a
 * synchronous call to another service on a request path - see the note on
 * freshness in `sampledAt`.
 */
export const tenantStorage = core.table("tenant_storage", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),

  /**
   * ⚠ BYTES, NOT GIGABYTES, AND THE ALLOWANCE IS IN BYTES TOO. Rounding to GB
   * forces a choice between a ceiling - where one byte past ten gigabytes reads
   * as eleven and refuses - and a floor, which hands out up to a gigabyte free.
   * Neither is defensible on a cap, and `draw()` needs no rounding at all if
   * both sides are exact. The catalogue writes the byte figure and says the GB
   * equivalent in a comment.
   *
   * ⚠ `bigint`, BECAUSE A TERABYTE DOES NOT FIT IN AN `integer`. 2^31 bytes is
   * 2.1 GB - a limit some tenants would pass in their first month.
   */
  bytes: bigint("bytes", { mode: "number" }).notNull(),

  /**
   * When the figure was taken.
   *
   * ⚠ THE GATE READS A NUMBER THAT IS MINUTES OLD, ON PURPOSE. A mailbox quota
   * check at delivery time is Stalwart's own business and it does that itself,
   * exactly; ours is for plan limits and billing, where a synchronous call to
   * another service on the request path would put its availability inside ours
   * for no accuracy anyone can use.
   */
  sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The ledger: one row per unit of metered usage.
 *
 * ⚠ IT DUPLICATES A COUNT THAT `core.messages` ALREADY IMPLIES, AND THAT IS THE
 * POINT RATHER THAN AN OVERSIGHT. `send/reconcile.ts` exists to compare two
 * INDEPENDENTLY DERIVED numbers; deriving the meter from `core.messages` would
 * have it compare a number against itself, and a bad flush - from the send path
 * today, from a Durable Object at the edge later - would become undetectable.
 * The cost is a narrow row per message; the thing bought is the only mechanism
 * that can notice metering has gone wrong.
 *
 * ⚠ THE PRIMARY KEY DOES NOT INCLUDE `shard`, AND THAT IS DELIBERATE. Dedup is
 * on `(tenant_id, feature_id, event_id)` so that the same message cannot be
 * counted twice if it is ever replayed against a different shard than the one
 * that first recorded it. The shard is stored for attribution, not identity.
 *
 * ⚠ NOT PARTITIONED, UNLIKE `messages`. Its volume is the same but its
 * retention is not: message content ages out, and billing evidence is what a
 * disputed invoice is settled against. When this needs partitioning it wants
 * yearly bounds and a different retention job than the monthly one in 0002 -
 * a decision to make with a real row count rather than now.
 */
export const meterEvents = core.table(
  "meter_events",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** `emails`. The metered feature this unit was drawn from. */
    featureId: text("feature_id").notNull(),

    /**
     * ⚠ `messageId`, AND IT IS THE PROPERTY THE WHOLE DESIGN RESTS ON. The same
     * value keys the buffer entry at the edge, this row, and Polar's
     * `external_id`, which is what makes every leg independently retryable -
     * and being independently retryable is what makes buffering usage away from
     * this table safe at all.
     */
    eventId: text("event_id").notNull(),

    shard: integer("shard").notNull().default(0),

    /** Units consumed. One email is 1. */
    value: integer("value").notNull().default(1),

    /**
     * ⚠ THE `sent_at` THE DATABASE STORED, NOT THE RECORDING PROCESS'S CLOCK.
     * The reconciler buckets our side by `core.messages.sent_at` and the meter's
     * by this column; a millisecond of disagreement across a boundary shows a
     * deficit in one window and a surplus in the next, and tops the deficit up
     * on every run forever.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),

    /** When we wrote it. The gap from `occurred_at` is the flush lag. */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * When this unit reached Polar's meter. NULL until it has.
     *
     * ⚠ IT IS A WATERMARK PER ROW, NOT A GLOBAL ONE, AND THAT IS WHAT MAKES THE
     * FLUSH RESUMABLE. A "last shipped at" timestamp would be wrong the moment a
     * late-arriving event lands behind it - the row would be skipped forever,
     * silently, and the customer would be under-billed with nothing to notice
     * it. Per row, an interrupted flush simply finds the same rows next time.
     *
     * ⚠ AND IT IS SET ONLY AFTER POLAR ANSWERS. Marking first and posting after
     * loses usage on any failure; posting first and marking after can only
     * re-send, which `external_id` makes free.
     */
    ingestedAt: timestamp("ingested_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.featureId, t.eventId] }),
    // The gate's only read: one tenant, one feature, one shard, one window.
    index("meter_events_window_idx").on(t.tenantId, t.featureId, t.shard, t.occurredAt),
  ],
)

/**
 * Where each `first_use` meter window currently starts (packages/metering,
 * `start: "first_use"`): the free plan's daily 100 and the tier's month.
 *
 * ⚠ A CACHE OF THE LEDGER, NOT A SECOND LEDGER. A window starts at the first
 * `meter_events` row after the previous window ended; this only saves walking
 * the ledger from the beginning on every check. Losing it costs nothing but a
 * look back one interval, which is exactly what a first read does.
 *
 * ⚠ IT ONLY MOVES FORWARD. Two checks racing to open the same window compute
 * the same start from the same ledger, and the upsert refuses to move it back.
 */
export const meterWindows = core.table(
  "meter_windows",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    featureId: text("feature_id").notNull(),
    shard: integer("shard").notNull().default(0),
    /** `<interval>:<intervalCount>`, e.g. `day:1`. */
    windowId: text("window_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.featureId, t.shard, t.windowId] }),
    // Inline rather than `tenantPolicy`, which is declared further down.
    pgPolicy("meter_windows_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * The two routing inputs that are configuration rather than rows.
 *
 * ⚠ A PROJECTION OF THE ENVIRONMENT, NOT A SECOND SOURCE OF TRUTH. `SES_ENABLED`
 * and `METERING_FREE_PLAN_ID` are authored in Doppler and read from `env` by the
 * API and the worker; this row is a copy the API upserts at boot. It exists for
 * one reader that cannot see our pods' environment: the `core.mailbox_route`
 * function Stalwart calls to decide where a mailbox domain's human mail goes.
 *
 * ⚠ WITHOUT IT THE KILL SWITCH WOULD ONLY MOVE HALF THE MAIL. `SES_ENABLED` is
 * thrown during an incident and the transactional path honours it immediately;
 * mailbox mail is routed inside Stalwart, which would keep relaying to the thing
 * that is down. "One rule, three readers" has to include the reader that lives
 * in another process.
 */
export const routingSettings = core.table("routing_settings", {
  /**
   * ⚠ ONE ROW, ENFORCED BY THE KEY. A second would give the function two answers
   * and a `limit 1` would pick one of them silently.
   */
  id: boolean("id").primaryKey().default(true),

  /** Mirrors `SES_ENABLED`. */
  sesEnabled: boolean("ses_enabled").notNull().default(true),

  /**
   * Whether SES's SMTP endpoint is configured as a relay for mailbox mail.
   *
   * ⚠ A SECOND SWITCH, AND NOT A DUPLICATE OF THE FIRST. The transactional route
   * uses the SES API; mailbox mail can only use SES SMTP, because Stalwart's
   * outbound has no HTTP hook. Different credentials, which can exist
   * independently - so one flag cannot govern both.
   *
   * ⚠ DEFAULTS FALSE SO THE MIGRATION MOVES NO MAIL. i10.tech is on `pro` and
   * hosts mailboxes, so a default of true would silently put our own human mail
   * onto a relay with no credentials behind it.
   */
  sesRelayEnabled: boolean("ses_relay_enabled").notNull().default(false),

  /** Mirrors `METERING_FREE_PLAN_ID`. */
  freePlanId: text("free_plan_id").notNull().default("free"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// ─────────────────────────────────────────────────────────────────────────────
// Marketing mail.
//
// ⚠ THE MODEL IS CONTACTS + SEGMENTS + TOPICS, NOT "AUDIENCES", AND THE
// DIFFERENCE IS NOT COSMETIC. The obvious shape - a list, with people on it -
// makes the same person a different row on every list, which means unsubscribing
// them once unsubscribes them from one list, and a CSV re-import quietly
// resurrects them on the others. A contact is therefore GLOBAL to a tenant and
// unique by address; a segment is a grouping of contacts; and a topic is the
// thing the RECIPIENT sees and controls.
//
// ⚠ A SEGMENT IS INTERNAL AND A TOPIC IS PUBLIC, AND CONFLATING THEM IS A
// COMPLIANCE BUG. "Customers who bought in Q3" is a segment: the recipient must
// never see it, and it is not something they can opt out of. "Product updates"
// is a topic: it appears on their preference page and their choice about it is
// binding. One table for both would either leak internal targeting to
// recipients or make their preferences unenforceable.
//
// ⚠ AND A BROADCAST FANS OUT INTO ORDINARY MESSAGES. One row in `core.messages`
// per recipient, on the `bulk` queue, carrying the broadcast's id - so metering,
// suppression, DKIM, the event ingest, webhooks and the delivery log are the
// code that already exists and is already in production. A parallel sending path
// for marketing mail would be a second answer to "did this deliver", and the two
// would disagree the first time an event arrived late.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A person a tenant can send marketing mail to. Global to the tenant.
 *
 * ⚠ UNIQUE BY ADDRESS PER TENANT, WHICH IS THE WHOLE POINT. The same person on
 * "Product updates" and "Beta testers" is ONE row with two segment memberships,
 * so unsubscribing them is one write that holds everywhere.
 *
 * ⚠ `unsubscribed` IS GLOBAL AND IS NOT THE SAME AS A TOPIC PREFERENCE. True
 * here means "send me no marketing at all" and overrides every topic; a topic
 * preference is the finer-grained control underneath it. Reading only one of the
 * two is how somebody who unsubscribed from everything still receives a
 * newsletter.
 *
 * ⚠ AND NEITHER IS `core.suppressions`. Unsubscribing from a newsletter must not
 * stop a password reset, and a hard bounce on a transactional message must not
 * silently remove somebody from a list they can still be reached on. Three
 * questions, three places, all consulted at send.
 */
export const contacts = core.table(
  "contacts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** ⚠ STORED LOWERCASED. The unique index below is on the stored value. */
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),

    unsubscribed: boolean("unsubscribed").notNull().default(false),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),

    /**
     * Custom merge fields, keyed by `contact_properties.key`.
     *
     * ⚠ A JSONB BAG RATHER THAN A COLUMN PER PROPERTY, because the keys are the
     * customer's and are created at runtime. The `contact_properties` table
     * below is what gives them a declared type and a fallback - without it this
     * column is a free-for-all where `plan` is the string "3" for one contact
     * and the number 3 for the next, and a template renders one of them wrong.
     */
    properties: jsonb("properties").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contacts_tenant_email_uq").on(t.tenantId, t.email),
    index("contacts_tenant_idx").on(t.tenantId, t.createdAt),
  ],
)

export const propertyType = core.enum("property_type", ["string", "number", "boolean"])

/**
 * A declared custom field on a contact.
 *
 * ⚠ THE DECLARATION IS WHAT MAKES A FALLBACK POSSIBLE, AND A FALLBACK IS WHAT
 * STOPS "Hi {{first_name}}," GOING OUT AS "Hi ,". A template references a key;
 * the contacts who have no value for it are the majority on any real import.
 * Without a declared default the choice is between rendering an empty string and
 * refusing to send.
 */
export const contactProperties = core.table(
  "contact_properties",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠ CASE-SENSITIVE, AND THE UNIQUE INDEX BELOW IS TOO. `plan` and `Plan`
     * are two properties. That is surprising, and the alternative is worse: a
     * case-insensitive key means a CSV import with both spellings silently
     * merges two columns of different data into one field.
     */
    key: text("key").notNull(),
    type: propertyType("type").notNull().default("string"),
    /** Rendered when a contact has no value. Stored as text; cast on read. */
    fallbackValue: text("fallback_value"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contact_properties_tenant_key_uq").on(t.tenantId, t.key)],
)

/**
 * An internal grouping of contacts. Never visible to a recipient.
 *
 * ⚠ STATIC MEMBERSHIP, NOT A STORED QUERY, AND THAT IS A DELIBERATE FIRST
 * VERSION. A rule-based segment ("everyone who opened in the last 30 days") has
 * to be evaluated at send time against the event log, which makes a broadcast's
 * recipient list unreproducible after the fact - somebody asks "why did she get
 * this" and the answer is "she matched at 09:04". Explicit membership is
 * auditable, and a rules engine can be added later as a thing that WRITES
 * membership rather than replaces it.
 */
export const segments = core.table(
  "segments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("segments_tenant_idx").on(t.tenantId, t.createdAt)],
)

export const segmentContacts = core.table(
  "segment_contacts",
  {
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /**
     * ⚠ DENORMALISED ONTO THE JOIN TABLE SO RLS IS A PLAIN EQUALITY. Every other
     * policy in `core` compares one column to `app.tenant_id`; a join table
     * without its own `tenant_id` would need a policy that joins to `segments`,
     * which is itself under RLS - evaluated per row, on the table that grows
     * fastest here.
     */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.contactId] }),
    index("segment_contacts_contact_idx").on(t.contactId),
    index("segment_contacts_tenant_idx").on(t.tenantId),
  ],
)

export const topicDefault = core.enum("topic_default", ["opt_in", "opt_out"])
export const topicVisibility = core.enum("topic_visibility", ["private", "public"])

/**
 * A kind of email a recipient can choose to receive or not.
 *
 * ⚠ THIS IS THE RECIPIENT'S SURFACE, NOT THE SENDER'S. It appears on the
 * preference page behind every unsubscribe link, and a person's answer to it is
 * binding on us. That is why it is a different table from `segments` - see the
 * block comment above.
 *
 * ⚠ `default_subscription` IS IMMUTABLE ONCE SET, AND THE APPLICATION ENFORCES
 * IT. Flipping a topic from opt-out to opt-in would retroactively subscribe
 * every contact who had simply never answered - which is sending marketing mail
 * to people who did not ask, at scale, because of a dropdown.
 */
export const topics = core.table(
  "topics",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    defaultSubscription: topicDefault("default_subscription")
      .notNull()
      .default("opt_in"),
    visibility: topicVisibility("visibility").notNull().default("public"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("topics_tenant_idx").on(t.tenantId, t.createdAt)],
)

/**
 * A contact's explicit answer about one topic.
 *
 * ⚠ A ROW HERE MEANS THEY CHOSE; ITS ABSENCE MEANS THEY HAVE NOT. That is why
 * `subscribed` is NOT NULL and the row is optional, rather than a nullable
 * column on a row that always exists. The default comes from the topic, and
 * "never asked" has to stay distinguishable from "said yes" - otherwise
 * switching a topic's default silently rewrites people's stated preferences.
 */
export const contactTopics = core.table(
  "contact_topics",
  {
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    subscribed: boolean("subscribed").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.topicId] }),
    index("contact_topics_topic_idx").on(t.topicId),
    index("contact_topics_tenant_idx").on(t.tenantId),
  ],
)

export const broadcastStatus = core.enum("broadcast_status", [
  "draft",
  "scheduled",
  /** Fan-out in progress. Some recipients have messages, some do not yet. */
  "sending",
  "sent",
  "canceled",
])

/**
 * One marketing send to one segment.
 *
 * ⚠ IT HOLDS THE CONTENT, NOT THE DELIVERY. Once fan-out starts, what happened
 * lives in `core.messages` and `core.message_events` like every other email,
 * joined back by `broadcast_id`. The counters a person sees on the broadcast
 * page are aggregates over those, computed on read - a denormalised
 * `delivered_count` would be wrong within a day, because events arrive for hours
 * after a send, and nothing would ever recompute it to disagree.
 */
export const broadcasts = core.table(
  "broadcasts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠ `set null`, NOT `cascade`. Deleting a segment must not delete the record
     * of a broadcast already sent to it - that record is what a customer needs
     * when somebody asks why they received an email.
     */
    segmentId: uuid("segment_id").references(() => segments.id, {
      onDelete: "set null",
    }),
    /** Which topic's preferences this send respects. Null means every contact. */
    topicId: uuid("topic_id").references(() => topics.id, { onDelete: "set null" }),

    name: text("name").notNull(),
    fromAddress: text("from_address").notNull(),
    replyTo: text("reply_to")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text("subject").notNull(),
    previewText: text("preview_text"),
    html: text("html"),
    text: text("text"),

    status: broadcastStatus("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),

    /** How many contacts the fan-out resolved to. Written once, at fan-out. */
    recipientCount: integer("recipient_count"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("broadcasts_tenant_idx").on(t.tenantId, t.createdAt)],
)

/**
 * How a template's versions are written.
 *
 *   html  hand-written HTML with `{{ name }}` placeholders, edited in the console
 *   tsx     a React Email component, uploaded or pushed, rendered once per
 *           version in the sandbox (services/template-renderer)
 *   visual  made in the React Email editor (#162, #243): its draft is the
 *           editor's TipTap JSON (`design`), and a version is made from the
 *           HTML the editor exports, exactly as for `html` - no sandbox
 */
export const templateKind = core.enum("template_kind", ["html", "tsx", "visual"])

/**
 * Where a template is maintained, which is a different question from what its
 * versions are made of (#234):
 *
 *   managed  written in the dash's editor, versioned by publishing
 *   upload   uploaded `.tsx` files, versioned by each upload
 *   github   a connected repository, versioned by each push to its target
 *            branch (#235)
 *
 * ⚠ IT DECIDES WHO MAY MAKE A VERSION. A folder upload never overwrites a
 * managed or GitHub template that happens to share a name; the repository is
 * the only thing that versions a GitHub one.
 */
export const templateSource = core.enum("template_source", [
  "managed",
  "upload",
  "github",
])

/**
 * A folder a workspace keeps templates in, as Resend has them.
 *
 * ⚠ A ROW, NOT A LABEL ON EACH TEMPLATE. Folders used to be a text column on
 * `templates`, which cannot hold an EMPTY folder - and making one before
 * filling it is exactly how people organise. A row also gives a folder an id
 * the URL can carry and a name that can change without touching its templates.
 *
 * ⚠ FLAT. One level, like Resend's; an upload's `transactional/auth` directory
 * becomes a folder named exactly that.
 */
export const templateFolders = core.table(
  "template_folders",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("template_folders_tenant_name_uq").on(t.tenantId, t.name),
    // Inline rather than `tenantPolicy`, which is declared further down.
    pgPolicy("template_folders_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * A variable a template declares in the editor, as Resend's "Create variable"
 * makes one: its name, its type, and the value a send gets when it leaves the
 * variable out. Without a fallback, leaving it out refuses the send.
 */
export interface DeclaredVariable {
  name: string
  type: "string" | "number"
  fallback: string | null
}

/**
 * A reusable email, referenced by id or by name from a send (#160, #161).
 *
 * ⚠ THIS ROW IS THE TEMPLATE'S IDENTITY AND ITS DRAFT; WHAT A SEND USES IS A
 * VERSION. Versions (`template_versions`) are immutable, and `live_version_id`
 * says which one an unpinned send gets. Editing the draft changes nothing that
 * is going out; publishing creates a version and makes it live.
 */
export const templates = core.table(
  "templates",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Unique in the workspace, and the alias a send may use instead of the id. */
    name: text("name").notNull(),
    /**
     * What people call it, as Resend shows a template: "Password reset" over
     * the alias `password-reset`. Null shows the alias.
     *
     * ⚠ SEPARATE FROM `name` SO RENAMING NEVER BREAKS A SEND. Code sends by
     * the alias; the title can change as often as anybody likes.
     */
    title: text("title"),
    /**
     * The folder it is filed in, or null for the top level.
     *
     * ⚠ SET NULL, NOT CASCADE. Deleting a folder must never delete templates
     * production code is sending by id; they move to the top level.
     */
    folderId: uuid("folder_id").references(() => templateFolders.id, {
      onDelete: "set null",
    }),
    kind: templateKind("kind").notNull().default("html"),
    source: templateSource("source").notNull().default("managed"),

    /** The draft subject, with `{{ name }}` placeholders. Copied into each version. */
    subject: text("subject"),
    /**
     * The draft's default sender and reply-to, as Resend's templates have them.
     * Copied into each version; a send's own `from` and `reply_to` win.
     */
    from: text("from"),
    replyTo: text("reply_to").array(),
    /** The inbox preview line. Copied into each version. */
    previewText: text("preview_text"),
    /** Variables declared in the editor, with their fallbacks. */
    variables: jsonb("variables").$type<DeclaredVariable[]>(),
    /** The draft body of an `html` template. Unused by `tsx`, whose source is a version's. */
    html: text("html"),
    text: text("text"),
    /**
     * A `visual` template's draft as the editor's TipTap JSON (#243): what the
     * editor opens. `html` and `text` beside it are what the editor exported
     * from it, and what publishing makes a version from.
     */
    design: jsonb("design").$type<Record<string, unknown>>(),

    /**
     * The connected repository a `github` template lives in (#235), and its
     * entry file's path under the repository's template directory. Together
     * they are the template's identity for a push: a file renamed in the
     * repository is a new template, a file moved back is the same one.
     *
     * ⚠ SET NULL, NOT CASCADE, WHEN THE CONNECTION GOES. Disconnecting a
     * repository must never delete templates production code is sending by
     * id; they become uploads, and keep every version.
     */
    githubRepositoryId: uuid("github_repository_id").references(
      (): AnyPgColumn => githubRepositories.id,
      { onDelete: "set null" },
    ),
    path: text("path"),
    /**
     * When a push no longer had this template's file. The template keeps its
     * live version and keeps sending; the console says it is gone upstream.
     */
    removedAt: timestamp("removed_at", { withTimezone: true }),

    /**
     * The version an unpinned send renders. Null until the first publish.
     *
     * ⚠ THE ONLY MUTABLE THING ABOUT WHAT A SEND RENDERS, and so the only thing
     * a cache in front of the send path (which will live at Cloudflare) has to
     * expire. Everything it points at is immutable.
     */
    liveVersionId: uuid("live_version_id").references(
      (): AnyPgColumn => templateVersions.id,
      { onDelete: "set null" },
    ),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("templates_tenant_idx").on(t.tenantId, t.createdAt),
    uniqueIndex("templates_tenant_name_uq").on(t.tenantId, t.name),
    uniqueIndex("templates_github_path_uq")
      .on(t.githubRepositoryId, t.path)
      .where(sql`${t.githubRepositoryId} is not null`),
  ],
)

/**
 * One immutable version of a template: the email as it was rendered ONCE.
 *
 * ⚠ `html` AND `text` ARE A SKELETON, NOT A SOURCE. Every variable in them is a
 * marker (`⟦i10<nonce>_<n>⟧`, see @repo/templates), and a send fills the
 * markers by substitution. For a `tsx` version the skeleton is what the
 * sandbox rendered when the version was created; customer code never runs
 * again after that, and never on the send path. See docs/decisions/templates.md.
 *
 * ⚠ NEVER UPDATED. A version is what went out for every send that named it -
 * `message_bodies.template_version_id` points here - so changing one would
 * rewrite history. Publishing creates a new row.
 */
export const templateVersions = core.table(
  "template_versions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    /** 1, 2, 3 … per template. What a send pins with `version`. */
    number: integer("number").notNull(),
    kind: templateKind("kind").notNull(),

    subject: text("subject"),
    /**
     * The sender and reply-to a send gets when it names none (Resend's
     * template defaults). Null means the send must give its own.
     */
    from: text("from"),
    replyTo: text("reply_to").array(),
    /** The inbox preview line the version was published with, for reopening it. */
    previewText: text("preview_text"),
    html: text("html"),
    text: text("text"),
    /** The markers' nonce. Random per version. */
    nonce: text("nonce").notNull(),
    /**
     * `[{ path, preview, fallback? }]` - what a send must provide, in marker
     * order. A variable with a `fallback` may be left out of a send.
     */
    variables: jsonb("variables")
      .notNull()
      .$type<{ path: string; preview: string; fallback?: string }[]>(),

    /**
     * The entry `.tsx`, kept per version (#161). The skeleton is what sends
     * use; the source is what somebody reads to understand it, and a connected
     * repository can be deleted or force-pushed out from under us.
     */
    source: text("source"),
    /**
     * The rest of the template's files: everything the entry imports by
     * relative path, path to text (#234). Null for a template of one file.
     */
    files: jsonb("files").$type<Record<string, string>>(),
    /** The entry's path in the upload or the repository. */
    path: text("path"),
    /** The commit a GitHub template's version was made from (#235). */
    commitSha: text("commit_sha"),
    /** A `visual` version's TipTap JSON, so any version can be reopened (#243). */
    design: jsonb("design").$type<Record<string, unknown>>(),
    /**
     * A hash of the entry and all of its files, which is how an upload or a
     * push of an unchanged template is recognised and makes no new version.
     */
    sourceSha256: text("source_sha256"),
    /** Which React and React Email rendered it, e.g. `react@19.2.8+…+react-email@6.9.3`. */
    runtime: text("runtime"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("template_versions_number_uq").on(t.templateId, t.number),
    index("template_versions_tenant_idx").on(t.tenantId, t.createdAt),
    // Inline rather than `tenantPolicy`, which is declared further down.
    pgPolicy("template_versions_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * A GitHub App installation a workspace connected (#235).
 *
 * ⚠ ONE WORKSPACE PER INSTALLATION, and only after proof. The setup redirect's
 * `installation_id` is a URL parameter anybody can edit; it is accepted only
 * when the signed-in person's own GitHub token lists it (see github/connect.ts).
 * A second workspace claiming the same installation is refused, so a push is
 * never versioned into somebody else's templates.
 */
export const githubInstallations = core.table(
  "github_installations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" })
      .notNull()
      .unique("github_installations_installation_uq"),
    /** The user or organization it is installed on, e.g. `acme`. */
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    pgPolicy("github_installations_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * A repository whose templates a workspace keeps in GitHub (#235).
 *
 * ⚠ A PUSH TO `target_branch` GOES LIVE. What is merged there is, from then
 * on, what customers receive; every other branch is only compiled and
 * reported on the commit.
 */
export const githubRepositories = core.table(
  "github_repositories",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" })
      .notNull()
      .references(() => githubInstallations.installationId, { onDelete: "cascade" }),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    /** `owner/name`, as of the last event: repositories are renamed. */
    fullName: text("full_name").notNull(),
    targetBranch: text("target_branch").notNull().default("main"),
    /** The templates' root in the repository. Empty for the repository's root. */
    directory: text("directory").notNull().default("emails"),
    lastCommitSha: text("last_commit_sha"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** Set when the installation lost access to the repository. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("github_repositories_tenant_repo_uq").on(t.tenantId, t.repoId),
    index("github_repositories_repo_idx").on(t.repoId),
    pgPolicy("github_repositories_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

export const githubSyncStatus = core.enum("github_sync_status", [
  "pending",
  "running",
  "done",
  "failed",
])

/**
 * One sync of a repository at one commit (#235): what a push, a connect or a
 * manual resync asked for, and what happened to each template.
 *
 * ⚠ WRITTEN BEFORE THE WORK STARTS. The webhook answers GitHub at once and the
 * sync runs after; a deploy in between would lose it, so the row is the
 * promise, and a periodic sweep picks up any that were left pending.
 */
export const githubSyncs = core.table(
  "github_syncs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => githubRepositories.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    status: githubSyncStatus("status").notNull().default("pending"),
    /** `[{ path, name, outcome, version?, problems? }]`, as an upload answers. */
    outcomes: jsonb("outcomes").$type<Record<string, unknown>[]>(),
    /** Problems with the set as a whole, or why the sync could not run. */
    problems: jsonb("problems").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("github_syncs_repository_idx").on(t.repositoryId, t.createdAt),
    index("github_syncs_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.status} in ('pending', 'running')`),
    pgPolicy("github_syncs_tenant", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

// ─────────────────────────────────────────────────────────────────────────────
// Console state: what the dashboard needs to remember that is not the product.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far through onboarding a tenant is.
 *
 * ⚠ THIS DECIDES WHERE WE SEND SOMEBODY, NEVER WHERE THEY MAY GO. `/onboarding`
 * is a route anyone can open at any time - see docs/decisions/console.md - and
 * this row only answers "should the console redirect them there on arrival".
 * A flag that gated access would make re-running the flow after an upgrade
 * impossible, which is the exact thing it is required to support.
 *
 * ⚠ `last_onboarded_plan` IS WHAT MAKES "RE-RUN ON UPGRADE FROM FREE" WORK
 * WITHOUT RE-RUNNING ON EVERY UPGRADE. The rule is: re-run when the plan changed
 * AND the plan we last onboarded on was the free one. A boolean would force a
 * choice between never re-running and re-running on pro → scale, and the second
 * is an insult to somebody who just paid us more.
 */
export const onboarding = core.table("onboarding", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),

  /** The step last reached. A string, not an int - see the console's STEPS. */
  step: text("step").notNull().default("workspace"),

  /**
   * ⚠ SET WHEN THE FLOW IS FINISHED *OR* SKIPPED, AND THE TWO ARE NOT
   * DISTINGUISHED ON PURPOSE. Both mean "stop redirecting me". Whether somebody
   * completed step 4 is answerable from the things themselves - do they have a
   * verified domain, do they have a key - and those answers stay true when this
   * row is wrong.
   */
  completedAt: timestamp("completed_at", { withTimezone: true }),

  /** The plan in force when `completed_at` was last set. See above. */
  lastOnboardedPlan: text("last_onboarded_plan"),

  /** Free-text, from step 1. Product research, never logic. */
  useCase: text("use_case"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A customer's credential for their own DNS provider.
 *
 * ⚠ THE SECRET IS SEALED WITH THE SAME KEY AND THE SAME ENVELOPE AS A WEBHOOK
 * SIGNING SECRET (`webhook_endpoints.secret_ciphertext`), and it is never
 * returned by any route. A DNS API token is the most dangerous credential this
 * product stores: it can rewrite a customer's MX records and take delivery of
 * their mail. It is written once, read only by the record writer, and the
 * console sees a label and a timestamp.
 *
 * ⚠ AND THE SCOPE IS THE ZONE, NOT THE ACCOUNT, WHEREVER THE PROVIDER ALLOWS IT.
 * Cloudflare and Route 53 can both restrict to one zone; the connect flow asks
 * for that and says why. Where a provider only issues account-wide credentials
 * the UI says so plainly rather than implying a narrower blast radius than
 * exists - see `ProviderApi.zoneScoped` in @repo/dns-providers.
 *
 * ⚠ NOTHING WRITES THIS TABLE YET, AND THAT IS KNOWN RATHER THAN OVERLOOKED.
 * The console's "Connect <provider>" button is rendered disabled and labelled
 * `soon` - deliberately, because the capability is real and the adapters are
 * the next piece of work - and `@repo/dns-providers` already carries the per-
 * provider facts those adapters need. It is here now because it arrives with
 * the RLS policy and the `tenant_id` cascade that 0037 applies to all eleven
 * console tables in one place; adding the only table that handles a
 * zone-rewriting credential in a later, separate migration is how one ends up
 * without a policy. If the connect flow is abandoned, drop it - an empty table
 * is not free, it is a thing every future reader has to ask about.
 */
export const dnsConnections = core.table(
  "dns_connections",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** The registry slug. See packages/dns-providers. */
    provider: text("provider").notNull(),

    /** What the customer called it. Shown in the console; never a secret. */
    label: text("label"),

    /**
     * ⚠ THE WHOLE CREDENTIAL, SEALED. Some providers need two parts (a key and a
     * secret, or a key id and a region), so this is a sealed JSON object rather
     * than a sealed string - otherwise the second provider to need two fields
     * forces a migration.
     */
    credentialSealed: text("credential_sealed").notNull(),

    /** Which zones this credential was proven to reach, at connect time. */
    zones: text("zones")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  /*
   * ⚠ UNIQUE, AND IT HAS TO BE: `save()` UPSERTS ON THIS EXACT PAIR. A plain
   * index satisfies the lookup but NOT `ON CONFLICT ("tenant_id","provider")`,
   * which Postgres refuses with 42P10 - "no unique or exclusion constraint
   * matching the ON CONFLICT specification". So every insert this table has
   * ever received failed, and the table has never held a row.
   *
   * ⚠ IT WAS INVISIBLE BECAUSE NOTHING EVER GOT THIS FAR. The OAuth exchange
   * was being challenged before a credential existed to store, so the first
   * authorisation that actually succeeded is the one that found this.
   *
   * ⚠ AND UNIQUENESS IS THE MODEL, NOT JUST THE MECHANISM. Re-authorising
   * REPLACES a connection - two live tokens for one account is two things to
   * revoke and only one that anybody remembers - and `get()` reads one row per
   * provider. See dns/connections.ts.
   */
  (t) => [uniqueIndex("dns_connections_tenant_idx").on(t.tenantId, t.provider)],
)

/**
 * The API request log behind the console's Logs page.
 *
 * ⚠ IT RECORDS THE ENVELOPE AND NEVER THE BODY. A request body on this API
 * contains the customer's mail - subject lines, recipients, and the HTML of
 * whatever they sent. Keeping it would turn an operational log into a copy of
 * every email the platform has ever carried, retained under a policy nobody
 * wrote, readable by anyone who can read logs. Method, path, status, duration
 * and the key that was used answer every question this page exists to answer.
 *
 * ⚠ AND IT IS NOT PARTITIONED, WHICH IS A DECISION WITH AN EXPIRY DATE.
 * `core.messages` is partitioned because it is the product; this is a 30-day
 * operational window swept on a schedule. When request volume makes the sweep
 * expensive it becomes partitioned like its neighbour - the index below is
 * already ordered to make that a mechanical change.
 */
export const apiRequests = core.table(
  "api_requests",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Null for a request that failed before a key resolved. */
    apiKeyId: uuid("api_key_id"),

    method: text("method").notNull(),
    /** ⚠ THE ROUTE PATTERN, NOT THE URL. `/emails/{id}`, never the message id. */
    path: text("path").notNull(),
    status: integer("status").notNull(),
    durationMs: integer("duration_ms").notNull(),

    /** The error `name` from the response envelope, when there was one. */
    errorName: text("error_name"),

    /**
     * ⚠ TRUNCATED TO A PREFIX. A user agent is unbounded and attacker-
     * controlled; 200 characters identifies an SDK and a version, which is the
     * question somebody is actually asking ("is this the old client?").
     */
    userAgent: text("user_agent"),

    /**
     * Where the call came from, from Cloudflare's headers (#170).
     *
     * ⚠ RECORDED FOR ONE QUESTION: IS THIS KEY BEING USED FROM PLACES ITS OWNER
     * IS NOT. A key called from three countries in a day has usually leaked.
     * Kept only as long as the log itself (30 days), which is inside the 90
     * days docs/decisions/risk.md allows for a raw IP.
     */
    clientIp: text("client_ip"),
    country: text("country"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_requests_tenant_idx").on(t.tenantId, t.occurredAt)],
)

// ─────────────────────────────────────────────────────────────────────────────
// Risk (#170). See docs/decisions/risk.md for the whole design.
// ─────────────────────────────────────────────────────────────────────────────

/** How worried the score is. The thresholds are `bandFor` in risk/engine.ts. */
export const riskBand = core.enum("risk_band", ["low", "elevated", "high", "critical"])

/**
 * What a hold stops. `api` is every send through our pipeline; `all` also
 * stops the workspace's mailboxes, and only staff may set it.
 */
export const holdScope = core.enum("hold_scope", ["api", "all"])

/** The same tenant policy every other `core` table carries, written once. */
const tenantPolicy = (name: string, tenantId: AnyPgColumn) =>
  pgPolicy(name, {
    for: "all",
    using: sql`${tenantId} = current_setting('app.tenant_id')::uuid`,
    withCheck: sql`${tenantId} = current_setting('app.tenant_id')::uuid`,
  })

/**
 * A workspace's current risk assessment, one row per workspace.
 *
 * ⚠ THE CURRENT ANSWER, NOT THE HISTORY. It is rewritten by every run so the
 * console and staff read one row; `risk_assessment_events` keeps every move
 * that mattered. `contributions` is the explanation - rule id, points,
 * category and the evidence numbers - and it is what an appeal is argued from.
 *
 * ⚠ THE ACTION STATE LIVES HERE TOO. What the score did to SES's policy and
 * when, and the cut-off a staff release set, have to survive the next run,
 * and this is the one row every run reads first.
 */
export const riskAssessments = core.table(
  "risk_assessments",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    band: riskBand("band").notNull(),
    /** Which rules produced it. See `RULESET_VERSION` in risk/rules.ts. */
    rulesetVersion: integer("ruleset_version").notNull(),
    contributions: jsonb("contributions").notNull(),
    /** The model's probability when a model was consulted; null otherwise. */
    modelScore: real("model_score"),
    /** When the band last changed. Hysteresis reads it. */
    bandSince: timestamp("band_since", { withTimezone: true }).notNull().defaultNow(),
    /**
     * ⚠ SET BY A STAFF RELEASE OR PIN. Until then the score may not hold, demote
     * or tighten this workspace unless a `fresh` rule fires on evidence newer
     * than `cleared_at`.
     */
    autoActionsPausedUntil: timestamp("auto_actions_paused_until", {
      withTimezone: true,
    }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    /** The SES reputation policy the score last set, and when. */
    sesPolicy: text("ses_policy"),
    sesPolicySetAt: timestamp("ses_policy_set_at", { withTimezone: true }),
    /** When staff were last alerted about this workspace's band. */
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [tenantPolicy("risk_assessments_tenant", t.tenantId)],
)

/**
 * Every assessment that mattered: a band change, a move of ten points or more,
 * or an action taken. Append-only.
 */
export const riskAssessmentEvents = core.table(
  "risk_assessment_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    band: riskBand("band").notNull(),
    fromBand: riskBand("from_band"),
    rulesetVersion: integer("ruleset_version").notNull(),
    contributions: jsonb("contributions").notNull(),
    /** What the run did: `tier:strict`, `hold`, `ses:strict`, `alert`, ... */
    actions: text("actions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** What woke the run: `hourly`, `ses-event`, `farm-tripwire`, `staff`, ... */
    trigger: text("trigger").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("risk_assessment_events_tenant_idx").on(t.tenantId, t.occurredAt),
    tenantPolicy("risk_assessment_events_tenant", t.tenantId),
  ],
)

/**
 * A workspace whose sending is held (#170).
 *
 * ⚠ ONE ROW PER HELD WORKSPACE, READ ON EVERY SEND. `accept()` refuses a held
 * workspace before anything is written, so this has to be a primary-key
 * lookup; no row means not held. A release deletes the row and writes the
 * event - the history is `sending_hold_events`.
 *
 * ⚠ NOT `tenants.status` AND NOT AN SES PAUSE. See docs/decisions/risk.md:
 * the first is a billing field nothing enforces, and releasing the second
 * puts SES in a grace state that ignores the tenant's findings.
 */
export const sendingHolds = core.table(
  "sending_holds",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    scope: holdScope("scope").notNull().default("api"),
    /** `score` or `staff`. */
    source: text("source").notNull(),
    /** For staff and appeals: the whole reason. */
    reason: text("reason").notNull(),
    /** For the customer: a category, never a threshold. */
    category: text("category").notNull(),
    setBy: text("set_by").notNull(),
    heldAt: timestamp("held_at", { withTimezone: true }).notNull().defaultNow(),
    /** ⚠ A HUMAN MUST LOOK BY THEN (GDPR Article 22). The hourly run alerts. */
    reviewDueAt: timestamp("review_due_at", { withTimezone: true }).notNull(),
    reviewAlertedAt: timestamp("review_alerted_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    /** How many queued or scheduled messages the hold canceled. */
    canceledMessages: integer("canceled_messages").notNull().default(0),
  },
  (t) => [tenantPolicy("sending_holds_tenant", t.tenantId)],
)

/** Every hold and release, append-only. `action` is `hold` or `release`. */
export const sendingHoldEvents = core.table(
  "sending_hold_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    scope: holdScope("scope").notNull(),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    category: text("category"),
    setBy: text("set_by").notNull(),
    /** On a release: staff's verdict, `false_positive` or `resolved`. */
    outcome: text("outcome"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sending_hold_events_tenant_idx").on(t.tenantId, t.occurredAt),
    tenantPolicy("sending_hold_events_tenant", t.tenantId),
  ],
)

/**
 * Content fingerprints of accepted mail, per workspace per day (#170).
 *
 * ⚠ FINGERPRINTS, NEVER CONTENT. `exact` is a SHA-256 of the normalised
 * subject and body and `bands` the LSH bands of its MinHash signature; neither
 * can be turned back into the email. See risk/fingerprint.ts for why MinHash. Kept 30 days. They exist to find the same
 * message sent from many workspaces - a farm - which no per-workspace rate can
 * see.
 */
export const contentFingerprints = core.table(
  "content_fingerprints",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    exact: text("exact").notNull(),
    bands: text("bands").array().notNull(),
    messages: integer("messages").notNull().default(0),
    /**
     * Why this content does not count toward the cross-workspace rules
     * (#222): `boilerplate:<id>` for known public boilerplate, `template:<id>`
     * for the workspace's own staff-approved template. Null counts in full.
     *
     * ⚠ SET ONLY WHILE EVERY MESSAGE WITH THIS FINGERPRINT FITTED. One that
     * did not clears it for the day - it fails closed, never open.
     */
    trustedBy: text("trusted_by"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day, t.exact] }),
    index("content_fingerprints_exact_idx").on(t.exact, t.day),
    // ⚠ THE NEAR-DUPLICATE LOOKUP IS AN ARRAY OVERLAP (`&&`), WHICH ONLY GIN
    // SERVES. Without it `fingerprint_peers` is a scan of every workspace's
    // fingerprints for every workspace scored.
    index("content_fingerprints_bands_idx").using("gin", t.bands),
    index("content_fingerprints_day_idx").on(t.day),
    tenantPolicy("content_fingerprints_tenant", t.tenantId),
  ],
)

/**
 * Hostnames linked from accepted mail, per workspace per day, and Web Risk's
 * verdict on each (#170).
 *
 * ⚠ HOSTS, NEVER URLS. A URL in an email routinely carries a recipient's token
 * or address; the host is all a reputation lookup needs.
 */
export const linkHosts = core.table(
  "link_hosts",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    host: text("host").notNull(),
    messages: integer("messages").notNull().default(0),
    /** Null until checked; `clean`, or Web Risk's threat types joined by `,`. */
    verdict: text("verdict"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day, t.host] }),
    index("link_hosts_unchecked_idx").on(t.day, t.checkedAt),
    tenantPolicy("link_hosts_tenant", t.tenantId),
  ],
)

/**
 * What we saw of a person when they used the product (#170): sign-ins,
 * console sessions, security anomalies.
 *
 * ⚠ KEYED ON THE PERSON, NOT THE WORKSPACE, AND THAT IS WHY ITS POLICY DENIES
 * EVERYTHING. A sign-up happens before any workspace exists, and the questions
 * asked of this table - how many accounts share this device, this subnet -
 * compare people with each other. A tenant policy cannot express that, and a
 * readable table would hand every workspace every other user's IP. So it is
 * written and read ONLY through narrow SECURITY DEFINER functions that return
 * counts and ids (see the risk migration), and a direct query returns nothing.
 *
 * ⚠ RAW IP AND USER AGENT ARE NULLED AFTER 90 DAYS by the hourly run; the
 * derived country, network and device id stay for the life of the account.
 */
export const identityEvents = core.table(
  "identity_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    clerkUserId: text("clerk_user_id").notNull(),
    /** The workspace in scope, when there was one. */
    tenantId: uuid("tenant_id"),
    /** `session`, `api_key`, `anomaly`, `takeover_response`. */
    kind: text("kind").notNull(),
    sessionId: text("session_id"),
    ip: text("ip"),
    /** `a.b.c` for IPv4, the /48 for IPv6: what "the same network" compares. */
    subnet: text("subnet"),
    country: text("country"),
    asn: integer("asn"),
    asName: text("as_name"),
    hosting: boolean("hosting"),
    tor: boolean("tor"),
    userAgent: text("user_agent"),
    deviceId: text("device_id"),
    timezone: text("timezone"),
    language: text("language"),
    /** For anomalies: what fired and its evidence. */
    detail: jsonb("detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("identity_events_user_idx").on(t.clerkUserId, t.occurredAt),
    index("identity_events_device_idx").on(t.deviceId, t.occurredAt),
    index("identity_events_subnet_idx").on(t.subnet, t.occurredAt),
    index("identity_events_unenriched_idx").on(t.asn, t.occurredAt),
    pgPolicy("identity_events_deny", {
      for: "all",
      using: sql`false`,
      withCheck: sql`false`,
    }),
  ],
)

/**
 * What a workspace turned out to be, for training the model (#170).
 *
 * ⚠ THE FEATURES ARE STORED WITH THE LABEL, AS THEY WERE WHEN IT WAS GIVEN.
 * Training then never reconstructs history, and a label cannot quietly start
 * describing a workspace that has since changed. `weight` lets a staff verdict
 * count for more than an inference like "an AWS-managed pause".
 */
export const riskLabels = core.table(
  "risk_labels",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** `abuse` or `legit`. */
    label: text("label").notNull(),
    /** `staff`, `hold_upheld`, `hold_released`, `ses_aws_pause`, `tenure`. */
    source: text("source").notNull(),
    weight: real("weight").notNull().default(1),
    features: jsonb("features").notNull(),
    setBy: text("set_by").notNull(),
    note: text("note"),
    labeledAt: timestamp("labeled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("risk_labels_tenant_idx").on(t.tenantId, t.labeledAt),
    tenantPolicy("risk_labels_tenant", t.tenantId),
  ],
)

/**
 * Trained models (#170). Global rather than per workspace, so, like
 * `identity_events`, readable only through definer functions.
 *
 * ⚠ `active` IS THE EVALUATION GATE, NOT A PREFERENCE. A model is only
 * consulted when its held-out evaluation on real labels passed; every other
 * version is kept for comparison and contributes nothing.
 */
export const riskModels = core.table(
  "risk_models",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    version: integer("version").notNull(),
    /** Feature names in order, weights, bias, and normalisation. */
    weights: jsonb("weights").notNull(),
    /** Label counts, AUC, precision and recall on the held-out set. */
    evaluation: jsonb("evaluation").notNull(),
    active: boolean("active").notNull().default(false),
    trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("risk_models_version_unique").on(t.version),
    pgPolicy("risk_models_deny", {
      for: "all",
      using: sql`false`,
      withCheck: sql`false`,
    }),
  ],
)

// ─────────────────────────────────────────────────────────────────────────────
// Content intelligence (#169, #170, #171): templates discovered from what a
// workspace sends, and the vectors that let similar mail and similar
// workspaces be found. See docs/decisions/risk.md, "Templates and vectors".
// ─────────────────────────────────────────────────────────────────────────────

/** Dimensions of every content embedding, whichever embedder produced it. */
export const CONTENT_DIMENSIONS = 384

/**
 * A template the content job discovered in a workspace's own mail (#169).
 *
 * ⚠ NEVER SHOWN TO THE CUSTOMER AND NEVER SHARED ACROSS WORKSPACES. It is how
 * we store less (the static skeleton once, the per-message values beside each
 * message) and how the risk engine knows what "normal" looks like for this
 * workspace. Scoped per tenant like everything else, and deleted with it.
 *
 * ⚠ `segments` IS THE SKELETON: the static text between the holes, in order.
 * Rendering is `segments[0] + values[0] + segments[1] + ...`, which is why a
 * compacted body is byte-exact by construction - and checked anyway.
 */
export const contentTemplates = core.table(
  "content_templates",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** SHA-256 of the skeleton: the identity of the template within a workspace. */
    skeletonHash: text("skeleton_hash").notNull(),
    segments: jsonb("segments").notNull(),
    /** MinHash bands of a message it was derived from, for candidate lookup. */
    bands: text("bands").array().notNull(),
    staticBytes: integer("static_bytes").notNull(),
    holes: integer("holes").notNull(),
    /** Messages matched to it, compacted or not. */
    messages: integer("messages").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("content_templates_skeleton_unique").on(t.tenantId, t.skeletonHash),
    index("content_templates_bands_idx").using("gin", t.bands),
    tenantPolicy("content_templates_tenant", t.tenantId),
  ],
)

/**
 * The attachment objects a workspace holds in R2 (#136, #168): one row per
 * distinct file, at `<tenant_id>/sha256/<sha256>` in the content bucket.
 *
 * ⚠ A ROW MEANS THE OBJECT IS THERE. It is written only after the upload
 * succeeds, so the content-store job trusts it and skips the PUT - which is
 * the dedup: fifty thousand messages with one logo cost one write.
 *
 * ⚠ NOT A REFERENCE COUNT. References are the `message_bodies` rows that name
 * the hash; this only records what exists and when it was last wanted. The
 * sweep deletes an object once no body names it AND `last_seen_at` is older
 * than its grace, under a row lock the content-store job's touch waits on -
 * see content/attachments.ts for why that closes the race.
 *
 * ⚠ NO FOREIGN KEY TO `tenants`, ON PURPOSE. A cascade would delete these rows
 * with the tenant and leave the objects in R2 with nothing left that knows
 * they exist. Without it, the sweep still finds them.
 *
 * ⚠ PER WORKSPACE, NEVER GLOBAL. A shared object would let one workspace learn
 * whether another had sent the same file (the upload is skipped or it is not).
 */
export const contentObjects = core.table(
  "content_objects",
  {
    tenantId: uuid("tenant_id").notNull(),
    /** Hex SHA-256 of the exact bytes: the object's identity. */
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.sha256] }),
    index("content_objects_last_seen_idx").on(t.lastSeenAt),
    tenantPolicy("content_objects_tenant", t.tenantId),
  ],
)

/**
 * Images uploaded for a workspace's templates (#244), public in the template
 * assets bucket at `<folder>/<sha256>.<ext>`.
 *
 * ⚠ A ROW MEANS THE OBJECT IS THERE. It is written after the upload succeeds,
 * so a second upload of the same image finds it and writes nothing.
 *
 * ⚠ KEPT FOR AS LONG AS THE WORKSPACE EXISTS. Emails already sent point at
 * these URLs, and no reference we hold can say which inboxes still show them;
 * deleting an image because no template uses it any more would break mail
 * people have already received. When the workspace is deleted, the sweep
 * deletes every one of its images.
 *
 * ⚠ NO FOREIGN KEY TO `tenants`, ON PURPOSE, as for `content_objects`: a
 * cascade would delete the rows and leave the objects public in R2 with
 * nothing left that knows they exist.
 *
 * ⚠ PER WORKSPACE, NEVER GLOBAL. A shared object would tell one workspace
 * whether another had uploaded the same image.
 */
export const templateAssets = core.table(
  "template_assets",
  {
    tenantId: uuid("tenant_id").notNull(),
    /** Hex SHA-256 of the exact bytes: the image's identity. */
    sha256: text("sha256").notNull(),
    /** The object key in the bucket, and the path of the public URL. */
    key: text("key").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.sha256] }),
    tenantPolicy("template_assets_tenant", t.tenantId),
  ],
)

/**
 * Packs of sealed message bodies a workspace holds in R2 (#188), at
 * `<tenant_id>/packs/<id>`.
 *
 * ⚠ WRITTEN BEFORE THE UPLOAD. A pack that uploaded with a commit that then
 * failed has a row and no body pointing at it, so the sweep finds and deletes
 * it; written after, it would be an object nothing knows exists.
 *
 * ⚠ NOT A REFERENCE COUNT, like `content_objects`. The references are the
 * `message_bodies` rows naming it; the sweep deletes a pack past its grace once
 * none do. Packs are never appended to or shared, so no store can race it.
 *
 * ⚠ NO FOREIGN KEY TO `tenants`, for the reason `content_objects` gives.
 */
export const contentPacks = core.table(
  "content_packs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** Bytes in R2, sealed. */
    size: bigint("size", { mode: "number" }).notNull(),
    bodies: integer("bodies").notNull(),
    /** Bytes the bodies took in Postgres before they were packed. */
    rawSize: bigint("raw_size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("content_packs_tenant_created_idx").on(t.tenantId, t.createdAt),
    tenantPolicy("content_packs_tenant", t.tenantId),
  ],
)

/**
 * Messages retention deleted, kept 90 days so a late bounce or complaint can
 * still suppress its address (docs/decisions/storage.md).
 *
 * ⚠ WITHOUT IT, RETENTION SILENTLY STOPS SUPPRESSION. SES and receivers
 * report complaints days after the send. On a three-day plan the message is
 * gone by then, `ownerOf` finds nothing, and the event is dropped - so the
 * workspace keeps mailing someone who pressed "this is spam". A tombstone is
 * an id and a tenant; no address, no content.
 */
export const expiredMessages = core.table(
  "expired_messages",
  {
    messageId: uuid("message_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    expiredAt: timestamp("expired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("expired_messages_expired_idx").on(t.expiredAt),
    tenantPolicy("expired_messages_tenant", t.tenantId),
  ],
)

/**
 * An embedding of one piece of content a workspace sent (#170), per day.
 *
 * ⚠ AN EMBEDDING IS DERIVED FROM THE MAIL AND CAN LEAK SOME OF IT, so it is
 * treated like the mail: tenant-scoped under RLS, kept 30 days like the
 * fingerprints, never sent anywhere but our own database. Cross-workspace
 * questions ("is this close to mail a confirmed abuser sent?") go through
 * definer functions that return distances and counts, never another
 * workspace's vectors.
 *
 * ⚠ `model` IS PART OF THE KEY AND OF EVERY QUERY. Vectors from two embedders
 * live in different spaces; comparing them is meaningless, so they are never
 * compared.
 */
export const contentVectors = core.table(
  "content_vectors",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    exact: text("exact").notNull(),
    model: text("model").notNull(),
    embedding: halfvec("embedding", { dimensions: CONTENT_DIMENSIONS }).notNull(),
    /** As `content_fingerprints.trusted_by` (#222): why it does not count. */
    trustedBy: text("trusted_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day, t.exact, t.model] }),
    // ⚠ HNSW ON COSINE, IN HALF PRECISION: half the memory of `vector` for a
    // recall loss that does not matter at a 0.9 similarity threshold.
    index("content_vectors_hnsw_idx").using(
      "hnsw",
      t.embedding.op("halfvec_cosine_ops"),
    ),
    index("content_vectors_day_idx").on(t.day),
    tenantPolicy("content_vectors_tenant", t.tenantId),
  ],
)

/** Dimensions of the behaviour vector: `FEATURE_NAMES` in risk/model.ts. */
export const BEHAVIOUR_DIMENSIONS = 39

/**
 * Each workspace's behaviour as a point in space: its model features,
 * standardised (#170).
 *
 * ⚠ THIS IS HOW "A NEW WORKSPACE THAT LOOKS LIKE A BAD ONE" IS ASKED. Its
 * nearest neighbours among LABELLED workspaces are a fact the rules read -
 * observations, never another workspace's score, so no score can feed
 * another (the feedback-loop rule in docs/decisions/risk.md).
 */
export const behaviourVectors = core.table(
  "behaviour_vectors",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    embedding: vector("embedding", { dimensions: BEHAVIOUR_DIMENSIONS }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("behaviour_vectors_hnsw_idx").using("hnsw", t.embedding.op("vector_l2_ops")),
    tenantPolicy("behaviour_vectors_tenant", t.tenantId),
  ],
)

// ─────────────────────────────────────────────────────────────────────────────
// Trusted content (#222): known public boilerplate, and templates a workspace
// submitted and staff approved. See docs/decisions/risk.md, "Trusted templates".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Known public boilerplate (#222): Clerk's, Supabase's or NextAuth's default
 * emails, React Email starters - mail many unrelated workspaces send because
 * they all started from the same place.
 *
 * ⚠ GLOBAL, SO DENY-ALL LIKE `risk_models`. It is not any workspace's data, so
 * a tenant policy cannot describe it; it is read and written only through
 * definer functions (the risk migrations), and a direct query returns nothing.
 *
 * ⚠ A MATCH STOPS COUNTING TOWARD THE CROSS-WORKSPACE RULES AND NOTHING ELSE.
 * The semantic crowd, the farm clusters and similarity to confirmed abuse skip
 * it; bounces, complaints, velocity and identity count in full, because
 * boilerplate sent to a bought list is still a bought list.
 *
 * ⚠ `segments` IS A SKELETON FOR THE EXISTING MATCHER (content/templates.ts),
 * so a message counts as boilerplate only when it IS the boilerplate with its
 * holes filled - within `hole_limits`, and with no markup or foreign links in
 * the holes. See content/trust.ts.
 */
export const riskBoilerplate = core.table(
  "risk_boilerplate",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    /** A short, stable handle staff read, e.g. `clerk/reset-password`. */
    name: text("name").notNull(),
    skeletonHash: text("skeleton_hash").notNull(),
    segments: jsonb("segments").notNull(),
    /** Longest value each hole may take, in order. */
    holeLimits: jsonb("hole_limits").notNull(),
    bands: text("bands").array().notNull(),
    staticBytes: integer("static_bytes").notNull(),
    holes: integer("holes").notNull(),
    /** The embedder the embedding came from; null when none was loaded. */
    model: text("model"),
    embedding: halfvec("embedding", { dimensions: CONTENT_DIMENSIONS }),
    reason: text("reason").notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("risk_boilerplate_name_unique").on(t.name),
    uniqueIndex("risk_boilerplate_skeleton_unique").on(t.skeletonHash),
    pgPolicy("risk_boilerplate_deny", {
      for: "all",
      using: sql`false`,
      withCheck: sql`false`,
    }),
  ],
)

/**
 * Every change to the boilerplate list, append-only (#222): who, why, and the
 * skeleton as it was. Deny-all for the same reason as the list.
 */
export const riskBoilerplateEvents = core.table(
  "risk_boilerplate_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    /** No foreign key: a removal deletes the entry and keeps this row. */
    boilerplateId: uuid("boilerplate_id").notNull(),
    name: text("name").notNull(),
    skeletonHash: text("skeleton_hash").notNull(),
    /** `add` or `remove`. */
    action: text("action").notNull(),
    setBy: text("set_by").notNull(),
    reason: text("reason").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("risk_boilerplate_events_time_idx").on(t.occurredAt),
    pgPolicy("risk_boilerplate_events_deny", {
      for: "all",
      using: sql`false`,
      withCheck: sql`false`,
    }),
  ],
)

/**
 * A template a workspace submitted for review, and staff's decision (#222).
 *
 * ⚠ WHAT IS APPROVED IS THE FIXED PART. `segments` is the skeleton between
 * the holes the workspace marked; a message gets credit only when the
 * existing matcher fits it EXACTLY, each hole within its limit, with no markup
 * and no link off the workspace's own verified domains. The holes cannot carry
 * a different message, so "submit something clean, send something else" does
 * not work.
 *
 * ⚠ AN APPROVAL STOPS REPETITION COUNTING, NEVER RESULTS. Bounces, complaints
 * and holds work exactly as before, and the hourly run revokes an approval
 * whose messages bounce or complain past the thresholds, or on any staff abuse
 * label. Per workspace, never shared across workspaces.
 *
 * `status`: `pending`, `approved`, `rejected`, `revoked` or `withdrawn`.
 */
export const trustedTemplates = core.table(
  "trusted_templates",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** What was submitted, placeholders and all, for staff to read. */
    html: text("html"),
    text: text("text"),
    skeletonHash: text("skeleton_hash").notNull(),
    segments: jsonb("segments").notNull(),
    /** `[{ name, max }]`, one per hole, in order. */
    holes: jsonb("holes").notNull(),
    bands: text("bands").array().notNull(),
    /** Hosts the fixed part links to, checked with Web Risk before approval. */
    staticHosts: text("static_hosts")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status").notNull().default("pending"),
    submittedBy: text("submitted_by").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Shown to the workspace: staff write it knowing that. */
    decisionReason: text("decision_reason"),
    /** Messages credited to it. */
    matched: integer("matched").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trusted_templates_tenant_idx").on(t.tenantId, t.status),
    // ⚠ ONE LIVE SUBMISSION PER SKELETON. A second copy of an approved
    // template would be a second approval nobody reviewed.
    uniqueIndex("trusted_templates_live_unique")
      .on(t.tenantId, t.skeletonHash)
      .where(sql`status in ('pending', 'approved')`),
    tenantPolicy("trusted_templates_tenant", t.tenantId),
  ],
)

/** Every submission, decision and revocation, append-only (#222). */
export const trustedTemplateEvents = core.table(
  "trusted_template_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").notNull(),
    /** `submit`, `approve`, `reject`, `revoke` or `withdraw`. */
    action: text("action").notNull(),
    setBy: text("set_by").notNull(),
    reason: text("reason"),
    /** For automatic revocations: the numbers behind it. */
    detail: jsonb("detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trusted_template_events_tenant_idx").on(t.tenantId, t.occurredAt),
    tenantPolicy("trusted_template_events_tenant", t.tenantId),
  ],
)
