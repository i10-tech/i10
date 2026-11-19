"use client"

import { useClerkEnabled } from "@/lib/clerk-enabled"
import * as React from "react"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { WorkspaceGeneral } from "@/components/workspace-general"
import { RenameWorkspace } from "@/components/rename-workspace"
import { DeletionWarning } from "@/components/deletion-warning"
import { PanelError } from "@/components/panel-error"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import {
  settingsShape,
  type SettingsData,
  type SettingsShape,
} from "@/lib/shapes/settings"
import { useExactTime } from "@/components/time"

export function SettingsGeneralLoading() {
  return <SettingsGeneralView shape={useRememberedShape(settingsShape)} />
}

export function SettingsGeneralView({
  shape,
  data,
}: {
  shape: SettingsShape
  data?: SettingsData
}) {
  const exact = useExactTime()
  const loading = data === undefined
  // The workspace card calls Clerk's hooks; without the provider it cannot mount.
  const clerk = useClerkEnabled()

  return (
    <BoneScope id="settings" loading={loading}>
      {data?.error !== undefined ? (
        <PanelError title="Could not load your workspace" message={data.error} />
      ) : shape.variant === "workspace" && clerk ? (
        /*
         * ⚠ DRAWN LIKE THE ACCOUNT PAGE WHEN CLERK IS HERE (2026-10-12): the
         * workspace's logo and name in one card, the identifiers, and the delete
         * button itself in the danger zone. The page below is the no-Clerk preview.
         */
        <WorkspaceGeneral
          tenant={data?.tenant ?? null}
          billing={data?.billing ?? null}
          access={data?.access ?? null}
          loading={loading}
        />
      ) : (
        <div>
          <Section className="pt-0">
            <SectionTitle>Workspace name</SectionTitle>
            <SectionDescription>
              What appears on your invoices, and what your team sees in the workspace
              switcher. Renaming here renames both.
            </SectionDescription>
            <SectionContent>
              <Bone id="rename" shape="box" height={36} width={280} radius={8}>
                {data && (
                  <RenameWorkspace
                    current={data.tenant?.name ?? ""}
                    /* See WorkspaceBar: Clerk's hooks throw outside a provider, and
                       the provider is only mounted when a key exists. */
                    clerkEnabled={data.clerkEnabled}
                  />
                )}
              </Bone>
            </SectionContent>
          </Section>

          <Section>
            <SectionTitle>Identifiers</SectionTitle>
            <SectionDescription>
              Quote the workspace ID if you ever contact support - it is what we look
              you up by.
            </SectionDescription>
            <SectionContent className="grid max-w-md gap-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Workspace ID</p>
                <Bone id="tenant-id" width={220} lineHeight={36}>
                  <CopyField value={data?.tenant?.id ?? "-"} />
                </Bone>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Slug</p>
                <Bone id="tenant-slug" width={160} lineHeight={36}>
                  <CopyField value={data?.tenant?.slug ?? "-"} />
                </Bone>
              </div>
            </SectionContent>
          </Section>

          <Section>
            <SectionTitle>Created</SectionTitle>
            <SectionContent>
              <Bone id="tenant-created" width={120} lineHeight={20}>
                <p className="text-sm text-muted-foreground">
                  {data?.tenant ? exact(data.tenant.created_at) : "-"}
                </p>
              </Bone>
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
               * about money. What deleting does to the subscription is now real -
               * `organization.deleted` revokes it immediately - so it has to be
               * readable before somebody goes and presses it.
               */}
              {/* ⚠ ONE BONE: its tone, title and copy all follow the subscription. */}
              <Bone id="deletion" lines={3} lineHeight={20} width="100%">
                {data && <DeletionWarning billing={data.billing} scope="workspace" />}
              </Bone>
              {/*
               * ⚠ DELIBERATELY NOT A BUTTON ON THIS PAGE, AND THE PAGE SAYS WHY
               * RATHER THAN HIDING THE OPTION. Deleting a tenant cascades through
               * message history that a customer may be legally required to retain,
               * and through mailboxes that other people are still using. Until
               * there is an export and a grace period, deleting through Clerk's own
               * confirmation - which at least asks for the name - or a support
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
                deletes this workspace with it. If you would rather we exported your
                data first, or you are not sure whether anybody else relies on these
                mailboxes, email{" "}
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
      )}
      {data && data.error === undefined && (
        <RememberShape def={settingsShape} shape={shape} />
      )}
    </BoneScope>
  )
}
