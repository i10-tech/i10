import type { AccessDomain } from "@/lib/actions"

export type DomainChoice = {
  id: string
  name: string
  source: AccessDomain["source"]
  coveredBy: { id: string; name: string } | null
}

/**
 * The verified domains a connection could take: those `self` already covers are
 * dropped, and those another connection covers say which one.
 *
 * ⚠ `self` IS THE SCREEN'S OWN COPY, NOT ITS ROW IN `connections`: that list was
 * read once on load, so its row misses a domain added or removed since.
 */
export function domainChoices(
  domains: AccessDomain[],
  connections: { id: string; name: string; domains: { joinDomainId: string }[] }[],
  self: { id: string; domains: { joinDomainId: string }[] } | null,
): DomainChoice[] {
  const own = new Set(self?.domains.map((d) => d.joinDomainId))
  const owners = new Map(
    connections
      .filter((c) => c.id !== self?.id)
      .flatMap((c) =>
        c.domains.map((d) => [d.joinDomainId, { id: c.id, name: c.name }] as const),
      ),
  )
  return domains
    .filter((d) => !own.has(d.id))
    .map((d) => ({
      id: d.id,
      name: d.name,
      source: d.source,
      coveredBy: owners.get(d.id) ?? null,
    }))
}
