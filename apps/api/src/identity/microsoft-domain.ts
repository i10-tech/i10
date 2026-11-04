/**
 * A tenant's own `*.onmicrosoft.com` domain. Microsoft owns its DNS, so our TXT
 * proof can never pass, and the fix is the customer's: a real domain in Entra.
 *
 * In a file of its own because the presets need it, and model.ts sits in a cycle
 * with them.
 */

/** What an admin reads about a tenant's own Microsoft domain. */
export const MICROSOFT_DOMAIN_ADVICE =
  "Microsoft owns onmicrosoft.com domains, so they cannot be proved here. Add your company's domain in Entra and move your members' logins to it."

export function isMicrosoftOwnedDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase()
  return normalized === "onmicrosoft.com" || normalized.endsWith(".onmicrosoft.com")
}
