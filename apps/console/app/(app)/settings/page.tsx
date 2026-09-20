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
 * ⚠ THE WORKSPACE NAME AND THE ORGANIZATION NAME ARE ONE NAME, AND THIS PAGE
 * USED TO EXPLAIN WHY THEY WERE TWO. The explanation was sound and the outcome
 * was not: renaming here left the organization in the switcher on its old name
 * — "Mohamed" months after the workspace became "i10 testing" — with nothing
 * anywhere to reconcile them and no reason a customer could see for there being
 * two names at all.
 *
 * ⚠ AND THE OBJECTION IT WAS BUILT AROUND IS STILL HONOURED. Syncing must not
 * put a write to Clerk inside our rename transaction, or a Clerk outage stops
 * renames. So `PATCH /console/me/tenant` commits ours first and asks Clerk
 * afterwards, best effort; and `organization.updated` follows a rename made in
 * Clerk's own panel back onto the workspace. Two directions, neither of them
 * able to block the other.
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
          What appears on your invoices, and what your team sees in the workspace
          switcher. Renaming here renames both.
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
