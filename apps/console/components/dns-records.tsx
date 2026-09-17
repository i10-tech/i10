"use client"

import * as React from "react"
import { Download } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { CopyButton, useCopy } from "@repo/ui/components/copy"
import { Status } from "@/components/status"
import { toast } from "sonner"
import type { DnsRecord } from "@/lib/types"

/**
 * The records a customer has to publish.
 *
 * ⚠ THE VALUE COLUMN IS MONOSPACE, SELECTABLE, AND NEVER TRUNCATED WITH AN
 * ELLIPSIS THAT WOULD BE COPIED. A DKIM public key is 200-odd characters of
 * base64 and the single most common setup failure is pasting a truncated one.
 * The cell scrolls horizontally instead, and the copy button carries the whole
 * value regardless of what is visible — which is why the button, not the text,
 * is the thing the instructions point at.
 *
 * ⚠ AND THE TABLE BECOMES A CARD LIST BELOW `md`. A six-column table on a phone
 * is either unreadable at 7px or scrolls sideways, and this is a screen people
 * genuinely use on a phone while logged into their registrar on a laptop. The
 * card layout keeps the copy buttons full size, which is the whole interaction.
 */
export function DnsRecords({ records }: { records: DnsRecord[] }) {
  const { copy } = useCopy()

  if (records.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        No records have been issued for this domain yet.
      </p>
    )
  }

  /*
   * ⚠ THE ZONE-FILE EXPORT IS PLAIN TEXT, NOT A DOWNLOAD OF A .zone FILE.
   * Almost every provider's bulk importer accepts pasted BIND syntax, and the
   * people who reach for this are the ones with a terminal open. A file would
   * add a download, a filename and a MIME type to solve a problem that a
   * clipboard already solves.
   */
  function copyZoneFile() {
    const lines = records.map((record) => {
      const value =
        record.type === "TXT"
          ? // ⚠ QUOTED, AND LONG VALUES SPLIT INTO 255-BYTE STRINGS. A TXT
            // record longer than 255 bytes is invalid as a single string — the
            // wire format transmits it in chunks that the resolver rejoins —
            // and a DKIM key is always longer than that. Every zone file that
            // gets this wrong fails to load with a message about a string being
            // too long.
            chunk(record.value)
              .map((part) => `"${part}"`)
              .join(" ")
          : record.value

      const priority = record.priority === undefined ? "" : `${record.priority} `
      return `${record.name}.\t${record.ttl === "Auto" ? "3600" : record.ttl}\tIN\t${record.type}\t${priority}${value}`
    })

    void copy(lines.join("\n")).then((ok) => {
      if (ok) toast.success("Zone file copied")
    })
  }

  return (
    <div className="space-y-3">
      <div className="hidden overflow-hidden rounded-lg border md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-left">
              <Th className="w-[5.5rem]">Type</Th>
              <Th className="w-[14rem]">Name</Th>
              <Th>Value</Th>
              <Th className="w-[5rem]">TTL</Th>
              <Th className="w-[9rem]">Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {records.map((record, index) => (
              <tr key={`${record.type}-${record.name}-${index}`}>
                <Td>
                  <span className="font-mono text-xs font-medium">{record.type}</span>
                  <span className="mt-0.5 block text-2xs text-muted-foreground">
                    {record.record}
                  </span>
                </Td>
                <Td>
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 truncate font-mono text-xs select-all">
                      {record.name}
                    </span>
                    <CopyButton value={record.name} size="icon-xs" label="Copy name" />
                  </div>
                </Td>
                <Td>
                  <div className="flex items-center gap-1">
                    {/*
                     * ⚠ `overflow-x-auto` ON THE VALUE, NOT `truncate`. An
                     * ellipsis in a DKIM key is invisible to somebody
                     * triple-clicking to select it, and they paste 60
                     * characters of a 220-character key.
                     */}
                    <span className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap select-all">
                      {record.priority !== undefined && (
                        <span className="text-muted-foreground">
                          {record.priority}{" "}
                        </span>
                      )}
                      {record.value}
                    </span>
                    <CopyButton
                      value={record.value}
                      size="icon-xs"
                      label="Copy value"
                    />
                  </div>
                </Td>
                <Td>
                  <span className="font-mono text-xs text-muted-foreground">
                    {record.ttl}
                  </span>
                </Td>
                <Td>
                  <Status status={record.status} />
                </Td>
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
                <span className="ml-1.5 font-sans text-2xs text-muted-foreground">
                  {record.record}
                </span>
              </span>
              <Status status={record.status} />
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

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={copyZoneFile}>
          <Download />
          Copy as zone file
        </Button>
      </div>
    </div>
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
