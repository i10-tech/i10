"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { ssoDirectories } from "@/lib/sso-actions"
import type { SsoAbilities, SsoDirectories, SsoDirectory } from "@/lib/sso-types"
import { DeprovisionedKeysPanel } from "./deprovisioned-keys"
import { AddDirectoryFlow } from "./directories/add-directory-flow"
import { DirectoryRow } from "./directories/directory-row"
import { IdpMark } from "./idp-mark"
import { MailboxesPanel } from "./mailboxes-panel"
import { SettingsGroup, SettingsRow } from "./settings-card"
import { Loading, useRemote, useSsoCall } from "./shared"

export {
  DEFAULT_GOOGLE_SCOPES,
  type GoogleErrorContext,
  GOOGLE_ERROR_COPY,
  isGoogleDirectoryErrorCode,
  describeGoogleError,
} from "@/lib/google-directory-errors"

const MARKS = ["okta", "entra", "google"]

export function DirectoriesPanel({
  abilities,
  initial,
}: {
  abilities: SsoAbilities
  initial?: SsoDirectories | null
}) {
  const call = useSsoCall()
  const { data, setData, failed, reload } = useRemote(ssoDirectories, initial)
  const [adding, setAdding] = React.useState(false)

  if (!data) return <Loading failed={failed} />

  const directories = data.data

  if (directories.length === 0) {
    return (
      <div>
        <Reveal show={!adding} spacing="">
          <div className="flex flex-col items-start gap-4 rounded-2xl border border-border p-5 sm:flex-row sm:items-center">
            <div className="flex -space-x-2">
              {MARKS.map((idp) => (
                <IdpMark key={idp} idp={idp} className="ring-2 ring-background" />
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Add and remove people automatically</p>
              <p className="text-sm text-muted-foreground">
                Keep members in step with your company&rsquo;s directory: Okta,
                Microsoft Entra, Google Workspace, or Custom SCIM.
              </p>
            </div>
            {abilities.owner && (
              <Button size="sm" onClick={() => setAdding(true)}>
                Set up
              </Button>
            )}
          </div>
        </Reveal>
        <Reveal show={adding} spacing="">
          <AddDirectoryFlow
            data={data}
            call={call}
            onDone={async () => {
              await reload()
              setAdding(false)
            }}
            onCancel={() => setAdding(false)}
          />
        </Reveal>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
        {directories.map((d) => (
          <DirectoryRow
            key={d.id}
            directory={d}
            abilities={abilities}
            onChange={(next: SsoDirectory) =>
              setData({
                ...data,
                data: directories.map((x) => (x.id === next.id ? next : x)),
              })
            }
            reload={reload}
            call={call}
          />
        ))}
      </ul>

      {abilities.owner && directories.length < data.max && !adding && (
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
          Add a directory
        </Button>
      )}

      <Reveal show={adding}>
        <AddDirectoryFlow
          data={data}
          call={call}
          onDone={async () => {
            await reload()
            setAdding(false)
          }}
          onCancel={() => setAdding(false)}
        />
      </Reveal>

      <div className="pt-2">
        <SettingsGroup>
          <MailboxesRow
            abilities={abilities}
            clerkEnabled={Boolean(process.env.CLERK_PUBLISHABLE_KEY)}
          />
          <DeprovisionedKeysRow
            abilities={abilities}
            clerkEnabled={Boolean(process.env.CLERK_PUBLISHABLE_KEY)}
          />
        </SettingsGroup>
      </div>
    </div>
  )
}

function MailboxesRow({
  abilities,
  clerkEnabled,
}: {
  abilities: SsoAbilities
  clerkEnabled: boolean
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <SettingsRow
      title="Mailboxes"
      description="What happens to a person's mailbox when your directory switches them off."
      action={
        <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Manage"}
        </Button>
      }
    >
      <Reveal show={open} spacing="pt-3">
        <MailboxesPanel abilities={abilities} clerkEnabled={clerkEnabled} />
      </Reveal>
    </SettingsRow>
  )
}

function DeprovisionedKeysRow({
  abilities,
  clerkEnabled,
}: {
  abilities: SsoAbilities
  clerkEnabled: boolean
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <SettingsRow
      title="Removed people's API keys"
      description="Keys created by people your directory removed."
      action={
        <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Manage"}
        </Button>
      }
    >
      <Reveal show={open} spacing="pt-3">
        <DeprovisionedKeysPanel abilities={abilities} clerkEnabled={clerkEnabled} />
      </Reveal>
    </SettingsRow>
  )
}
