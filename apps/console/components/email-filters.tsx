"use client"

import {
  ListToolbar,
  ListToolbarEnd,
  UrlFilterMulti,
  UrlFilterSelect,
  UrlListResults,
  UrlListSearch,
  UrlRangeSelect,
} from "@/components/list/toolbar"
import { useUrlParam } from "@/components/list/url-state"
import { defaultEmailsRange } from "@/lib/range"
import { StatusDot, describeStatus } from "@/components/status"

/**
 * Filtering the delivery log: search, date range, status, domain and API key,
 * Resend's row of controls.
 *
 * ⚠ EVERY CONTROL WRITES TO THE URL AND NOTHING IS HELD IN REACT STATE EXCEPT
 * THE SEARCH BOX'S UNCOMMITTED TEXT. The page is a server component that reads
 * the query string, so a filter that lived in component state would have
 * nothing to fetch with. It also means back and forward work, and a filtered
 * view is a link somebody can paste into an incident channel.
 *
 * ⚠ THE SEARCH INPUT IS DEBOUNCED AND THE DEBOUNCE IS NOT OPTIONAL. Each commit
 * is a server round trip and an `ILIKE` across a partitioned table; firing one
 * per keystroke would issue a dozen expensive queries to render the result of
 * the last one. 350ms is long enough to swallow typing and short enough that
 * nobody notices waiting.
 */
/*
 * ⚠ THIS LIST IS EXACTLY WHAT `lastEvent` CAN RETURN, AND NOTHING ELSE. The
 * filter is applied against `last_event`, which is either the worst event by
 * severity (send/lookup.ts: `SEVERITY`) or, when there are no events yet, the
 * row's own `message_status` - with `queued` + a future `scheduled_at`
 * reported as `scheduled`. So the list is the severity table, plus the row
 * statuses that can survive to the fallback.
 *
 * ⚠ `sending` WAS MISSING, AND IT IS A REAL STATE A MESSAGE SITS IN. A worker
 * has claimed it and SES has not answered yet; leaving it out of the menu meant
 * there was no way to ask "what is in flight right now", which is the first
 * question during an incident.
 *
 * ⚠ AND `opened` AND `clicked` ARE DELIBERATELY ABSENT. They are not in
 * `SEVERITY`, so they can never BE a `last_event` - a message that was opened
 * is still `delivered`. Offering them here would be a filter that matches
 * nothing, every time, which reads as tracking being broken. Filtering by
 * engagement is a different query against `message_events` and is written up in
 * docs/decisions/console.md §7.
 */
const STATUSES = [
  "delivered",
  "sent",
  "sending",
  "bounced",
  "complained",
  "delivery_delayed",
  "failed",
  "queued",
  "scheduled",
  "canceled",
] as const

export function EmailFilters({
  domains,
  apiKeys,
  showDomains,
  showKeys,
}: {
  domains: { id: string; name: string }[]
  apiKeys: { id: string; name: string }[]
  // ⚠ FROM THE SHAPE, NOT THE LISTS: a skeleton has no lists, and must still
  // draw the filters the page will have.
  showDomains: boolean
  showKeys: boolean
}) {
  // The page reads the same default (emails/(index)/page.tsx), so the menu
  // shows the range the list was actually read over.
  const [apiKeyId] = useUrlParam("api_key_id")
  return (
    <ListToolbar>
      <UrlListSearch placeholder="Search subject or address" label="Search emails" />
      {/* No count: the log is a page of a cursor, so only Clear. */}
      <UrlListResults
        params={["search", "days", "status", "domain_id", "api_key_id", "broadcast_id"]}
      />
      <ListToolbarEnd>
        <UrlRangeSelect fallback={defaultEmailsRange(apiKeyId || undefined)} />
        <UrlFilterMulti
          param="status"
          label="Delivery state"
          allLabel="All statuses"
          noun="statuses"
          options={STATUSES.map((status) => {
            const described = describeStatus(status)
            return {
              value: status,
              label: described.label,
              icon: <StatusDot tone={described.tone} />,
            }
          })}
        />
        {showDomains && (
          <UrlFilterSelect
            param="domain_id"
            label="Domain"
            allLabel="All domains"
            triggerWidth={176}
            options={domains.map((d) => ({ value: d.id, label: d.name }))}
          />
        )}
        {showKeys && (
          <UrlFilterSelect
            param="api_key_id"
            label="API key"
            allLabel="All API keys"
            triggerWidth={176}
            options={apiKeys.map((k) => ({ value: k.id, label: k.name }))}
          />
        )}
      </ListToolbarEnd>
    </ListToolbar>
  )
}
