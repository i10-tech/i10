"use client"

import * as React from "react"
import { Inbox } from "lucide-react"
import {
  Page,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { BoneScope } from "@repo/ui/components/bone/bone"
import { EmptyState } from "@/components/empty-state"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import { PAGE_COPY } from "@/lib/page-copy"
import {
  mailboxesShape,
  type MailboxesData,
  type MailboxesShape,
} from "@/lib/shapes/mailboxes"

export function MailboxesLoading() {
  return <MailboxesView shape={useRememberedShape(mailboxesShape)} />
}

export function MailboxesView({
  shape,
  data,
}: {
  shape: MailboxesShape
  data?: MailboxesData
}) {
  const loading = data === undefined

  return (
    <BoneScope id="mailboxes" loading={loading}>
      <Page>
        <PageHeader>
          <PageHeaderRow>
            <PageTitle>{PAGE_COPY.mailboxes.title}</PageTitle>
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.mailboxes.description}</PageDescription>
        </PageHeader>

        <PageBody>
          <EmptyState
            icon={<Inbox />}
            title="Not connected to the dashboard yet"
            description="Mailbox provisioning is live on the API and authenticated per person rather than per workspace, so who may see this list is still an open question. Until it is answered, this page deliberately shows nothing rather than guessing."
            action={{ label: "Read the routing decision", href: "/domains" }}
          />

          <div className="mt-6 flex items-start gap-3 rounded-2xl border px-4 py-3">
            <Inbox className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1 text-sm">
              <p className="font-medium">What exists today</p>
              <p className="text-muted-foreground">
                A domain marked as hosting mailboxes accepts mail through our own MTA
                and authenticates over LDAP against your i10 account - so a mailbox
                holder has one password, not two. Creating one is an API call that takes
                your session, not an API key.
              </p>
            </div>
          </div>
        </PageBody>
      </Page>
      {data && <RememberShape def={mailboxesShape} shape={shape} />}
    </BoneScope>
  )
}
