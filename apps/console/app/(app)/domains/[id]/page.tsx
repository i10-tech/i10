import type { Metadata } from "next"
import { BackButton } from "@/components/back-button"
import { notFound } from "next/navigation"
import { Globe } from "lucide-react"
import {
  Page,
  PageBody,
  PageHeader,
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"
import { MetaGrid } from "@/components/detail-hero"
import {
  DomainLiveProvider,
  LiveDomainHero,
  LiveDomainJourney,
  LiveDomainRecords,
  LiveDomainStatus,
  WhileUnverified,
} from "@/components/domain-live"
import { ApiButton } from "@/components/list/api-button"
import { ProviderMark } from "@/components/provider-mark"
import { Time } from "@/components/time"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs"
import { DomainDangerZone } from "@/components/domain-danger-zone"
import { DomainTracking } from "@/components/domain-tracking"
import { DelegationNote } from "@/components/delegation-note"
import { PublishRecords } from "@/components/publish-records"
import { tryApi } from "@/lib/api"
import { formatExact } from "@/lib/format"
import { regionName } from "@/lib/regions"
import { SNIPPETS } from "@/lib/snippets"
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
  const [inspection, providers, connections, keys, transfer, me] = await Promise.all([
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

  return (
    /*
     * ⚠ THE PAGE UPDATES IN PLACE. What changes while somebody waits on DNS -
     * the tile, the status, the events, the records - reads the domain from
     * the provider, which the watch and the Verify button keep current. See
     * components/domain-live.tsx.
     */
    <DomainLiveProvider initial={domain}>
      <Page>
        <PageHeader>
          <LiveDomainHero
            back={<BackButton href="/domains" label="Back to domains" />}
            icon={<Globe />}
            eyebrow="Domain"
            title={<span className="font-mono">{domain.name}</span>}
            // ⚠ NO ••• MENU (2026-10-03). Resend's holds only Delete, which
            // lives with Transfer in the Configuration tab's danger zone; verify
            // and auto-configure sit on the records card they act on.
            actions={<ApiButton snippet={SNIPPETS.domains} />}
          />
        </PageHeader>

        <PageBody className="space-y-8">
          <MetaGrid
            items={[
              { label: "Created", value: <Time iso={domain.created_at} /> },
              {
                label: "Status",
                value: <LiveDomainStatus />,
              },
              {
                label: "DNS provider",
                value:
                  inspection.ok && inspection.data.provider ? (
                    <span className="flex items-center gap-2">
                      <ProviderMark
                        slug={inspection.data.provider.slug}
                        name={inspection.data.provider.name}
                        className="size-5"
                      />
                      {inspection.data.provider.name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not detected</span>
                  ),
              },
              {
                label: "Region",
                value: (
                  <span>
                    {regionName(domain.region)}{" "}
                    <span className="font-mono text-xs text-muted-foreground">
                      ({domain.region})
                    </span>
                  </span>
                ),
              },
            ]}
          />
          <LiveDomainJourney
            // ⚠ SUPPRESSED WHEN THERE IS A REAL DIAGNOSIS TO SHOW. The generic
            // "propagation can take 72 hours" note and a specific "your records
            // point somewhere else" note contradict each other, and the generic
            // one is the reassuring half - so shown together, it is the one people
            // believe. A displaced domain gets its own note below instead.
            quiet={delegation?.ok === true || Boolean(domain.displaced_at)}
          />

          {/*
           * ⚠ IN PLACE OF THE STRIP'S STATUS NOTICE, NOT BESIDE IT. A displaced domain is
           * `failed`, and "we could not find the records" is the wrong story -
           * the records were found, in another workspace's setup. Shown together,
           * the failure note sends somebody to check DNS that has nothing wrong.
           */}
          {domain.displaced_at && (
            <DisplacedNote name={domain.name} at={domain.displaced_at} />
          )}

          {/*
           * ⚠ RECORDS FIRST, EVERYTHING ELSE UNDER CONFIGURATION (2026-10-03),
           * as Resend splits it. The records are what somebody came for; the
           * details, tracking and the danger zone are settings, visited rarely.
           */}
          {/*
           * ⚠ THE TAB IT OPENS ON FOLLOWS THE DOMAIN (2026-10-03). Until it is
           * verified the records need attention, so they come first; once it is,
           * there is nothing left to publish and the settings are what somebody
           * returns for.
           *
           * ⚠ NOT IN THE URL (2026-10-03). The tab is where you are looking, not
           * a page of its own; switching never writes `?tab=`, and so never
           * costs a navigation either.
           */}
          <Tabs
            defaultValue={domain.status === "verified" ? "configuration" : "records"}
          >
            <TabsList variant="pill" className="mb-6">
              <TabsTrigger value="records">Records</TabsTrigger>
              <TabsTrigger value="configuration">Configuration</TabsTrigger>
            </TabsList>

            <TabsContent value="records" className="m-0 space-y-6">
              {delegation?.ok && (
                <DelegationNote
                  domainId={domain.id}
                  report={delegation.data}
                  status={domain.status}
                />
              )}

              {domain.delegated && (
                <p className="max-w-2xl text-sm text-muted-foreground">
                  {/*
                   * ⚠ THE COUNT IS COUNTED, NOT WRITTEN DOWN. `MAIL_NAMESERVERS`
                   * is configuration and can change; a number typed here cannot.
                   */}
                  Publish {domain.records.length} NS records at your DNS provider - the{" "}
                  {new Set(domain.records.map((record) => record.name)).size} names
                  below, each pointing at every one of our nameservers. Once they
                  resolve, i10 serves those subdomains, so SPF, DKIM, DMARC and MX stay
                  correct without you touching them again.
                </p>
              )}

              <LiveDomainRecords
                actions={
                  <>
                    {/*
                     * ⚠ ONLY WHERE WE CAN ACTUALLY DO IT. The button appears when
                     * the domain's DNS is hosted somewhere we have an adapter for;
                     * anywhere else the records are still the answer, and offering
                     * a shortcut that cannot work is worse than not offering one.
                     */}
                    {connectable && (
                      <WhileUnverified>
                        <PublishRecords
                          domainId={domain.id}
                          domainName={domain.name}
                          connection={connection}
                          providerSlug={connectable.slug}
                          providerName={connectable.name}
                        />
                      </WhileUnverified>
                    )}
                  </>
                }
              />
            </TabsContent>

            <TabsContent value="configuration" className="m-0">
              <Section className="pt-0">
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

              <Section>
                <SectionTitle>Tracking</SectionTitle>
                <SectionDescription>
                  Off by default. Turn these on only if you have a basis to track the
                  people you send to. Changes apply to the next message sent.
                </SectionDescription>
                <SectionContent>
                  <DomainTracking
                    id={domain.id}
                    openTracking={domain.open_tracking}
                    clickTracking={domain.click_tracking}
                  />
                </SectionContent>
              </Section>

              {/*
               * ⚠ LAST, AND THAT IS THE POINT. Deleting a domain stops its mail;
               * reaching it means choosing this tab and scrolling past everything
               * the page is actually for.
               */}
              <Section>
                <SectionTitle className="text-destructive">Danger zone</SectionTitle>
                <SectionContent>
                  <DomainDangerZone
                    id={domain.id}
                    name={domain.name}
                    scopedKeys={scopedKeys}
                    keyImpact={keyImpact}
                    ownEmails={me.ok ? me.data.user.verified_emails : []}
                    offer={transfer.ok ? transfer.data.data : null}
                  />
                </SectionContent>
              </Section>
            </TabsContent>
          </Tabs>
        </PageBody>
      </Page>
    </DomainLiveProvider>
  )
}

/**
 * Why a domain that used to work cannot send any more.
 *
 * ⚠ IT NEVER SAYS WHICH WORKSPACE. "Acme has it now" would make this page a way
 * to learn who else is a customer; what the person needs is what happened and
 * the one thing that undoes it, and both are here without a name.
 */
function DisplacedNote({ name, at }: { name: string; at: string }) {
  return (
    <div className="rounded-lg border border-danger/25 bg-danger/5 px-4 py-3">
      <p className="text-sm font-medium">Another workspace verified this domain</p>
      <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
        On {formatExact(at)}, another i10 workspace proved it controls{" "}
        <span className="font-mono text-foreground">{name}</span>, so the domain is now
        in their account and you can no longer send from it here. If it belongs here,
        make sure the records below are published at your DNS provider and press Verify
        - proving it again moves it back to this workspace.
      </p>
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
