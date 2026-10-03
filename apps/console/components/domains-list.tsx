"use client"

import * as React from "react"
import Link from "next/link"
import { Copy, Globe, RefreshCw, SearchX, Trash2 } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { Checkbox } from "@repo/ui/components/checkbox"
import { cn } from "cn"
import { DomainActions } from "@/components/domain-actions"
import { DeleteDomainsDialog } from "@/components/delete-domain-dialog"
import { EmptyState } from "@/components/empty-state"
import { BulkBar } from "@/components/list/bulk-bar"
import { MotionBody, MotionRow } from "@/components/list/motion"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListTable,
  ListTile,
  selectedRowClass,
} from "@/components/list/table"
import {
  FilterSelect,
  ListToolbar,
  ResultsLine,
  SearchField,
} from "@/components/list/toolbar"
import { Status, StatusDot, describeStatus } from "@/components/status"
import { verifyDomain } from "@/lib/actions"
import { formatRelative } from "@/lib/format"
import { useResetWhen } from "@/lib/react"
import { toastDone, toastError } from "@/lib/toast"
import type { DomainSummary } from "@/lib/types"

/**
 * The domains, Resend's way: search, a status filter, a region filter, and a
 * table you can tick rows in.
 *
 * ⚠ A TABLE ONLY (2026-10-03). The grid showed the same four facts in cards
 * three to a row, which is less to scan, not more - and a workspace's domains
 * are a list you compare, not a gallery you browse.
 *
 * ⚠ FILTERED IN THE BROWSER. A workspace has a handful of domains and the
 * API returns all of them; a round trip per keystroke would only add latency.
 *
 * ⚠ THE OPTIONS ARE THE VALUES PRESENT, so a filter never offers a status no
 * domain is in.
 */
export function DomainsList({
  domains,
  scopedKeys,
}: {
  domains: DomainSummary[]
  /** Per domain name, the live keys that can ONLY send from it. */
  scopedKeys: Record<string, { id: string; name: string }[]>
}) {
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState("")
  const [region, setRegion] = React.useState("")

  const statusOf = (d: DomainSummary) => (d.displaced_at ? "displaced" : d.status)
  const statuses = [...new Set(domains.map(statusOf))]
  const regions = [...new Set(domains.map((d) => d.region))].sort()

  const q = query.trim().toLowerCase()
  const shown = domains.filter(
    (d) =>
      (!q || d.name.toLowerCase().includes(q)) &&
      (!status || statusOf(d) === status) &&
      (!region || d.region === region),
  )
  const filtered = status !== "" || region !== ""
  const clear = () => {
    setQuery("")
    setStatus("")
    setRegion("")
  }

  /*
   * ⚠ ONLY WHAT IS ON SCREEN CAN STAY TICKED. Narrowing the filter drops the
   * rows it hides from the selection, so the bar never offers to delete a
   * domain nobody can see.
   */
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [anchor, setAnchor] = React.useState<string | null>(null)
  const shownIds = shown.map((d) => d.id)
  const shownKey = shownIds.join(",")
  useResetWhen(shownKey, () =>
    setSelected((prev) => new Set([...prev].filter((id) => shownIds.includes(id)))),
  )
  const clearSelection = React.useCallback(() => setSelected(new Set()), [])

  function toggle(id: string, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      const on = !prev.has(id)
      if (shiftKey && anchor && shownIds.includes(anchor)) {
        const a = shownIds.indexOf(anchor)
        const b = shownIds.indexOf(id)
        for (const x of shownIds.slice(Math.min(a, b), Math.max(a, b) + 1)) {
          if (on) next.add(x)
          else next.delete(x)
        }
      } else if (on) next.add(id)
      else next.delete(id)
      return next
    })
    setAnchor(id)
  }

  const picked = shown.filter((d) => selected.has(d.id))
  const allTicked = shown.length > 0 && picked.length === shown.length

  const [deleting, setDeleting] = React.useState(false)
  // Held while the dialog closes, so its title does not change under the tick.
  const [deletingDomains, setDeletingDomains] = React.useState<DomainSummary[]>([])
  const [checking, setChecking] = React.useState(false)

  async function recheck() {
    if (checking) return
    setChecking(true)
    let verified = 0
    let failed = 0
    for (const d of picked) {
      const result = await verifyDomain(d.id)
      if (!result.ok) failed += 1
      else if (result.data.status === "verified") verified += 1
    }
    setChecking(false)
    const waiting = picked.length - verified - failed
    const summary = [
      verified > 0 && `${verified} verified`,
      waiting > 0 && `${waiting} still waiting on DNS`,
      failed > 0 && `${failed} could not be checked`,
    ]
      .filter(Boolean)
      .join(", ")
    if (failed === picked.length) toastError("Could not check the records", summary)
    else
      toastDone(
        `Checked ${picked.length} ${picked.length === 1 ? "domain" : "domains"}`,
        summary,
      )
  }

  const label = (d: DomainSummary) =>
    // ⚠ "FAILED" IS THE WRONG WORD FOR A DISPLACED DOMAIN. Nothing about its DNS
    // failed; another workspace proved it.
    d.displaced_at ? "Verified elsewhere" : undefined

  return (
    <div>
      <ListToolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search domains"
          label="Search domains"
        />
        {statuses.length > 1 && (
          <FilterSelect
            value={status}
            onValueChange={setStatus}
            label="Status"
            allLabel="All statuses"
            options={statuses.map((s) => {
              const described = describeStatus(s === "displaced" ? "failed" : s)
              return {
                value: s,
                label: s === "displaced" ? "Verified elsewhere" : described.label,
                icon: <StatusDot tone={described.tone} />,
              }
            })}
          />
        )}
        {regions.length > 1 && (
          <FilterSelect
            value={region}
            onValueChange={setRegion}
            label="Region"
            allLabel="All regions"
            options={regions.map((r) => ({ value: r, label: r }))}
          />
        )}
      </ListToolbar>

      <ResultsLine
        count={shown.length}
        query={query}
        filtered={filtered}
        noun={["domain", "domains"]}
        onClear={clear}
      />

      <div className="pt-4">
        {shown.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title="No domain matches"
            description={
              q
                ? `Nothing is called anything like “${query.trim()}”.`
                : "No domain is in that state."
            }
            secondary={
              <Button size="sm" variant="outline" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <ListTable>
            <ListHeader>
              <th className="w-10 py-2.5 pl-4">
                <Checkbox
                  checked={
                    allTicked ? true : picked.length > 0 ? "indeterminate" : false
                  }
                  aria-label="Select all domains"
                  onCheckedChange={(checked) =>
                    setSelected(checked === true ? new Set(shownIds) : new Set())
                  }
                />
              </th>
              <ListHead className="pl-0">Domain</ListHead>
              <ListHead className="w-[11rem]">Status</ListHead>
              <ListHead className="hidden w-[10rem] sm:table-cell">Setup</ListHead>
              <ListHead className="hidden w-[9rem] md:table-cell">Region</ListHead>
              <ListHead className="w-[9rem] text-right">Added</ListHead>
              <ListHead className="w-12">
                <span className="sr-only">Actions</span>
              </ListHead>
            </ListHeader>
            <MotionBody>
              {shown.map((d) => {
                const ticked = selected.has(d.id)
                return (
                  <MotionRow
                    key={d.id}
                    href={`/domains/${d.id}`}
                    className={cn(ticked && selectedRowClass)}
                  >
                    <td className="w-10 py-3 pl-4">
                      <Checkbox
                        checked={ticked}
                        aria-label={`Select ${d.name}`}
                        onClick={(event) => {
                          event.preventDefault()
                          toggle(d.id, event.shiftKey)
                        }}
                      />
                    </td>
                    <ListCell className="max-w-0 pl-0">
                      <div className="flex items-center gap-3">
                        <ListTile>
                          <Globe className="size-4" />
                        </ListTile>
                        <Link
                          href={`/domains/${d.id}`}
                          className="truncate font-medium outline-none hover:underline focus-visible:underline"
                        >
                          {d.name}
                        </Link>
                      </div>
                    </ListCell>
                    <ListCell>
                      <Status status={d.status} label={label(d)} />
                    </ListCell>
                    <ListCell className="hidden sm:table-cell">
                      <Badge variant={d.delegated ? "secondary" : "outline"}>
                        {d.delegated ? "Delegated" : "Manual records"}
                      </Badge>
                    </ListCell>
                    <ListCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                      {d.region}
                    </ListCell>
                    <ListCell
                      className="text-right text-xs whitespace-nowrap text-muted-foreground"
                      title={d.created_at}
                    >
                      {formatRelative(d.created_at)}
                    </ListCell>
                    <ListCell className="py-1.5 text-right">
                      <DomainActions
                        id={d.id}
                        name={d.name}
                        scopedKeys={scopedKeys[d.name] ?? []}
                      />
                    </ListCell>
                  </MotionRow>
                )
              })}
            </MotionBody>
          </ListTable>
        )}
      </div>

      <BulkBar count={picked.length} onClear={clearSelection} label="Selected domains">
        <Button
          variant="ghost"
          size="sm"
          className="rounded-xl"
          disabled={checking}
          onClick={() => void recheck()}
        >
          <RefreshCw className={cn(checking && "animate-spin")} />
          Re-check
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-xl"
          onClick={() =>
            void navigator.clipboard
              .writeText(picked.map((d) => d.name).join("\n"))
              .then(
                () =>
                  toastDone(
                    picked.length === 1 ? "Domain name copied" : "Domain names copied",
                  ),
                () => toastError("Could not copy the names"),
              )
          }
        >
          <Copy />
          Copy names
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            setDeletingDomains(picked)
            setDeleting(true)
          }}
        >
          <Trash2 />
          Delete
        </Button>
      </BulkBar>

      <DeleteDomainsDialog
        domains={deletingDomains.map((d) => ({
          id: d.id,
          name: d.name,
          scopedKeys: scopedKeys[d.name] ?? [],
        }))}
        open={deleting}
        onOpenChange={setDeleting}
        // The rows are gone behind the dialog; only the ticks are left to drop.
        onDeleted={clearSelection}
      />
    </div>
  )
}
