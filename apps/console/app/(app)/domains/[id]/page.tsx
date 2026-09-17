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
import { DomainActions } from "@/components/domain-actions"
import { VerifyButton } from "@/components/verify-button"
import { tryApi } from "@/lib/api"
import { formatExact } from "@/lib/format"
import type { Domain } from "@/lib/types"

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
            <VerifyButton id={domain.id} status={domain.status} />
            <DomainActions id={domain.id} name={domain.name} />
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
        <StatusNote status={domain.status} delegated={domain.delegated} />

        <Section className="border-b-0 pt-0">
          <SectionTitle>
            {domain.delegated ? "Delegation records" : "DNS records"}
          </SectionTitle>
          <SectionDescription>
            {domain.delegated ? (
              <>
                Publish these three NS records at your DNS provider. Once they
                resolve, i10 serves those subdomains — SPF, DKIM, DMARC and MX stay
                correct without you touching them again.
              </>
            ) : (
              <>
                Publish all of these at your DNS provider. We re-check them every
                time you press Verify, and continuously for the first 72 hours.
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
      </PageBody>
    </Page>
  )
}

function StatusNote({ status, delegated }: { status: string; delegated: boolean }) {
  if (status === "verified") return null

  const copy: Record<string, { title: string; body: string; tone: string }> = {
    not_started: {
      title: "Not started",
      body: delegated
        ? "Publish the three NS records below, then press Verify."
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
