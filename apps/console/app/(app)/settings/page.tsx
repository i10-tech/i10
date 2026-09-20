import type { Metadata } from "next"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"
import { CopyField } from "@repo/ui/components/copy"
import { RenameWorkspace } from "@/components/rename-workspace"
import { DeletionWarning } from "@/components/deletion-warning"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatExact } from "@/lib/format"
import type { Me } from "@/lib/types"

export const metadata: Metadata = { title: "General settings" }

/**
 * ⚠ THE WORKSPACE NAME AND THE CLERK ORGANIZATION NAME ARE TWO DIFFERENT
 * THINGS, AND THE PAGE SAYS SO. Ours is the billing entity that appears on an
 * invoice; Clerk's is the identity surface members see in the switcher. Keeping
 * them in sync automatically would mean a write to Clerk inside a database
 * transaction, so a Clerk outage would make renaming a workspace impossible.
 */
export default async function GeneralSettingsPage() {
  const me = await tryApi<Me>("/console/me")

  if (!me.ok) {
    return (
      <PanelError title="Could not load your workspace" message={me.error.message} />
    )
  }

  const tenant = me.data.tenant

  return (
    <div>
      <Section className="pt-0">
        <SectionTitle>Workspace name</SectionTitle>
        <SectionDescription>
          What appears on your invoices. Your team sees the organization name from the
          switcher, which is set separately under Team.
        </SectionDescription>
        <SectionContent>
          <RenameWorkspace current={tenant?.name ?? ""} />
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Identifiers</SectionTitle>
        <SectionDescription>
          Quote the workspace ID if you ever contact support — it is what we look you up
          by.
        </SectionDescription>
        <SectionContent className="grid max-w-md gap-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Workspace ID</p>
            <CopyField value={tenant?.id ?? "—"} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Slug</p>
            <CopyField value={tenant?.slug ?? "—"} />
          </div>
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Created</SectionTitle>
        <SectionContent>
          <p className="text-sm text-muted-foreground">
            {tenant ? formatExact(tenant.created_at) : "—"}
          </p>
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Danger zone</SectionTitle>
        <SectionDescription>
          Deleting a workspace deletes its domains, keys, contacts and the record of
          every message it has ever sent. There is no undo and no export afterwards.
        </SectionDescription>
        <SectionContent className="space-y-4">
          {/*
           * ⚠ THE BILLING CONSEQUENCE IS STATED HERE BECAUSE DELETION HAPPENS
           * SOMEWHERE ELSE. The control is "Delete organization" inside Clerk's
           * own panel on the Team page; its dialog is Clerk's and says nothing
           * about money. What deleting does to the subscription is now real —
           * `organization.deleted` revokes it immediately — so it has to be
           * readable before somebody goes and presses it.
           */}
          <DeletionWarning billing={me.ok ? me.data.billing : null} scope="workspace" />

          {/*
           * ⚠ DELIBERATELY NOT A BUTTON ON THIS PAGE, AND THE PAGE SAYS WHY
           * RATHER THAN HIDING THE OPTION. Deleting a tenant cascades through
           * message history that a customer may be legally required to retain,
           * and through mailboxes that other people are still using. Until
           * there is an export and a grace period, deleting through Clerk's own
           * confirmation — which at least asks for the name — or a support
           * conversation are the honest mechanisms; a one-click button here
           * would be the single most destructive control in the product.
           */}
          <p className="text-sm text-muted-foreground">
            Deleting the organization under{" "}
            <a
              href="/settings/team"
              className="text-foreground underline underline-offset-4"
            >
              Team
            </a>{" "}
            deletes this workspace with it. If you would rather we exported your data
            first, or you are not sure whether anybody else relies on these mailboxes,
            email{" "}
            <a
              href="mailto:support@i10.tech"
              className="text-foreground underline underline-offset-4"
            >
              support@i10.tech
            </a>{" "}
            from an address on this workspace instead.
          </p>
        </SectionContent>
      </Section>
    </div>
  )
}
