"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import { Globe } from "lucide-react"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import {
  Page,
  PageBody,
  PageHeader,
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs/tabs"
import { MetaGrid } from "@/components/detail-hero"
import {
  DomainLiveProvider,
  LiveDelegationNote,
  LiveDomainHero,
  LiveDomainJourney,
  LiveDomainRecords,
  LiveDomainStatus,
  WhileUnverified,
} from "@/components/domain-live"
import { ApiButton } from "@/components/list/api-button"
import { ProviderMark } from "@/components/provider-mark"
import { Time, useExactTime } from "@/components/time"
import { DomainDangerZone } from "@/components/domain-danger-zone"
import { DomainTracking } from "@/components/domain-tracking"
import { DomainMailboxes } from "@/components/domain-mailboxes"
import { PublishRecords } from "@/components/publish-records"
import { RememberShape, useRecordShape } from "@/components/list/remembered-shapes"
import {
  domainDetailShape,
  type DomainDetailData,
  type DomainDetailShape,
} from "@/lib/shapes/domain-detail"
import { regionName } from "@/lib/regions"
import { SNIPPETS } from "@/lib/snippets"

/** What loading.tsx renders: the view drawn from the seeded or default shape. */
export function DomainDetailLoading() {
  return <DomainDetailView shape={useRecordShape(domainDetailShape)} />
}

/**
 * One domain, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE: default tab, delegation note,
 * displaced note, delegated explainer, records count, and connectable button.
 */
export function DomainDetailView({
  shape,
  data,
}: {
  shape: DomainDetailShape
  data?: DomainDetailData
}) {
  const exact = useExactTime()
  const loading = data === undefined
  const domain = data?.domain
  const defaultTab = shape.status === "verified" ? "configuration" : "records"

  return (
    <BoneScope id="domain-detail" loading={loading}>
      {/*
       * ⚠ THE PAGE UPDATES IN PLACE. What changes while somebody waits on DNS -
       * the tile, the status, the events, the records - reads the domain from
       * the provider, which the watch and the Verify button keep current. See
       * components/domain-live.tsx.
       */}
      <DomainLiveProvider initial={domain ?? null} loading={loading}>
        <Page aria-busy={loading}>
          <PageHeader>
            <LiveDomainHero
              crumbs={[{ label: "Domains", href: "/domains" }]}
              icon={<Globe />}
              eyebrow={domain?.name}
              title={
                domain ? <span className="font-mono">{domain.name}</span> : undefined
              }
              // ⚠ NO ••• MENU (2026-10-03). Resend's holds only Delete, which
              // lives with Transfer in the Configuration tab's danger zone; verify
              // and auto-configure sit on the records card they act on.
              actions={<ApiButton snippet={SNIPPETS.domains} />}
            />
          </PageHeader>

          <PageBody className="space-y-8">
            <MetaGrid
              loading={loading}
              items={[
                {
                  label: "Created",
                  value: domain ? <Time iso={domain.created_at} /> : undefined,
                  width: 100,
                },
                {
                  label: "Status",
                  value: <LiveDomainStatus />,
                  shape: "box",
                  width: 76,
                  height: 20,
                  radius: 9999,
                },
                {
                  label: "DNS provider",
                  value: !loading ? (
                    data.inspection && data.inspection.provider ? (
                      <span className="flex items-center gap-2">
                        <ProviderMark
                          slug={data.inspection.provider.slug}
                          name={data.inspection.provider.name}
                          className="size-5"
                        />
                        {data.inspection.provider.name}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not detected</span>
                    )
                  ) : undefined,
                  width: 120,
                },
                {
                  label: "Region",
                  value: domain ? (
                    <span>
                      {regionName(domain.region)}{" "}
                      <span className="font-mono text-xs text-muted-foreground">
                        ({domain.region})
                      </span>
                    </span>
                  ) : undefined,
                  width: 90,
                },
              ]}
            />

            <LiveDomainJourney
              // ⚠ SUPPRESSED WHEN THERE IS A REAL DIAGNOSIS TO SHOW. The generic
              // "propagation can take 72 hours" note and a specific "your records
              // point somewhere else" note contradict each other, and the generic
              // one is the reassuring half - so shown together, it is the one people
              // believe. A displaced domain gets its own note below instead.
              quiet={shape.delegation || shape.displaced}
              fallback={{
                status: shape.status,
                delegated: shape.delegated,
                added: shape.added,
              }}
            />

            {/*
             * ⚠ IN PLACE OF THE STRIP'S STATUS NOTICE, NOT BESIDE IT. A displaced domain is
             * `failed`, and "we could not find the records" is the wrong story -
             * the records were found, in another workspace's setup. Shown together,
             * the failure note sends somebody to check DNS that has nothing wrong.
             */}
            {shape.displaced && (
              <DisplacedNote
                name={domain?.name}
                at={domain?.displaced_at ?? undefined}
              />
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
            <Tabs defaultValue={defaultTab}>
              <TabsList>
                <TabsTrigger value="records">Records</TabsTrigger>
                <TabsTrigger value="configuration">Configuration</TabsTrigger>
              </TabsList>

              <TabsContent value="records" className="m-0 space-y-6">
                <BoneScope id="records-tab" independent>
                  {shape.delegation && (
                    <LiveDelegationNote
                      domainId={domain?.id}
                      report={data?.delegation ?? undefined}
                      status={shape.status}
                      loading={loading}
                    />
                  )}

                  {shape.delegated && (
                    <p className="max-w-2xl text-sm text-muted-foreground">
                      {/*
                       * ⚠ THE COUNT IS COUNTED, NOT WRITTEN DOWN. `MAIL_NAMESERVERS`
                       * is configuration and can change; a number typed here cannot.
                       */}
                      Publish{" "}
                      <Bone id="record-count" width={16} inline>
                        {domain ? domain.records.length : shape.records}
                      </Bone>{" "}
                      NS records at your DNS provider - the{" "}
                      <Bone id="name-count" width={16} inline>
                        {domain
                          ? new Set(domain.records.map((r) => r.name)).size
                          : Math.max(1, Math.round(shape.records / 2))}
                      </Bone>{" "}
                      names below, each pointing at every one of our nameservers. Once
                      they resolve, i10 serves those subdomains, so SPF, DKIM, DMARC and
                      MX stay correct without you touching them again.
                    </p>
                  )}

                  <BoneRegion id="records">
                    <LiveDomainRecords
                      count={shape.records}
                      actions={
                        shape.connectable ? (
                          <WhileUnverified>
                            {/*
                             * ⚠ ONLY WHERE WE CAN ACTUALLY DO IT. The button appears when
                             * the domain's DNS is hosted somewhere we have an adapter for;
                             * anywhere else the records are still the answer, and offering
                             * a shortcut that cannot work is worse than not offering one.
                             */}
                            <PublishRecords
                              domainId={domain?.id ?? ""}
                              domainName={domain?.name ?? ""}
                              connection={data?.connection ?? null}
                              providerSlug={data?.connectable?.slug ?? ""}
                              providerName={data?.connectable?.name ?? ""}
                              loading={loading}
                            />
                          </WhileUnverified>
                        ) : undefined
                      }
                    />
                  </BoneRegion>
                </BoneScope>
              </TabsContent>

              <TabsContent value="configuration" className="m-0">
                <BoneScope id="config-tab" independent>
                  <Section className="pt-0">
                    <SectionTitle>Details</SectionTitle>
                    <SectionContent>
                      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <Detail
                          id="region"
                          label="Region"
                          value={domain?.region}
                          mono
                          width={80}
                        />
                        <Detail
                          id="setup"
                          label="Setup"
                          value={
                            !loading
                              ? domain?.delegated
                                ? "Delegated to i10"
                                : "Manual records"
                              : undefined
                          }
                          width={110}
                        />
                        <Detail
                          id="added"
                          label="Added"
                          value={domain ? exact(domain.created_at) : undefined}
                          width={140}
                        />
                        <Detail
                          id="id"
                          label="Domain ID"
                          value={domain?.id}
                          mono
                          width={220}
                        />
                      </dl>
                    </SectionContent>
                  </Section>

                  <Section>
                    <SectionTitle>Tracking</SectionTitle>
                    <SectionDescription>
                      Off by default. Turn these on only if you have a basis to track
                      the people you send to. Changes apply to the next message sent.
                    </SectionDescription>
                    <SectionContent>
                      <DomainTracking
                        id={domain?.id ?? ""}
                        openTracking={domain?.open_tracking ?? false}
                        clickTracking={domain?.click_tracking ?? false}
                        loading={loading}
                      />
                    </SectionContent>
                  </Section>

                  <Section>
                    <SectionTitle>Mailboxes</SectionTitle>
                    <SectionDescription>
                      Host mailboxes on this domain, receive mail and set a catch-all
                      address.
                    </SectionDescription>
                    <SectionContent>
                      <Bone id="mailboxes" shape="box" width="100%" height={96}>
                        {data && (
                          <DomainMailboxes
                            domainId={data.domain.id}
                            domainName={data.domain.name}
                            mailboxes={data.domain.mailboxes}
                            canManage={data.canManageMailboxes}
                            initialMailboxes={data.mailboxAccounts}
                            initialTeamInboxes={data.teamInboxes}
                          />
                        )}
                      </Bone>
                    </SectionContent>
                  </Section>

                  {/*
                   * ⚠ LAST, AND THAT IS THE POINT. Deleting a domain stops its mail;
                   * reaching it means choosing this tab and scrolling past everything
                   * the page is actually for.
                   */}
                  <Section>
                    <SectionTitle className="text-destructive">
                      Danger zone
                    </SectionTitle>
                    <SectionContent>
                      <DomainDangerZone
                        id={domain?.id ?? ""}
                        name={domain?.name ?? ""}
                        scopedKeys={data?.scopedKeys ?? NONE}
                        keyImpact={data?.keyImpact ?? NONE}
                        ownEmails={data?.ownEmails ?? NONE}
                        offer={data?.transfer ?? null}
                        loading={loading}
                      />
                    </SectionContent>
                  </Section>
                </BoneScope>
              </TabsContent>
            </Tabs>
          </PageBody>
          {data && <RememberShape def={domainDetailShape} shape={shape} />}
        </Page>
      </DomainLiveProvider>
    </BoneScope>
  )
}

/**
 * Why a domain that used to work cannot send any more.
 *
 * ⚠ IT NEVER SAYS WHICH WORKSPACE. "Acme has it now" would make this page a way
 * to learn who else is a customer; what the person needs is what happened and
 * the one thing that undoes it, and both are here without a name.
 */
function DisplacedNote({ name, at }: { name?: string; at?: string }) {
  const exact = useExactTime()
  return (
    <div className="rounded-lg border border-danger/25 bg-danger/5 px-4 py-3">
      <p className="text-sm font-medium">Another workspace verified this domain</p>
      <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
        On{" "}
        <Bone id="displaced-at" width={120} inline>
          {at ? exact(at) : undefined}
        </Bone>
        , another i10 workspace proved it controls{" "}
        <span className="font-mono text-foreground">
          <Bone id="displaced-name" width={140} inline>
            {name}
          </Bone>
        </span>
        , so the domain is now in their account and you can no longer send from it here.
        If it belongs here, make sure the records below are published at your DNS
        provider and press Verify - proving it again moves it back to this workspace.
      </p>
    </div>
  )
}

function Detail({
  id,
  label,
  value,
  mono = false,
  width = 110,
}: {
  id: string
  label: string
  value?: React.ReactNode
  mono?: boolean
  width?: number
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-0.5 font-mono text-xs break-all" : "mt-0.5 text-sm"}>
        <Bone id={`detail-${id}`} width={width} lineHeight={mono ? 16 : 20} inline>
          {value}
        </Bone>
      </dd>
    </div>
  )
}
