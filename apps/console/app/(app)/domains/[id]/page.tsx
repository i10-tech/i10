import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { DomainDetailView } from "@/components/domain-detail-view"
import { tryApi } from "@/lib/api"
import { domainDetailShape, type DomainDetailData } from "@/lib/shapes/domain-detail"
import type {
  ApiKeyRow,
  ConnectableProvider,
  DelegationReport,
  DnsConnection,
  DnsInspection,
  Domain,
  Me,
  TransferOffer,
} from "@/lib/types"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const result = await tryApi<Domain>(`/console/domains/${encodeURIComponent(id)}`)
  return { title: result.ok ? result.data.name : "Domain" }
}

/**
 * One domain, and whether it can send.
 *
 * ⚠ THE RECORDS TABLE IS THE PAGE. Everything else - region, created date,
 * delete - is secondary to "what do I paste where, and have you seen it yet".
 * Per-record status is what makes the difference between "it does not work" and
 * "the DKIM record is missing"; without it, verification is a single red word
 * and somebody re-checks all six records looking for the wrong one.
 */
export default async function DomainDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const result = await tryApi<Domain>(`/console/domains/${encodeURIComponent(id)}`)

  if (!result.ok) {
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }

  const domain = result.data

  /*
   * ⚠ FETCHED ONLY FOR AN UNVERIFIED DELEGATED DOMAIN, AND THAT IS THREE DNS
   * LOOKUPS THIS PAGE DOES NOT OTHERWISE DO. A verified domain has nothing to
   * diagnose, and a manual one has no delegation - running it for either would
   * put a resolver on the critical path of a page that currently renders from
   * one call.
   */
  const delegation =
    domain.delegated && domain.status !== "verified"
      ? await tryApi<DelegationReport>(
          `/console/domains/${encodeURIComponent(id)}/delegation`,
        )
      : null

  /*
   * ⚠ THREE READS, AND ALL THREE ARE NEEDED TO ANSWER ONE QUESTION: can we
   * publish these records for them. Who hosts the domain's DNS (the lookup),
   * whether we have an adapter and an app for that host (the providers list),
   * and whether this workspace has already authorised us (the connections).
   * Any two of the three would render a button that fails when pressed.
   *
   * ⚠ AND A FAILURE IN ANY OF THEM HIDES THE BUTTON RATHER THAN THE PAGE. This
   * is an accelerator; the records table below is the thing somebody came for.
   */
  const [
    inspection,
    providers,
    connections,
    keys,
    transfer,
    me,
    teamInboxesRes,
    mailboxStorageRes,
  ] = await Promise.all([
    tryApi<DnsInspection>("/console/dns/lookup", { query: { domain: domain.name } }),
    tryApi<{ data: ConnectableProvider[] }>("/console/dns/providers"),
    tryApi<{ data: DnsConnection[] }>("/console/dns/connections"),
    /*
     * ⚠ READ HERE SO THE DELETE DIALOG CAN ASK ABOUT THEM WITHOUT A ROUND TRIP
     * OF ITS OWN. A key restricted to this domain becomes a credential that can
     * send from nothing the moment the domain goes, and the person deleting it
     * is the only one who will ever connect the two - see DomainActions.
     *
     * ⚠ AND A FAILURE HERE HIDES THE QUESTION RATHER THAN THE PAGE, like the
     * three above. The domain still deletes; what is lost is the offer to tidy
     * up after it, which is worth less than the page.
     */
    tryApi<{ data: ApiKeyRow[] }>("/console/api-keys"),
    // ⚠ A FAILURE SHOWS THE TRANSFER BUTTON, not an error. The worst case is an
    // offer made over one that was pending, which withdraws the old one.
    tryApi<{ data: TransferOffer | null }>(
      `/console/domains/${encodeURIComponent(id)}/transfer`,
    ),
    // For the transfer dialog, which refuses the person's own addresses.
    tryApi<Me>("/console/me"),
    // ⚠ READ HERE SO THE CATCH-ALL MORPHSELECT HAS ITS DESTINATIONS ON FIRST RENDER.
    tryApi<{ data: Array<{ address: string; display_name: string | null }> }>(
      "/console/team-inboxes",
    ),
    tryApi<{ data: Array<{ address: string; display_name: string | null }> }>(
      "/console/mailboxes/storage",
    ),
  ])

  /*
   * ⚠ ONLY THE LIVE ONES, AND ONLY THE ONES RESTRICTED TO **THIS** DOMAIN. An
   * unrestricted key works perfectly well for every other domain, so offering
   * to revoke it would be offering to break something unrelated; a revoked key
   * is already dead and naming it would be noise in a dialog that has to be
   * read.
   */
  const liveForThis = (keys.ok ? keys.data.data : []).filter(
    (key) => key.revoked_at === null && key.domains.includes(domain.name),
  )
  // Keys that can send from nothing once this domain goes - the delete asks
  // about these.
  const scopedKeys = liveForThis
    .filter((key) => key.domains.length === 1)
    .map((key) => ({ id: key.id, name: key.name }))
  // Every key the domain leaving would change, and what each keeps - the
  // transfer spells these out before the offer is sent.
  const keyImpact = liveForThis.map((key) => ({
    id: key.id,
    name: key.name,
    keeps: key.domains.filter((d) => d !== domain.name),
  }))

  const hostedBy = inspection.ok ? inspection.data.provider?.slug : undefined
  const connectable =
    hostedBy && providers.ok
      ? (providers.data.data.find((p) => p.slug === hostedBy) ?? null)
      : null
  const connection =
    connectable && connections.ok
      ? (connections.data.data.find((c) => c.provider === connectable.slug) ?? null)
      : null

  const canManageMailboxes =
    me.ok &&
    Boolean(
      me.data.access?.role === "owner" ||
      me.data.access?.role === "admin" ||
      me.data.access?.permissions.includes("workspace:manage"),
    )

  const data: DomainDetailData = {
    domain,
    delegation: delegation?.ok ? delegation.data : null,
    inspection: inspection.ok ? inspection.data : null,
    connectable,
    connection,
    scopedKeys,
    keyImpact,
    transfer: transfer.ok ? transfer.data.data : null,
    ownEmails: me.ok ? me.data.user.verified_emails : [],
    canManageMailboxes,
    mailboxAccounts:
      mailboxStorageRes.ok && Array.isArray(mailboxStorageRes.data?.data)
        ? mailboxStorageRes.data.data
        : [],
    teamInboxes:
      teamInboxesRes.ok && Array.isArray(teamInboxesRes.data?.data)
        ? teamInboxesRes.data.data
        : [],
  }

  return <DomainDetailView shape={domainDetailShape.of(data)} data={data} />
}
