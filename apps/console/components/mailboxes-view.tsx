"use client"

import Link from "next/link"
import { Inbox } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { DropdownMenuItem, DropdownMenuSeparator } from "@repo/ui/components/i10/menu"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  TITLE,
} from "@repo/ui/components/i10/page"
import { PlaceholderTitle } from "@repo/ui/components/i10/page-title"
import { UsageMeter } from "@repo/ui/components/usage-meter/usage-meter"
import { CreateMailbox, type WorkspaceMember } from "@/components/create-mailbox-dialog"
import { EmptyState } from "@/components/empty-state"
import { LoadMore } from "@/components/load-more"
import {
  RememberShape,
  useRememberedShape,
  seedShape,
} from "@/components/list/remembered-shapes"
import { RowMenu } from "@/components/list/row-menu"
import {
  ListBody,
  ListCell,
  ListHead,
  ListHeader,
  ListRow,
  ListTable,
  ListTile,
} from "@/components/list/table"
import { useMailboxActions } from "@/components/mailbox-actions"
import { PanelError } from "@/components/panel-error"
import { formatBytes } from "@/lib/format"
import {
  availableActions,
  signInLabel,
  statusInfo,
  storageLine,
  type ConsoleMailbox,
} from "@/lib/mailbox-view"
import { PAGE_COPY } from "@/lib/page-copy"
import { NONE } from "@/lib/react"
import { mailboxDetailShape, seedMailboxShape } from "@/lib/shapes/mailbox-detail"
import {
  mailboxesShape,
  type MailboxesData,
  type MailboxesShape,
} from "@/lib/shapes/mailboxes"

/** A member's own dialog asks for no storage, so the pool never reaches it. */
const SELF_POOL = { kind: "uncapped", remaining: null } as const

/** What the Create mailbox dialog needs from the page. */
export interface CreateMailboxProps {
  domains: string[]
  held: Record<string, string>
  clerkEnabled: boolean
  previewMembers?: WorkspaceMember[]
}

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function MailboxesLoading() {
  return <MailboxesView shape={useRememberedShape(mailboxesShape)} />
}

const NAME_WIDTHS = ["58%", "46%", "66%", "52%"]

/** The Create button's box: it carries the dialog, so a skeleton draws its bar. */
const CREATE_BOX = {
  shape: "box",
  width: 148,
  height: 32,
  radius: 8,
  inline: true,
} as const

/**
 * The mailboxes page, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (an admin's list or a member's own
 * mailbox, the empty states, the pool as a meter or a line, the next page);
 * `data` only fills the bones. The API decides who sees which mailboxes.
 *
 * ⚠ THE CREATE BUTTON LIVES IN THE EMPTY STATE WHILE THE LIST IS EMPTY AND IN
 * THE HEADER ONCE IT IS NOT: two buttons for one action, far apart, read as two
 * different things. With no domain hosting mailboxes the action is the one that
 * unblocks it.
 *
 * ⚠ THE LINK TO TEAM INBOXES IS AT THE FOOT, NOT UNDER THE TITLE, so a line
 * added there never pushes the page down when it arrives.
 */
export function MailboxesView({
  shape,
  data,
}: {
  shape: MailboxesShape
  data?: MailboxesData
}) {
  const loading = data === undefined
  const mailboxes = data?.mailboxes ?? NONE
  const actions = useMailboxActions({ mailboxes, pool: data?.pool ?? null })
  const hasRows = shape.rows > 0
  const create = data?.create
  const mine = mailboxes[0]
  // Rows to draw: the data's, or as many placeholders as the shape remembers.
  const rows: (ConsoleMailbox | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : mailboxes

  return (
    <BoneScope id="mailboxes" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.mailboxes.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.mailboxes.title}</PageTitle>
            )}
            {/* Hidden while the list is empty: the empty state carries the action. */}
            {shape.admin && hasRows && (
              <PageActions>
                <Bone id="create" {...CREATE_BOX}>
                  {data && create && (
                    <CreateMailbox actor="admin" pool={data.pool} {...create} />
                  )}
                </Bone>
              </PageActions>
            )}
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.mailboxes.description}</PageDescription>
        </PageHeader>
        <PageBody>
          {data?.error !== undefined ? (
            <PanelError title="Could not load mailboxes" message={data.error} />
          ) : !shape.admin ? (
            hasRows ? (
              <OwnMailbox mailbox={mine} />
            ) : (
              <EmptyState
                icon={<Inbox />}
                title="No mailbox yet"
                description={
                  // ⚠ THE API STILL DECIDES: the mode can change between this render and
                  // the click, and the dialog then says the refusal in its own words.
                  shape.selfServe && shape.hosted
                    ? "You do not have a mailbox in this workspace yet. You can create your own."
                    : "You do not have a mailbox in this workspace. An owner or admin creates mailboxes for the team."
                }
                secondary={
                  shape.selfServe && shape.hosted ? (
                    <Bone id="create" {...CREATE_BOX}>
                      {create && (
                        <CreateMailbox actor="self" pool={SELF_POOL} {...create} />
                      )}
                    </Bone>
                  ) : undefined
                }
              />
            )
          ) : !hasRows ? (
            <EmptyState
              icon={<Inbox />}
              title="No mailboxes yet"
              description={
                shape.hosted
                  ? "Mailboxes are email addresses on your own domains that people can read and send from in any mail app. Create the first one for a member."
                  : "Mailboxes are email addresses on your own domains that people can read and send from in any mail app. Turn on mailbox hosting on a domain to create them."
              }
              {...(shape.hosted
                ? {}
                : { action: { label: "Go to domains", href: "/domains" } })}
              secondary={
                shape.hosted ? (
                  <Bone id="create" {...CREATE_BOX}>
                    {data && create && (
                      <CreateMailbox actor="admin" pool={data.pool} {...create} />
                    )}
                  </Bone>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-6">
              <PoolCard shape={shape} data={data} />
              <ListTable>
                <ListHeader>
                  <ListHead>Person</ListHead>
                  <ListHead className="w-[10rem]">Status</ListHead>
                  <ListHead className="w-[10rem]">Signs in with</ListHead>
                  <ListHead className="w-[11rem] text-right">Storage</ListHead>
                  <ListHead className="w-10" />
                </ListHeader>
                <ListBody>
                  {rows.map((mb, i) => {
                    const si = mb ? statusInfo(mb.status) : undefined
                    const seed = () =>
                      mb &&
                      seedShape(
                        mailboxDetailShape,
                        mb.address,
                        seedMailboxShape(mb, true),
                      )
                    return (
                      <BoneScope key={mb?.address ?? i} id={`row-${i}`} unit>
                        <ListRow>
                          <ListCell>
                            <div className="flex items-center gap-3">
                              <ListTile>
                                <Inbox className="size-4" />
                              </ListTile>
                              <div className="min-w-0 flex-1">
                                <Bone
                                  id="name"
                                  as="div"
                                  width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                                >
                                  {mb && (
                                    <Link
                                      href={`/mailboxes/${encodeURIComponent(mb.address)}`}
                                      className="block truncate font-medium outline-none hover:underline focus-visible:underline"
                                      onMouseEnter={seed}
                                      onClick={seed}
                                    >
                                      {mb.owner.name ?? mb.displayName ?? mb.address}
                                    </Link>
                                  )}
                                </Bone>
                                <p className="truncate text-xs text-muted-foreground">
                                  <Bone id="address" lineHeight={16} width="70%">
                                    {mb?.address}
                                  </Bone>
                                </p>
                              </div>
                            </div>
                          </ListCell>
                          <ListCell>
                            <Bone
                              id="status"
                              shape="box"
                              width={76}
                              height={20}
                              radius={9999}
                              inline
                            >
                              {si && <Badge tone={si.tone}>{si.label}</Badge>}
                            </Bone>
                          </ListCell>
                          <ListCell className="text-sm text-muted-foreground">
                            <Bone id="sign-in" width={96}>
                              {mb && signInLabel(mb.signIn)}
                            </Bone>
                          </ListCell>
                          <ListCell className="text-right text-sm tabular">
                            <Bone id="storage" width={110} align="end">
                              {mb && storageLine(mb.storage)}
                            </Bone>
                          </ListCell>
                          <ListCell className="text-right">
                            {/* The row menu acts on a mailbox, so a skeleton draws nothing here. */}
                            {mb && (
                              <span data-skeleton="skip" className="contents">
                                <RowMenu label={mb.address}>
                                  <DropdownMenuItem asChild>
                                    <Link
                                      href={`/mailboxes/${encodeURIComponent(mb.address)}`}
                                      onClick={seed}
                                    >
                                      View
                                    </Link>
                                  </DropdownMenuItem>
                                  <MailboxMenuItems
                                    mailbox={mb}
                                    start={actions.start}
                                  />
                                </RowMenu>
                              </span>
                            )}
                          </ListCell>
                        </ListRow>
                      </BoneScope>
                    )
                  })}
                </ListBody>
              </ListTable>
              {shape.more && <LoadMore cursor={data?.nextCursor} hasMore />}
            </div>
          )}
          {actions.dialogs}
          <p className="mt-6 text-sm text-muted-foreground">
            Need a shared address like support@ that several people read?{" "}
            <Link
              href="/team-inboxes"
              className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
            >
              Team inboxes
            </Link>
          </p>
        </PageBody>
        {data && data.error === undefined && (
          <RememberShape def={mailboxesShape} shape={shape} />
        )}
      </Page>
    </BoneScope>
  )
}

/** The workspace's storage: used against the pool where it is capped, else what is used. */
function PoolCard({ shape, data }: { shape: MailboxesShape; data?: MailboxesData }) {
  const pool = data?.pool
  return (
    <div className="rounded-2xl border bg-card p-6">
      {shape.meter ? (
        <Bone id="pool" as="div" shape="box" width="100%" height={44} radius={8}>
          {pool && pool.kind === "pool" && pool.total != null && (
            <UsageMeter
              label="Storage pool"
              limit={pool.total}
              decimals={0}
              unit="B"
              segments={[
                { id: "allocated", label: "Allocated", value: pool.allocated },
              ]}
            />
          )}
        </Bone>
      ) : (
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">Storage used</span>
          <span className="text-sm text-muted-foreground">
            <Bone id="pool-used" width={150} inline>
              {pool &&
                `${formatBytes(pool.used)} used${pool.total != null ? ` of ${formatBytes(pool.total)}` : ""}`}
            </Bone>
          </span>
        </div>
      )}
      {shape.unallocated && (
        <p className="mt-2 text-xs text-muted-foreground">
          <Bone id="unallocated" lineHeight={16} width="72%">
            {pool &&
              (pool.unallocated === 1
                ? "1 mailbox has no storage allocation yet and uses the default quota."
                : `${pool.unallocated} mailboxes have no storage allocation yet and use the default quota.`)}
          </Bone>
        </p>
      )}
    </div>
  )
}

/** A member's own mailbox and the settings to connect a mail app to it. */
function OwnMailbox({ mailbox }: { mailbox: ConsoleMailbox | undefined }) {
  const si = mailbox ? statusInfo(mailbox.status) : undefined
  const sso = mailbox?.signIn === "oidc" || mailbox?.signIn === "ldap"
  return (
    <div className="space-y-6">
      <div className="space-y-4 rounded-2xl border bg-card p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Your mailbox</h2>
          <Bone id="status" shape="box" width={76} height={20} radius={9999} inline>
            {si && <Badge tone={si.tone}>{si.label}</Badge>}
          </Bone>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Address</p>
          <p className="font-medium">
            <Bone id="address" width={220}>
              {mailbox?.address}
            </Bone>
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Storage</p>
          <p className="font-medium">
            <Bone id="storage" width={150}>
              {mailbox && storageLine(mailbox.storage)}
            </Bone>
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Sign in</p>
          <p className="font-medium">
            <Bone id="sign-in" width={120}>
              {mailbox && signInLabel(mailbox.signIn)}
            </Bone>
          </p>
        </div>
        <Link
          href={
            mailbox ? `/mailboxes/${encodeURIComponent(mailbox.address)}` : "/mailboxes"
          }
          className="inline-block text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
        >
          View details
        </Link>
      </div>

      <div className="space-y-4 rounded-2xl border bg-card p-6">
        <h2 className="text-lg font-medium">Connect a mail app</h2>
        <p className="text-sm text-muted-foreground">
          Use these settings in any IMAP mail client.
        </p>
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">IMAP host</p>
            <CopyField value="mail.i10.tech" />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">IMAP port</p>
            <p className="text-sm">993 (SSL)</p>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">SMTP host</p>
            <CopyField value="mail.i10.tech" />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">SMTP port</p>
            <p className="text-sm">465 (SSL)</p>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Username</p>
            <Bone
              id="username"
              as="div"
              shape="box"
              width="100%"
              height={36}
              radius={8}
            >
              {mailbox && <CopyField value={mailbox.address} />}
            </Bone>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Password</p>
            <p className="text-sm">
              <Bone id="password" width={260}>
                {mailbox &&
                  (sso
                    ? "The password you use for your company (SSO)."
                    : "The password you use to sign in to i10.")}
              </Bone>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

const MENU_LABEL = {
  storage: "Change storage",
  suspend: "Suspend",
  resume: "Resume",
  restore: "Restore",
  retry_export: "Start export again",
  delete: "Delete",
} as const

/**
 * The row menu's actions for one mailbox, the same ones its own page offers
 * (`availableActions`). Delete is last and apart, as it is on every other list.
 */
function MailboxMenuItems({
  mailbox,
  start,
}: {
  mailbox: ConsoleMailbox
  start: ReturnType<typeof useMailboxActions>["start"]
}) {
  const actions = availableActions(mailbox, new Date())
  const rest = actions.filter((a) => a !== "delete")
  return (
    <>
      {rest.map((action) => (
        <DropdownMenuItem key={action} onSelect={() => start(action, mailbox.address)}>
          {MENU_LABEL[action]}
        </DropdownMenuItem>
      ))}
      {actions.includes("delete") && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => start("delete", mailbox.address)}
          >
            {MENU_LABEL.delete}
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}
