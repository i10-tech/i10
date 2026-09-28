/**
 * i10's own mail, defined in code (#206).
 *
 * ⚠ CODE, NOT A DATABASE ROW. Our mail is sent on events the code already
 * names - a Clerk auth email, a domain transfer offer - from an address the code
 * already knows. Deriving its sender or its SES tenant from a `core.domains`
 * row would make a migration, a manual edit or a missing row able to change who
 * our sign-in codes come from; the row that migration 0029 made for i10.tech
 * hosts mailboxes and says nothing about sending.
 *
 * Deliberately free of imports: env.ts reads `SYSTEM_FROM` as its default.
 */

/**
 * Who our mail comes from, unless `AUTH_EMAIL_FROM` in Doppler says otherwise.
 *
 * ⚠ A SUBDOMAIN WITH NO SES IDENTITY OF ITS OWN. SES sends it under the
 * verified parent `i10.tech`, which is why the tenancy below looks for the
 * nearest identity rather than assuming this exact domain has one.
 */
export const SYSTEM_FROM = "i10 <no-reply@notifications.i10.tech>"

/**
 * The SES tenant our mail sends through.
 *
 * ⚠ ADOPTED, NOT NEW. `i10-internal` was made by hand before tenants were
 * managed in code and sat empty; naming it here is what makes it ours.
 *
 * ⚠ OUTSIDE THE `i10-<uuid>` PATTERN ON PURPOSE. Workspace attaches detach an
 * identity from every OTHER tenant matching that pattern (see `OUR_TENANT`), so
 * sharing the shape would let a workspace's attach reason about our tenant. A
 * workspace can never hold our identity anyway: `DomainStore.create` refuses
 * our own domains.
 */
export const SYSTEM_SES_TENANT = "i10-internal"
