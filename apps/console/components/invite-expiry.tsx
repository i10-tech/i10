"use client"

import * as React from "react"
import { ChipGroup } from "@repo/ui/components/chip-group/chip-group"
import { DatePicker } from "@repo/ui/components/date-picker/date-picker"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { TimePicker } from "@repo/ui/components/time-picker/time-picker"
import { timeZones, type ZoneCatalog } from "@/lib/actions"
import {
  DAY_MS,
  HOUR_MS,
  MAX_EXPIRY_MS,
  cityOf,
  expiryProblem,
  expirySummary,
  hhmm,
  instantIn,
  offsetIn,
  quickPick,
  wallIn,
} from "@/lib/invitations"

/**
 * When an invitation expires (#327): a date and a time, 1 hour to 7 days
 * ahead, in the invitee's time - a country (and, for a country with several,
 * which of its zones) or a time zone picked directly.
 *
 * ⚠ ONE INSTANT IS THE VALUE. The date and time fields show it as the wall
 * clock where the invitee is; changing where they are keeps the moment and
 * moves the clock, the way the same meeting reads differently in two cities.
 *
 * ⚠ ARC'S DATE PICKER AND TIME PICKER, side by side, as Arc's docs pair them
 * for a full timestamp; the quick picks are Arc's chip group.
 */

export interface Expiry {
  at: Date | null
  zone: string
  /** ISO country, when a country was picked rather than a zone. */
  country: string | null
}

const QUICK = [
  { value: String(HOUR_MS), label: "1 hour" },
  { value: String(DAY_MS), label: "1 day" },
  { value: String(3 * DAY_MS), label: "3 days" },
  { value: String(7 * DAY_MS), label: "7 days" },
]

export const yourZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Where a new invitation starts: seven days from now, in your own zone. */
export function defaultExpiry(now = new Date()): Expiry {
  return { at: quickPick(now, MAX_EXPIRY_MS), zone: yourZone(), country: null }
}

/** The zone catalogue, read once per page. */
let catalogue: Promise<ZoneCatalog | null> | null = null
function useZones() {
  const [zones, setZones] = React.useState<ZoneCatalog | null>(null)
  React.useEffect(() => {
    catalogue ??= timeZones().then((r) => (r.ok ? r.data : null))
    let live = true
    void catalogue.then((data) => {
      if (!live) return
      if (data) setZones(data)
      else catalogue = null
    })
    return () => {
      live = false
    }
  }, [])
  return zones
}

export function InviteExpiry({
  value,
  onChange,
}: {
  value: Expiry
  onChange: (next: Expiry) => void
}) {
  const zones = useZones()
  const [quick, setQuick] = React.useState<string[]>([String(MAX_EXPIRY_MS)])
  // Re-read each render: the summary says "from now", and now moves.
  const now = new Date()

  const where = React.useMemo(() => {
    const at = new Date()
    const countries = (zones?.countries ?? []).map((c) => ({
      value: `c:${c.code}`,
      label: c.name,
      meta:
        c.zones.length === 1
          ? offsetIn(at, c.zones[0]!.id)
          : `${c.zones.length} time zones`,
      keywords: `${c.code} ${c.zones.map((z) => z.city).join(" ")}`,
    }))
    const list = (zones?.zones ?? []).map((z) => ({
      value: `z:${z.id}`,
      label: z.city,
      meta: offsetIn(at, z.id),
      keywords: z.id.replace(/[/_]/g, " "),
    }))
    return [
      { label: "Countries", options: countries },
      { label: "Time zones", options: list },
    ]
  }, [zones])

  const country = zones?.countries.find((c) => c.code === value.country) ?? null
  // Your own zone is always on the list, even before the catalogue arrives.
  const items =
    zones === null ? [{ value: `z:${value.zone}`, label: cityOf(value.zone) }] : where

  const wall = value.at ? wallIn(value.at, value.zone) : null
  const day = wall ? new Date(wall.year, wall.month - 1, wall.day) : undefined
  const today = wallIn(now, value.zone)
  const last = wallIn(new Date(now.getTime() + MAX_EXPIRY_MS), value.zone)

  function setWall(next: { day?: Date; time?: string }) {
    const base = wall ?? wallIn(quickPick(now, MAX_EXPIRY_MS), value.zone)
    const [hour, minute] = (next.time ?? hhmm(base)).split(":").map(Number)
    const d = next.day
    setQuick([])
    onChange({
      ...value,
      at: instantIn(
        {
          year: d ? d.getFullYear() : base.year,
          month: d ? d.getMonth() + 1 : base.month,
          day: d ? d.getDate() : base.day,
          hour: hour ?? 0,
          minute: minute ?? 0,
        },
        value.zone,
      ),
    })
  }

  function pickWhere(choice: string) {
    if (choice.startsWith("c:")) {
      const code = choice.slice(2)
      const picked = zones?.countries.find((c) => c.code === code)
      if (!picked) return
      // A country with one zone needs no second choice; several start on the first.
      onChange({ ...value, country: code, zone: picked.zones[0]!.id })
    } else {
      onChange({ ...value, country: null, zone: choice.slice(2) })
    }
  }

  const problem = expiryProblem(value.at, now)

  return (
    <div className="flex flex-col gap-4">
      <ChipGroup
        label="Expires in"
        options={QUICK}
        value={quick}
        onValueChange={(next) => {
          setQuick(next)
          const ms = Number(next[0])
          if (ms) onChange({ ...value, at: quickPick(new Date(), ms) })
        }}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <MorphSelect
          label="Their location"
          items={items}
          value={value.country ? `c:${value.country}` : `z:${value.zone}`}
          onValueChange={pickWhere}
          searchable
          searchPlaceholder="Country, city or time zone"
          panelWidth={320}
        />
        {country && country.zones.length > 1 ? (
          <MorphSelect
            label={`Time zone in ${country.name}`}
            items={country.zones.map((z) => ({
              value: z.id,
              label: z.city,
              meta: offsetIn(now, z.id),
            }))}
            value={value.zone}
            onValueChange={(zone) => onChange({ ...value, zone })}
            searchable="auto"
          />
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <DatePicker
          label="Expires on"
          value={day}
          onChange={(next) => next && setWall({ day: next })}
          minDate={new Date(today.year, today.month - 1, today.day)}
          maxDate={new Date(last.year, last.month - 1, last.day)}
        />
        <TimePicker
          label="At"
          value={wall ? hhmm(wall) : undefined}
          onChange={(time) => setWall({ time })}
          minuteStep={5}
        />
      </div>
      <p
        className={problem ? "text-xs text-danger" : "text-xs text-muted-foreground"}
        aria-live="polite"
      >
        {problem ?? (value.at ? expirySummary(value.at, value.zone, now) : "")}
      </p>
    </div>
  )
}
