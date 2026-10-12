"use client"

import * as React from "react"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { History, RotateCcw, Send, SkipForward } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { Checkbox } from "@repo/ui/components/checkbox/checkbox"
import { Input } from "@repo/ui/components/i10/input"
import { Label } from "@repo/ui/components/i10/label"
import { motion } from "motion/react"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { EmptyState } from "@/components/empty-state"
import { FormDialog } from "@/components/form-dialog"
import { Status } from "@/components/status"
import { Time } from "@/components/time"
import { getWebhookReplay, startWebhookReplay, type ReplayMode } from "@/lib/actions"
import { formatNumber } from "@/lib/format"
import type { WebhookEndpoint, WebhookReplay } from "@/lib/types"

/**
 * Sending things again, in bulk (#282), and following it as it runs.
 *
 * ⚠ THREE ACTIONS, NOT ONE FORM WITH OPTIONS, because they answer three
 * different situations. "My receiver was down" is recover: failures only.
 * "I lost data and need it again" is a range, delivered ones included. "I
 * added this endpoint after the events happened" is the missing ones.
 *
 * ⚠ EACH RUNS IN THE BACKGROUND ON THE SERVER AND SURVIVES A RESTART. This
 * page only follows it: every running replay is read again every two seconds
 * until it is done or failed. Leaving the page loses nothing.
 */

const POLL_MS = 2000

const PRESETS = [
  { value: "3600", label: "Last hour" },
  { value: "21600", label: "Last 6 hours" },
  { value: "86400", label: "Last 24 hours" },
  { value: "259200", label: "Last 3 days" },
  { value: "604800", label: "Last 7 days" },
  { value: "1209600", label: "Last 14 days" },
  { value: "custom", label: "Custom range" },
] as const

const MODES: Record<
  ReplayMode,
  {
    title: string
    description: string
    button: string
    icon: React.ReactNode
  }
> = {
  recover: {
    title: "Recover failed deliveries",
    description:
      "Every delivery in the window that failed is sent again, once each, oldest first. Delivered ones are left alone.",
    button: "Recover failed",
    icon: <RotateCcw />,
  },
  replay: {
    title: "Replay a range",
    description:
      "Deliveries in the window are sent again, one attempt each. Your receiver gets duplicates of anything it already has, with the same webhook-id.",
    button: "Replay range",
    icon: <History />,
  },
  "replay-missing": {
    title: "Send what it never got",
    description:
      "Events in the window that this endpoint never received, such as those from before it was created or while it was paused.",
    button: "Send missing",
    icon: <SkipForward />,
  },
}

export function ReplaysPanel({
  endpoint,
  initial,
  eventTypes,
}: {
  endpoint: WebhookEndpoint
  initial: WebhookReplay[]
  eventTypes: string[]
}) {
  const [replays, setReplays] = React.useState(initial)
  const [mode, setMode] = React.useState<ReplayMode | null>(null)

  // ⚠ FOLLOWS THE SERVER WHEN THE PAGE RE-RENDERS (a new replay started from
  // here revalidates it), keeping any progress this poll has read since.
  const [seen, setSeen] = React.useState(initial)
  if (initial !== seen) {
    setSeen(initial)
    setReplays((current) => {
      const live = new Map(current.map((r) => [r.id, r]))
      return initial.map((r) => {
        const mine = live.get(r.id)
        return mine && mine.updated_at > r.updated_at ? mine : r
      })
    })
  }

  const active = replays.filter((r) => r.status === "queued" || r.status === "running")
  const activeKey = active.map((r) => r.id).join(",")

  React.useEffect(() => {
    if (!activeKey) return
    const ids = activeKey.split(",")
    let cancelled = false
    const timer = setInterval(async () => {
      const results = await Promise.all(
        ids.map((id) => getWebhookReplay(endpoint.id, id)),
      )
      if (cancelled) return
      setReplays((current) =>
        current.map((r) => {
          const fresh = results.find((x) => x.ok && x.data.id === r.id)
          return fresh && fresh.ok ? fresh.data : r
        }),
      )
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activeKey, endpoint.id])

  const off = !endpoint.enabled
  const polling = endpoint.kind === "polling"

  return (
    <div className="space-y-8">
      <Section className="pt-0">
        <SectionTitle>Send again</SectionTitle>
        <SectionDescription>
          {polling
            ? "A polling endpoint replays by cursor: pass an older cursor to read events again. Events it never got can still be added to its stream."
            : "Runs in the background. One delivery at a time can also be resent from its own page."}
        </SectionDescription>
        <SectionContent>
          {off && (
            <p className="mb-3 text-xs text-warning">
              Turn the endpoint back on first: nothing is sent to an endpoint that is
              off.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {(Object.keys(MODES) as ReplayMode[])
              .filter((m) => !polling || m === "replay-missing")
              .map((m) => (
                <Button
                  key={m}
                  variant={m === "recover" ? "primary" : "secondary"}
                  size="sm"
                  disabled={off}
                  onClick={() => setMode(m)}
                >
                  {MODES[m].icon}
                  {MODES[m].button}
                </Button>
              ))}
          </div>
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Replays</SectionTitle>
        <SectionContent>
          {replays.length === 0 ? (
            <EmptyState
              icon={<Send />}
              title="No replays yet"
              description="Recovering failures after an outage is the usual one. Each run and its progress shows here."
            />
          ) : (
            <ul className="divide-y overflow-hidden rounded-xl border">
              {replays.map((replay) => (
                <ReplayRow key={replay.id} replay={replay} />
              ))}
            </ul>
          )}
        </SectionContent>
      </Section>

      {mode && (
        <StartReplayDialog
          endpointId={endpoint.id}
          mode={mode}
          eventTypes={eventTypes}
          onClose={() => setMode(null)}
          onStarted={(replay) =>
            setReplays((current) => [
              replay,
              ...current.filter((r) => r.id !== replay.id),
            ])
          }
        />
      )}
    </div>
  )
}

function ReplayRow({ replay }: { replay: WebhookReplay }) {
  const running = replay.status === "queued" || replay.status === "running"
  const what =
    replay.kind === "replay_missing"
      ? "Missing events"
      : replay.filter.statuses?.length === 1 && replay.filter.statuses[0] === "failed"
        ? "Failed deliveries"
        : replay.filter.statuses?.includes("delivered")
          ? "Delivered and failed deliveries"
          : "Deliveries"
  /*
   * ⚠ NO PERCENTAGE: the API counts what it has looked at and what it has
   * sent, not a total up front, so the counts below are the progress.
   */
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {what}
            {replay.filter.event_type && (
              <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                {replay.filter.event_type}
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            <Time iso={replay.filter.since} mode="exact" /> to{" "}
            <Time iso={replay.filter.until} mode="exact" />
          </p>
        </div>
        <Status status={replay.status} />
      </div>
      {running && <Running />}
      <p className="tabular text-xs text-muted-foreground">
        {formatNumber(replay.queued)} sent of {formatNumber(replay.examined)} looked at
        {replay.finished_at ? (
          <>
            {" "}
            · finished <Time iso={replay.finished_at} />
          </>
        ) : (
          <>
            {" "}
            · started <Time iso={replay.created_at} />
          </>
        )}
      </p>
      {replay.error && (
        <p className="rounded-md border border-danger/25 bg-danger/5 px-2 py-1 font-mono text-2xs text-danger">
          {replay.error}
        </p>
      )}
    </li>
  )
}

function StartReplayDialog({
  endpointId,
  mode,
  eventTypes,
  onClose,
  onStarted,
}: {
  endpointId: string
  mode: ReplayMode
  eventTypes: string[]
  onClose: () => void
  onStarted: (replay: WebhookReplay) => void
}) {
  const [preset, setPreset] = React.useState<string>("86400")
  const [since, setSince] = React.useState("")
  const [until, setUntil] = React.useState("")
  const [includeDelivered, setIncludeDelivered] = React.useState(false)
  const [eventType, setEventType] = React.useState("all")
  const custom = preset === "custom"

  const range = () => {
    if (!custom) {
      return {
        since: new Date(Date.now() - Number(preset) * 1000).toISOString(),
      }
    }
    return {
      since: new Date(since).toISOString(),
      ...(until ? { until: new Date(until).toISOString() } : {}),
    }
  }

  const valid = !custom || (since !== "" && !Number.isNaN(new Date(since).getTime()))

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={MODES[mode].title}
      description={MODES[mode].description}
      submitLabel={MODES[mode].button}
      doneLabel="Started"
      canSubmit={valid}
      onSubmit={async () => {
        const result = await startWebhookReplay(endpointId, mode, {
          ...range(),
          ...(mode === "replay"
            ? {
                statuses: includeDelivered ? ["failed", "delivered"] : ["failed"],
                ...(eventType !== "all" ? { event_type: eventType } : {}),
              }
            : {}),
        })
        if (result.ok) onStarted(result.data)
        return result
      }}
    >
      <div className="space-y-1.5">
        <MorphSelect
          label="Window"
          value={preset}
          onValueChange={setPreset}
          items={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          className="w-full"
        />
      </div>

      {custom && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="replay-since">From</Label>
            <Input
              id="replay-since"
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="replay-until">To</Label>
            <Input
              id="replay-until"
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
            <p className="text-2xs text-muted-foreground">Empty for now.</p>
          </div>
        </div>
      )}

      {mode === "replay" && (
        <>
          <div className="space-y-1.5">
            <MorphSelect
              label="Event"
              value={eventType}
              onValueChange={setEventType}
              items={[
                { value: "all", label: "Every event" },
                ...eventTypes.map((t) => ({ value: t, label: t })),
              ]}
              className="w-full"
            />
          </div>
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={includeDelivered}
              onCheckedChange={(c) => setIncludeDelivered(c === true)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm">Include delivered ones</span>
              <span className="block text-xs text-muted-foreground">
                Off sends failures only. On sends everything in the window again.
              </span>
            </span>
          </label>
        </>
      )}
    </FormDialog>
  )
}

/** A replay has no total up front, so its bar says "working", not how far. */
function Running() {
  return (
    <div
      role="progressbar"
      aria-label="Replay running"
      className="relative h-1 overflow-hidden rounded-full bg-muted"
    >
      <motion.div
        className="absolute inset-y-0 w-1/3 rounded-full bg-info"
        initial={{ x: "-100%" }}
        animate={{ x: "300%" }}
        transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut" }}
      />
    </div>
  )
}
