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
          // ⚠ EVERY COLUMN, AT EVERY WIDTH (2026-10-04): Type, Name, Value,
          // TTL, Status. A narrow table shortens the VALUE (see `Shortened`)
          // rather than dropping a column.
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
              <Th className="w-[4rem]">Type</Th>
              <Th className="w-[24%]">Name</Th>
              <Th>Value</Th>
              <Th className="w-[3rem]">TTL</Th>
              {status && <Th className="w-[7.5rem]">Status</Th>}
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
                    <Shortened value={record.name} />
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
                     * ⚠ SHORTENED IN THE MIDDLE, NEVER AT THE END, AND NEVER
                     * WHAT IS COPIED (2026-10-04). A click copies the whole
                     * value whatever is shown; the `[...]` is drawn muted and
                     * boxed so it cannot be mistaken for part of the record,
                     * and the full value is the cell's tooltip. See `shorten`.
                     */}
                    {/*
                     * ⚠ CLIPPED TO ITS OWN COLUMN (2026-10-04). Without
                     * `truncate` a value wider than the column ran on over the
                     * TTL, and the copy icon wrapped onto a line of its own
                     * under the record - in set-up's narrower column it always
                     * was. Shortened in the middle first, cut at the end only
                     * if it still does not fit; the icon never shrinks.
                     */}
                    <span className="flex min-w-0 items-baseline whitespace-nowrap">
                      {record.priority !== undefined && (
                        <span className="shrink-0 pr-1 text-muted-foreground">
                          {record.priority}
                        </span>
                      )}
                      <Shortened value={record.value} />
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
 * How a long record is shown: the start and the end, with `[...]` between -
 * Resend's way, so the parts somebody compares by eye survive.
 *
 * ⚠ A HOSTNAME KEEPS EVERYTHING BUT ITS ONE LONG LABEL. In
 * `8bee581b1cab454596b1e5f58b3cbca5.ns1.i10.tech` the random label is what is
 * long and `ns1.i10.tech` is what tells somebody which nameserver it is, so
 * only the label is cut: `8bee58[...]ca5.ns1.i10.tech`. Anything else over 60
 * characters keeps its first 14 and last 13; a DKIM record keeps its tags and
 * the first 8 characters of its key, `v=DKIM1; k=rsa; p=MIIBIjAN[...]QIDAQAB`.
 */
export function shorten(value: string, tight = false): [string, string] | null {
  const hostname = /^[A-Za-z0-9_.-]+$/.test(value) && value.includes(".")
  if (hostname) {
    const labels = value.split(".")
    const longest = labels.reduce(
      (a, l, i) => (l.length > labels[a]!.length ? i : a),
      0,
    )
    const label = labels[longest]!
    if (label.length <= 16) return null
    const before = labels.slice(0, longest).join(".")
    const after = labels.slice(longest + 1).join(".")
    /*
     * ⚠ TIGHT DROPS THE LABEL'S TAIL, NEVER THE NAME AFTER IT (2026-10-04):
     * `af7[...].ns2.i10.tech`. Which nameserver it is matters more than the
     * last three characters of a random label.
     */
    return tight
      ? [(before ? `${before}.` : "") + label.slice(0, 3), after ? `.${after}` : ""]
      : [
          (before ? `${before}.` : "") + label.slice(0, 6),
          label.slice(-3) + (after ? `.${after}` : ""),
        ]
  }
  if (value.length <= (tight ? 24 : 60)) return null
  /*
   * ⚠ A DKIM RECORD KEEPS ITS TAGS AND THE START OF THE KEY. "v=DKIM1; k=rsa"
   * is the same in every record; the key after `p=` is what tells two apart.
   */
  const key = value.indexOf("p=")
  if (tight) {
    return key >= 0 && key < 40
      ? [value.slice(key, key + 2 + 6), value.slice(-6)]
      : [value.slice(0, 8), value.slice(-6)]
  }
  const head = key >= 0 && key < 40 ? key + 2 + 8 : 14
  return [value.slice(0, head), value.slice(-13)]
}

function Marked({ value, parts }: { value: string; parts: [string, string] | null }) {
  if (!parts) return <>{value}</>
  return (
    <>
      {parts[0]}
      <span aria-hidden className="text-muted-foreground/60">
        [&hellip;]
      </span>
      <span className="sr-only">
        {value.slice(parts[0].length, value.length - parts[1].length)}
      </span>
      {parts[1]}
    </>
  )
}

/**
 * The record as wide as its column allows: the usual shortening when it fits,
 * the tight one when it does not (2026-10-04).
 *
 * ⚠ MEASURED, NOT GUESSED FROM THE VIEWPORT. The same table sits in the domain
 * page's wide card and in set-up's narrow column, so a breakpoint would be
 * right in one and wrong in the other. An invisible copy of the usual form is
 * measured against the space there is, and the tight form is used only when
 * the usual one would not fit.
 */
function Shortened({ value }: { value: string }) {
  const root = React.useRef<HTMLSpanElement>(null)
  const probe = React.useRef<HTMLSpanElement>(null)
  const [tight, setTight] = React.useState(false)

  React.useLayoutEffect(() => {
    const box = root.current
    const ruler = probe.current
    if (!box || !ruler) return
    /*
     * ⚠ MEASURED AGAINST THE CELL, NOT AGAINST THIS SPAN (2026-10-04). The
     * span is sized by what it holds, so once the tight form showed, the span
     * was tight-form-sized and the usual form never "fitted" again - every
     * page showed `af7[...]` for good. The cell's own width is the room there
     * really is: less its padding, the copy icon after the text, and anything
     * before it in the row (an MX record's priority).
     */
    const cell = (box.closest("td") ?? box.parentElement) as HTMLElement | null
    const button = box.closest("button") as HTMLElement | null
    if (!cell) return
    const fit = () => {
      const style = getComputedStyle(cell)
      const content =
        cell.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight)
      /*
       * ⚠ EVERYTHING ELSE ON THE LINE, MEASURED RATHER THAN ASSUMED: the copy
       * icon, its gap, an MX priority - whatever the button holds besides this
       * text. A fixed allowance was right in one browser and 16px short in
       * another, which cut the end off `ns1.i10.tech`.
       */
      const others = button ? button.offsetWidth - box.offsetWidth : 0
      setTight(ruler.offsetWidth > content - others)
    }
    fit()
    // The cell for room, the ruler for the text: a web font landing after the
    // first measure changes the text's width without touching the cell's.
    const watch = new ResizeObserver(fit)
    watch.observe(cell)
    watch.observe(ruler)
    return () => watch.disconnect()
  }, [value])

  return (
    <span ref={root} title={value} className="relative block min-w-0 truncate">
      <Marked value={value} parts={shorten(value, tight)} />
      <span
        ref={probe}
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 w-max whitespace-nowrap"
      >
        <Marked value={value} parts={shorten(value)} />
      </span>
    </span>
  )
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
      /*
       * ⚠ THE ICON SITS BESIDE THE TEXT, IN ITS OWN SLOT, NEVER OVER IT
       * (2026-10-04). Its room is part of what `Shortened` measures - it takes
       * the button's width less its own - so the text is shortened to leave
       * room for the icon rather than run under it.
       */
      className="group/copy -mx-1 flex max-w-full min-w-0 cursor-pointer flex-nowrap items-center gap-1.5 overflow-hidden rounded-md px-1 py-0.5 text-left font-mono text-xs transition-colors duration-(--duration-instant) ease-(--ease-linear) outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
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

function Td({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <td className={cn("max-w-0 px-3 py-2.5 align-top", className)}>{children}</td>
}

/** Splits a long TXT value into the 255-byte strings the wire format requires. */
function chunk(value: string, size = 255): string[] {
  const parts: string[] = []
  for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size))
  return parts.length > 0 ? parts : [""]
}
