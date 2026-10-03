"use client"

import * as React from "react"
import { Check, Copy, Download } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { CopyButton, useCopy } from "@repo/ui/components/copy"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { cn } from "cn"
import { Status } from "@/components/status"
import type { DnsRecord } from "@/lib/types"
import { toastDone } from "@/lib/toast"

/**
 * The records a customer has to publish.
 *
 * ⚠ THE VALUE COLUMN IS MONOSPACE, SELECTABLE, AND NEVER TRUNCATED WITH AN
 * ELLIPSIS THAT WOULD BE COPIED. A DKIM public key is 200-odd characters of
 * base64 and the single most common setup failure is pasting a truncated one.
 * The cell scrolls horizontally instead, and the copy button carries the whole
 * value regardless of what is visible - which is why the button, not the text,
 * is the thing the instructions point at.
 *
 * ⚠ AND THE TABLE BECOMES A CARD LIST BELOW `md`. A six-column table on a phone
 * is either unreadable at 7px or scrolls sideways, and this is a screen people
 * genuinely use on a phone while logged into their registrar on a laptop. The
 * card layout keeps the copy buttons full size, which is the whole interaction.
 */
export function DnsRecords({ records }: { records: DnsRecord[] }) {
  const { copy } = useCopy()

  if (records.length === 0) return <NoRecords />

  return (
    <div className="space-y-3">
      <RecordsTable records={records} framed />
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void copy(zoneFile(records)).then(
              (ok) => ok && toastDone("Zone file copied"),
            )
          }
        >
          <Download />
          Copy as zone file
        </Button>
      </div>
    </div>
  )
}

/**
 * The records as Resend's domain page lays them out (2026-10-03): one card,
 * "DNS Records" and its actions across the top, then a section per job -
 * verifying the domain, sending from it, DMARC - each with its own table.
 *
 * ⚠ GROUPED BY WHAT THE RECORD IS FOR, NOT BY TYPE. Somebody setting up DNS
 * thinks "the DKIM one" and "the SPF ones"; a TXT and an MX that both serve
 * SPF belong under one heading, which a sort by type would split.
 */
const GROUPS: { record: string; title: string; note?: string }[] = [
  { record: "DKIM", title: "Domain verification" },
  { record: "SPF", title: "Enable sending" },
  { record: "DMARC", title: "DMARC", note: "Recommended" },
]

/**
 * What a record is for, which is what it is grouped by.
 *
 * ⚠ A DELEGATED DOMAIN'S NS RECORDS ARE SORTED BY THE NAME THEY DELEGATE
 * (2026-10-03). Every one of them is `record: "NS"`, so they all landed in one
 * "Delegation" list of six rows and the page took a different shape from a
 * manual domain's. Each delegated name does one job - `_domainkey` carries
 * DKIM, `_dmarc` carries DMARC, the return path (`send`, or a custom one)
 * carries SPF - so the same three sections fit both kinds of domain.
 */
function purposeOf(record: DnsRecord): string {
  if (record.record !== "NS") return record.record
  const name = record.name.toLowerCase()
  if (name.startsWith("_domainkey.") || name.includes("._domainkey.")) return "DKIM"
  if (name.startsWith("_dmarc.")) return "DMARC"
  return "SPF"
}

export function DnsRecordsCard({
  records,
  actions,
}: {
  records: DnsRecord[]
  /** Connect or publish, beside the title. */
  actions?: React.ReactNode
}) {
  const { copy } = useCopy()

  return (
    <section className="rounded-3xl border p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold tracking-tight">
          DNS Records
        </h2>
        <div className="flex items-center gap-2">
          {actions}
          {records.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="rounded-full"
                  aria-label="Copy as zone file"
                  onClick={() =>
                    void copy(zoneFile(records)).then(
                      (ok) => ok && toastDone("Zone file copied"),
                    )
                  }
                >
                  <Download />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy as zone file</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {records.length === 0 ? (
        <div className="mt-6">
          <NoRecords />
        </div>
      ) : (
        <DnsRecordGroups records={records} className="mt-2" />
      )}
    </section>
  )
}

/**
 * The card's sections without the card - the add flow's last step shows the
 * same groups under its own heading.
 */
export function DnsRecordGroups({
  records,
  status = true,
  className,
}: {
  records: DnsRecord[]
  /** Each record's status. Off before anything has been checked. */
  status?: boolean
  className?: string
}) {
  const known = new Set(GROUPS.map((g) => g.record))
  const sorted = records.map((r) => ({ r, purpose: purposeOf(r) }))
  const groups = [
    ...GROUPS.map((g) => ({
      ...g,
      rows: sorted.filter((x) => x.purpose === g.record).map((x) => x.r),
    })),
    {
      record: "other",
      title: "Other records",
      note: undefined,
      rows: sorted.filter((x) => !known.has(x.purpose)).map((x) => x.r),
    },
  ].filter((g) => g.rows.length > 0)

  return (
    <div className={cn("divide-y", className)}>
      {groups.map((group) => (
        <div key={group.record} className="py-6 last:pb-0">
          <h3 className="flex items-center gap-2 font-semibold">
            {group.title}
            {group.note && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                {group.note}
              </span>
            )}
          </h3>
          {group.record !== "other" && group.record !== group.title && (
            <p className="mt-3 text-sm font-semibold">{group.record}</p>
          )}
          <div className="mt-3">
            <RecordsTable records={group.rows} status={status} />
          </div>
        </div>
      ))}
    </div>
  )
}

function NoRecords() {
  return (
    <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
      No records have been issued for this domain yet.
    </p>
  )
}

/**
 * ⚠ THE VALUE COLUMN IS MONOSPACE, SELECTABLE, AND NEVER TRUNCATED WITH AN
 * ELLIPSIS THAT WOULD BE COPIED - see the note at the top of the file.
 */
function RecordsTable({
  records,
  framed = false,
  status = true,
}: {
  records: DnsRecord[]
  status?: boolean
  /** A bordered table (onboarding) rather than the card's open one. */
  framed?: boolean
}) {
  return (
    <div className="space-y-3">
      <div
        className={cn(
          "hidden md:block",
          framed ? "overflow-hidden rounded-2xl border" : "",
        )}
      >
        <table className="w-full text-sm">
          <thead>
            <tr
              className={cn(
                "text-left",
                framed
                  ? "border-b bg-muted/30"
                  : // Resend's band: a rounded strip, no frame round the rows.
                    "bg-muted/50 [&>th:first-child]:rounded-l-xl [&>th:last-child]:rounded-r-xl",
              )}
            >
              <Th className="w-[5.5rem]">Type</Th>
              <Th className="w-[14rem]">Name</Th>
              <Th>Value</Th>
              <Th className="w-[5rem]">TTL</Th>
              {status && <Th className="w-[9rem]">Status</Th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {records.map((record, index) => (
              <tr key={`${record.type}-${record.name}-${index}`}>
                {/*
                 * ⚠ THE SECOND LINE IS DROPPED WHEN IT REPEATS THE FIRST. The
                 * two fields answer different questions - `type` is the DNS
                 * record type, `record` is what the record is FOR - and for a
                 * manual domain they differ usefully: TXT over "DKIM", MX
                 * over "SPF". For a delegated one every row is an NS record
                 * whose purpose is the delegation, so both fields say "NS"
                 * and the cell printed the same word twice, in two sizes,
                 * which reads as a rendering fault rather than as two facts.
                 */}
                <Td>
                  <span className="font-mono text-xs font-medium">{record.type}</span>
                  {/* In the card the group heading already names it. */}
                  {framed && record.record !== record.type && (
                    <span className="mt-0.5 block text-2xs text-muted-foreground">
                      {record.record}
                    </span>
                  )}
                </Td>
                <Td>
                  <CopyValue value={record.name} label="name">
                    <span className="min-w-0 truncate">{record.name}</span>
                  </CopyValue>
                </Td>
                <Td>
                  {/*
                   * ⚠ `justify-start`, AND THE VALUE DOES NOT GROW. It used to
                   * carry `flex-1`, which made the span eat the whole column and
                   * stranded the copy button against the TTL header - a hand's
                   * width away from `ns1.i10.tech`, and nowhere near the row it
                   * belonged to. The Name column beside it has always put its
                   * button directly after the text; the two columns disagreed on
                   * screen. Sizing to content puts the button back beside the
                   * value and lets a long DKIM key still push it to the edge,
                   * which is the one case where the old layout looked right.
                   */}
                  <CopyValue value={record.value} label="value">
                    {/*
                     * ⚠ `overflow-x-auto` ON THE VALUE, NOT `truncate`. An
                     * ellipsis in a DKIM key is invisible to somebody
                     * triple-clicking to select it, and they paste 60
                     * characters of a 220-character key. A click copies the
                     * whole value whatever is visible.
                     */}
                    <span className="min-w-0 overflow-x-auto whitespace-nowrap">
                      {record.priority !== undefined && (
                        <span className="text-muted-foreground">
                          {record.priority}{" "}
                        </span>
                      )}
                      {record.value}
                    </span>
                  </CopyValue>
                </Td>
                <Td>
                  <span className="font-mono text-xs text-muted-foreground">
                    {record.ttl}
                  </span>
                </Td>
                {status && (
                  <Td>
                    <Status
                      status={record.status}
                      variant={framed ? undefined : "pill"}
                    />
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The phone layout. Same data, one record per card. */}
      <ul className="space-y-2 md:hidden">
        {records.map((record, index) => (
          <li
            key={`${record.type}-${record.name}-${index}`}
            className="space-y-2 rounded-lg border p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-medium">
                {record.type}
                {/* Same rule as the table: see the note there. */}
                {record.record !== record.type && (
                  <span className="ml-1.5 font-sans text-2xs text-muted-foreground">
                    {record.record}
                  </span>
                )}
              </span>
              {status && <Status status={record.status} />}
            </div>

            <Row label="Name" value={record.name} />
            <Row
              label="Value"
              value={
                record.priority === undefined
                  ? record.value
                  : `${record.priority} ${record.value}`
              }
            />
            <p className="text-2xs text-muted-foreground">TTL {record.ttl}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/*
 * ⚠ THE ZONE-FILE EXPORT IS PLAIN TEXT, NOT A DOWNLOAD OF A .zone FILE.
 * Almost every provider's bulk importer accepts pasted BIND syntax, and the
 * people who reach for this are the ones with a terminal open. A file would
 * add a download, a filename and a MIME type to solve a problem that a
 * clipboard already solves.
 */
function zoneFile(records: DnsRecord[]): string {
  const lines = records.map((record) => {
    const value =
      record.type === "TXT"
        ? // ⚠ QUOTED, AND LONG VALUES SPLIT INTO 255-BYTE STRINGS. A TXT
          // record longer than 255 bytes is invalid as a single string - the
          // wire format transmits it in chunks that the resolver rejoins -
          // and a DKIM key is always longer than that. Every zone file that
          // gets this wrong fails to load with a message about a string being
          // too long.
          chunk(record.value)
            .map((part) => `"${part}"`)
            .join(" ")
        : record.value

    const priority = record.priority === undefined ? "" : `${record.priority} `
    return `${record.name}.\t${record.ttl}\tIN\t${record.type}\t${priority}${value}`
  })

  return lines.join("\n")
}

/**
 * A name or value that copies itself when pressed (2026-10-03), as Resend's
 * do: the text is the target, not a 16px button beside it. The icon after it
 * appears on hover and turns into a tick once copied, so the press is
 * confirmed where it happened rather than in a toast across the screen.
 */
function CopyValue({
  value,
  label,
  children,
}: {
  value: string
  label: string
  children: React.ReactNode
}) {
  const { copied, copy } = useCopy()
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      aria-label={copied ? "Copied" : `Copy ${label}`}
      title={`Copy ${label}`}
      className="group/copy -mx-1 flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left font-mono text-xs transition-colors duration-(--duration-instant) ease-(--ease-linear) outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      {copied ? (
        <Check aria-hidden className="size-3 shrink-0 text-success" />
      ) : (
        <Copy
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100"
        />
      )}
    </button>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-1 rounded-md border bg-muted/40 py-1 pr-1 pl-2">
        <span className="min-w-0 flex-1 overflow-x-auto font-mono text-2xs whitespace-nowrap select-all">
          {value}
        </span>
        <CopyButton value={value} size="icon-xs" />
      </div>
    </div>
  )
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <th
      className={`px-3 py-2 text-xs font-medium text-muted-foreground ${className ?? ""}`}
    >
      {children}
    </th>
  )
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="max-w-0 px-3 py-2.5 align-top">{children}</td>
}

/** Splits a long TXT value into the 255-byte strings the wire format requires. */
function chunk(value: string, size = 255): string[] {
  const parts: string[] = []
  for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size))
  return parts.length > 0 ? parts : [""]
}
