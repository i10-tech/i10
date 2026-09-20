import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import {
  Page,
  PageActions,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"
import { Status } from "@/components/status"
import { DnsRecords } from "@/components/dns-records"
import { DomainDangerZone } from "@/components/domain-danger-zone"
import { DelegationNote } from "@/components/delegation-note"
import { PublishRecords } from "@/components/publish-records"
import { VerifyButton } from "@/components/verify-button"
import { tryApi } from "@/lib/api"
import { formatExact } from "@/lib/format"
import type {
  ApiKeyRow,
  ConnectableProvider,
  DelegationReport,
  DnsConnection,
  DnsInspection,
  Domain,
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
 * ⚠ THE RECORDS TABLE IS THE PAGE. Everything else — region, created date,
 * delete — is secondary to "what do I paste where, and have you seen it yet".
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
   * diagnose, and a manual one has no delegation — running it for either would
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
  const [inspection, providers, connections, keys] = await Promise.all([
    tryApi<DnsInspection>("/console/dns/lookup", { query: { domain: domain.name } }),
    tryApi<{ data: ConnectableProvider[] }>("/console/dns/providers"),
    tryApi<{ data: DnsConnection[] }>("/console/dns/connections"),
    /*
     * ⚠ READ HERE SO THE DELETE DIALOG CAN ASK ABOUT THEM WITHOUT A ROUND TRIP
     * OF ITS OWN. A key restricted to this domain becomes a credential that can
     * send from nothing the moment the domain goes, and the person deleting it
     * is the only one who will ever connect the two — see DomainActions.
     *
     * ⚠ AND A FAILURE HERE HIDES THE QUESTION RATHER THAN THE PAGE, like the
     * three above. The domain still deletes; what is lost is the offer to tidy
     * up after it, which is worth less than the page.
     */
    tryApi<{ data: ApiKeyRow[] }>("/console/api-keys"),
  ])

  /*
   * ⚠ ONLY THE LIVE ONES, AND ONLY THE ONES RESTRICTED TO **THIS** DOMAIN. An
   * unrestricted key works perfectly well for every other domain, so offering
   * to revoke it would be offering to break something unrelated; a revoked key
   * is already dead and naming it would be noise in a dialog that has to be
   * read.
   */
  const scopedKeys = (keys.ok ? keys.data.data : [])
    .filter((key) => key.revoked_at === null && key.domain === domain.name)
    .map((key) => ({ id: key.id, name: key.name }))

  const hostedBy = inspection.ok ? inspection.data.provider?.slug : undefined
  const connectable =
    hostedBy && providers.ok
      ? (providers.data.data.find((p) => p.slug === hostedBy) ?? null)
      : null
  const connection =
    connectable && connections.ok
      ? (connections.data.data.find((c) => c.provider === connectable.slug) ?? null)
      : null

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="icon-sm" asChild aria-label="Back to domains">
              <Link href="/domains">
                <ArrowLeft />
              </Link>
            </Button>
            <PageTitle className="truncate font-mono">{domain.name}</PageTitle>
            <Status status={domain.status} variant="pill" />
          </div>
          <PageActions>
            {/*
             * ⚠ ONLY WHERE WE CAN ACTUALLY DO IT. The button appears when the
             * domain's DNS is hosted somewhere we have an adapter for; anywhere
             * else the records table is still the answer, and offering a
             * shortcut that cannot work is worse than not offering one.
             */}
            {connectable && domain.status !== "verified" && (
              <PublishRecords
                domainId={domain.id}
                connection={connection}
                providerSlug={connectable.slug}
                providerName={connectable.name}
              />
            )}
            <VerifyButton id={domain.id} status={domain.status} />
          </PageActions>
        </PageHeaderRow>
      </PageHeader>

      <PageBody className="space-y-8">
        {/*
         * ⚠ THE EXPLANATION OF WHAT EACH STATUS MEANS IS INLINE, NOT IN A
         * TOOLTIP. `temporary_failure` in particular is not a synonym for
         * `failed` — SES uses it for a DNS lookup that failed in a way worth
         * retrying — and a customer who reads it as "failed" goes and changes
         * records that were correct.
         */}
        <StatusNote
          status={domain.status}
          delegated={domain.delegated}
          // ⚠ SUPPRESSED WHEN THERE IS A REAL DIAGNOSIS TO SHOW. The generic
          // "propagation can take 72 hours" note and a specific "your records
          // point somewhere else" note contradict each other, and the generic
          // one is the reassuring half — so shown together, it is the one people
          // believe.
          quiet={delegation?.ok === true}
        />

        {delegation?.ok && (
          <DelegationNote report={delegation.data} status={domain.status} />
        )}

        <Section className="border-b-0 pt-0">
          <SectionTitle>
            {domain.delegated ? "Delegation records" : "DNS records"}
          </SectionTitle>
          <SectionDescription>
            {domain.delegated ? (
              <>
                {/*
                 * ⚠ THE COUNT IS COUNTED, NOT WRITTEN DOWN. This said "three NS
                 * records" while the table below listed six — three delegated
                 * names times two nameservers — so the first thing the page did
                 * was contradict itself, and the second was make somebody
                 * wonder which three of the six they needed. `MAIL_NAMESERVERS`
                 * is configuration and can change; a number typed here cannot.
                 */}
                Publish {domain.records.length} NS records at your DNS provider — the{" "}
                {new Set(domain.records.map((record) => record.name)).size} names below,
                each pointing at every one of our nameservers. Once they resolve, i10
                serves those subdomains, so SPF, DKIM, DMARC and MX stay correct without
                you touching them again.
              </>
            ) : (
              <>
                Publish all of these at your DNS provider. We re-check them every time
                you press Verify, and continuously for the first 72 hours.
              </>
            )}
          </SectionDescription>
          <SectionContent>
            <DnsRecords records={domain.records} />
          </SectionContent>
        </Section>

        <Section>
          <SectionTitle>Details</SectionTitle>
          <SectionContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Region" value={domain.region} mono />
              <Detail
                label="Setup"
                value={domain.delegated ? "Delegated to i10" : "Manual records"}
              />
              <Detail label="Added" value={formatExact(domain.created_at)} />
              <Detail label="Domain ID" value={domain.id} mono />
            </dl>
          </SectionContent>
        </Section>

        {/*
         * ⚠ LAST, AND THAT IS THE POINT. Deleting a domain stops its mail, and
         * it used to sit behind a ✕✕✕ in the header an inch from "Verify" —
         * an unlabelled menu whose only contents were destructive. Reaching it
         * now means scrolling past everything the page is actually for.
         */}
        <Section>
          <SectionTitle className="text-destructive">Danger zone</SectionTitle>
          <SectionContent>
            <DomainDangerZone
              id={domain.id}
              name={domain.name}
              scopedKeys={scopedKeys}
            />
          </SectionContent>
        </Section>
      </PageBody>
    </Page>
  )
}

function StatusNote({
  status,
  delegated,
  quiet = false,
}: {
  status: string
  delegated: boolean
  quiet?: boolean
}) {
  if (status === "verified") return null
  if (quiet) return null

  const copy: Record<string, { title: string; body: string; tone: string }> = {
    not_started: {
      title: "Not started",
      body: delegated
        ? "Publish the NS records below, then press Verify."
        : "Publish the records below, then press Verify.",
      tone: "border-border bg-muted/30",
    },
    pending: {
      title: "Waiting for DNS",
      body: "The records have been issued and we are watching for them. DNS propagation is usually minutes and can be up to 72 hours — nothing is wrong yet.",
      tone: "border-warning/25 bg-warning/5",
    },
    temporary_failure: {
      title: "Temporary lookup failure",
      body: "A DNS lookup failed in a way worth retrying — this is not the same as your records being wrong. We keep checking; press Verify to check now.",
      tone: "border-warning/25 bg-warning/5",
    },
    failed: {
      title: "Verification failed",
      body: "We could not find the records within 72 hours. Check each row below against what your DNS provider actually shows — a trailing dot, a quoted value or a wrong host is the usual cause.",
      tone: "border-danger/25 bg-danger/5",
    },
  }

  const note = copy[status]
  if (!note) return null

  return (
    <div className={`rounded-lg border px-4 py-3 ${note.tone}`}>
      <p className="text-sm font-medium">{note.title}</p>
      <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{note.body}</p>
    </div>
  )
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-0.5 font-mono text-xs break-all" : "mt-0.5 text-sm"}>
        {value}
      </dd>
    </div>
  )
}
