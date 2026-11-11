"use client"

import Link from "next/link"
import { Inbox } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { UsageMeter } from "@repo/ui/components/usage-meter/usage-meter"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import {
  ListTable,
  ListHeader,
  ListHead,
  ListBody,
  ListRow,
  ListCell,
  ListTile,
} from "@/components/list/table"
import { RowMenu } from "@/components/list/row-menu"
import { DropdownMenuItem } from "@repo/ui/components/i10/menu"
import { EmptyState } from "@/components/empty-state"
import { LoadMore } from "@/components/load-more"
import { formatBytes } from "@/lib/format"

export interface ConsoleMailboxStorage {
  allocatedBytes: number | null
  usedBytes: number | null
  usedAt: string | null
}

export interface ConsoleMailbox {
  address: string
  displayName: string | null
  owner: { name: string | null; email: string | null }
  domain: string
  status: string
  signIn: "password" | "oidc" | "ldap" | "off"
  storage: ConsoleMailboxStorage
}

export interface StoragePool {
  kind: "pool" | "uncapped"
  total: number | null
  allocated: number
  used: number
  remaining: number | null
  unallocated: number
}

const STATUS_WORDS: Record<
  string,
  { label: string; tone: "success" | "warning" | "danger" | "neutral" }
> = {
  active: { label: "Active", tone: "success" },
  inactive: { label: "Not set up yet", tone: "warning" },
  suspended: { label: "Suspended", tone: "danger" },
  payment_hold: { label: "Payment needed", tone: "warning" },
  domain_off: { label: "Domain not hosting", tone: "warning" },
  banned: { label: "Blocked", tone: "danger" },
  locked: { label: "Blocked", tone: "danger" },
  sso_required: { label: "Mail sign-in off", tone: "warning" },
  deleting: { label: "Deleting", tone: "danger" },
}

function statusInfo(status: string) {
  return STATUS_WORDS[status] ?? { label: status, tone: "neutral" as const }
}

/** What a mailbox's storage line says; unmeasured and unallocated are not zero and not unlimited. */
function storageLine(storage: ConsoleMailboxStorage) {
  const used =
    storage.usedBytes == null ? "Not measured yet" : formatBytes(storage.usedBytes)
  const of =
    storage.allocatedBytes == null
      ? "the default quota"
      : formatBytes(storage.allocatedBytes)
  return storage.usedBytes == null ? used : `${used} of ${of}`
}

function signInLabel(lane: ConsoleMailbox["signIn"]) {
  if (lane === "off") return "Off"
  if (lane === "password") return "Password"
  if (lane === "oidc") return "Provider password"
  if (lane === "ldap") return "Directory password"
  return lane
}

export function MailboxesList({
  mailboxes,
  pool,
  nextCursor,
  isAdmin,
}: {
  mailboxes: ConsoleMailbox[]
  pool: StoragePool
  nextCursor: string | null
  isAdmin: boolean
}) {
  if (!isAdmin) {
    const mb = mailboxes[0]
    if (!mb) {
      return (
        <EmptyState
          icon={<Inbox />}
          title="No mailbox yet"
          description="You do not have a mailbox in this workspace. Ask an owner or admin if you expected one."
        />
      )
    }
    const sso = mb.signIn === "oidc" || mb.signIn === "ldap"
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Your mailbox</h2>
            <Badge tone={statusInfo(mb.status).tone}>
              {statusInfo(mb.status).label}
            </Badge>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Address</p>
            <p className="font-medium">{mb.address}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Storage</p>
            <p className="font-medium">{storageLine(mb.storage)}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Sign in</p>
            <p className="font-medium">{signInLabel(mb.signIn)}</p>
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-6 space-y-4">
          <h2 className="text-lg font-medium">Connect a mail app</h2>
          <p className="text-sm text-muted-foreground">
            Use these settings in any IMAP mail client.
          </p>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">IMAP host</p>
              <CopyField value="mail.i10.tech" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">IMAP port</p>
              <p className="text-sm">993 (SSL)</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">SMTP host</p>
              <CopyField value="mail.i10.tech" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">SMTP port</p>
              <p className="text-sm">465 (SSL)</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Username</p>
              <CopyField value={mb.address} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Password</p>
              <p className="text-sm">
                {sso
                  ? "The password you use for your company (SSO)."
                  : "The password you use to sign in to i10."}
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const hasRows = mailboxes.length > 0
  if (!hasRows) {
    return (
      <EmptyState
        icon={<Inbox />}
        title="No mailboxes yet"
        description="Mailboxes are email addresses on your own domains that people can read and send from in any mail app. Turn on mailbox hosting on a domain to create them."
        action={{ label: "Go to domains", href: "/domains" }}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-card p-6">
        {pool.kind === "pool" && pool.total != null ? (
          <UsageMeter
            label="Storage pool"
            limit={pool.total}
            decimals={0}
            unit="B"
            segments={[{ id: "allocated", label: "Allocated", value: pool.allocated }]}
          />
        ) : (
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">Storage used</span>
            <span className="text-sm text-muted-foreground">
              {formatBytes(pool.used)} used
              {pool.total != null ? ` of ${formatBytes(pool.total)}` : ""}
            </span>
          </div>
        )}
        {pool.unallocated > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {pool.unallocated === 1
              ? "1 mailbox has no storage allocation yet and uses the default quota."
              : `${pool.unallocated} mailboxes have no storage allocation yet and use the default quota.`}
          </p>
        )}
      </div>

      <ListTable fixed>
        <ListHeader>
          <ListHead>Person</ListHead>
          <ListHead>Status</ListHead>
          <ListHead>Signs in with</ListHead>
          <ListHead className="text-right">Storage</ListHead>
          <ListHead className="w-10" />
        </ListHeader>
        <ListBody>
          {mailboxes.map((mb) => {
            const si = statusInfo(mb.status)
            const name = mb.owner.name ?? mb.displayName ?? mb.address
            return (
              <ListRow key={mb.address}>
                <ListCell>
                  <div className="flex items-center gap-3">
                    <ListTile>
                      <Inbox className="size-4" />
                    </ListTile>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {mb.address}
                      </p>
                    </div>
                  </div>
                </ListCell>
                <ListCell>
                  <Badge tone={si.tone}>{si.label}</Badge>
                </ListCell>
                <ListCell className="text-sm text-muted-foreground">
                  {signInLabel(mb.signIn)}
                </ListCell>
                <ListCell className="text-right text-sm tabular">
                  {storageLine(mb.storage)}
                </ListCell>
                <ListCell className="text-right">
                  <RowMenu label={mb.address}>
                    <DropdownMenuItem asChild>
                      <Link href={`/mailboxes/${encodeURIComponent(mb.address)}`}>
                        View
                      </Link>
                    </DropdownMenuItem>
                  </RowMenu>
                </ListCell>
              </ListRow>
            )
          })}
        </ListBody>
      </ListTable>
      {nextCursor && <LoadMore cursor={nextCursor} />}
    </div>
  )
}
