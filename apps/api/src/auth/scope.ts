/**
 * What a key is allowed to send from.
 *
 * ⚠ `scopes` EXISTED AND WAS ENFORCED NOWHERE. The column has been on
 * `core.api_keys` since 0031, it is returned by `core.resolve_api_key`, it
 * reaches every request as `ResolvedKey.scopes` — and no route has ever read
 * it. A key created for a staging domain could send as the production one, and
 * the only thing standing between a leaked key and every domain a customer
 * owns was that nobody had tried.
 *
 * ⚠ THE SCOPE IS A DOMAIN NAME, BECAUSE THAT IS THE BOUNDARY CUSTOMERS THINK
 * IN. "This key is for acme.com" is a sentence people say; "this key has
 * `emails:write`" is one we would have to teach them. It is also the boundary
 * that matters after a leak: a key that cannot send as your primary domain
 * cannot be used to phish your customers.
 *
 * ⚠ AN EMPTY LIST IS UNRESTRICTED, AND THAT IS THE ONLY SAFE DEFAULT FOR A
 * COLUMN THAT IS ALREADY POPULATED. Every key in existence has `{}`; reading
 * that as "may send from nothing" would revoke every customer's sending the
 * moment this deployed.
 *
 * ⚠ AND IT IS A PREFIXED STRING RATHER THAN A JOIN TABLE, WHICH IS A
 * FAIL-CLOSED DECISION RATHER THAN A LAZY ONE. A join table with
 * `ON DELETE CASCADE` turns "delete the domain this key was restricted to"
 * into "this key is now unrestricted" — silently widening a credential at the
 * exact moment somebody is tidying up. A name that no longer resolves to a
 * verified domain simply cannot be sent from, so the key goes dead instead.
 * It also keeps the check in memory: this runs on the send path, which exists
 * in its current form because a network round trip there cost ~900ms.
 */

const DOMAIN = "domain:"

/** The scope string for a domain. Lowercased, because a domain is. */
export const domainScope = (name: string): string =>
  `${DOMAIN}${name.trim().toLowerCase()}`

/**
 * The domains a key is restricted to. Empty means "any".
 *
 * ⚠ UNKNOWN SCOPE STRINGS ARE IGNORED RATHER THAN REFUSED. The column is a
 * free `text[]` that predates this file and may carry anything an operator put
 * there; treating a stray value as a domain restriction would lock somebody
 * out of their own account over a typo in a SQL console.
 */
export function scopedDomains(scopes: readonly string[]): string[] {
  return scopes
    .filter((scope) => scope.startsWith(DOMAIN))
    .map((scope) => scope.slice(DOMAIN.length).trim().toLowerCase())
    .filter((name) => name !== "")
}

/**
 * Whether a key may send from this address's domain.
 *
 * ⚠ EXACT MATCH, NOT SUFFIX. `acme.com` does not license `evil-acme.com`, and
 * — more importantly — it does not license `mail.acme.com`, which is a
 * SEPARATE domain in `core.domains` with its own verification and its own DKIM
 * key. Treating a subdomain as covered would let a key scoped to the apex send
 * as a subdomain the customer deliberately kept apart.
 */
export function maySendFrom(scopes: readonly string[], domain: string | null): boolean {
  const allowed = scopedDomains(scopes)
  if (allowed.length === 0) return true
  if (!domain) return false
  return allowed.includes(domain.trim().toLowerCase())
}

/**
 * Whether this key is restricted at all.
 *
 * ⚠ IT IS WHAT STOPS A SCOPED KEY MINTING AN UNSCOPED ONE. Without it the
 * restriction is a suggestion: `POST /api-keys` authenticates with any valid
 * key and takes whatever `scopes` it is given, so a leaked key limited to
 * staging could issue itself a key limited to nothing and the whole boundary
 * would be one request wide. See routes/api-keys.ts.
 */
export const isRestricted = (scopes: readonly string[]): boolean =>
  scopedDomains(scopes).length > 0
