/**
 * Countries, their time zones, and how an invitation's expiry is worded in
 * one of them (#327).
 *
 * ⚠ NO THIRD-PARTY API AND NO BUNDLED TABLE. Zone rules (daylight saving, a
 * government moving its clocks) come from the IANA database built into the
 * runtime's `Intl`; a country's zones from `Intl.Locale#getTimeZones`, its name
 * from `Intl.DisplayNames`. Staying current means keeping Bun current.
 *
 * ⚠ COMPUTED HERE, ON THE SERVER, AND SENT TO THE CONSOLE. Some browsers have
 * no `getTimeZones`; Bun 1.4.2 has all of it (445 zones). The browser only
 * formats, which every one of them can do.
 */

export interface CountryZones {
  /** ISO 3166-1 alpha-2. */
  code: string
  name: string
  /** One, or several for a country like the US. */
  zones: { id: string; city: string }[]
}

export interface ZoneCatalog {
  countries: CountryZones[]
  zones: { id: string; city: string }[]
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** "America/Argentina/Buenos_Aires" is "Buenos Aires". */
export function cityOf(zone: string): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC"
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ")
}

/** The zones a country uses, as the runtime knows them; [] for none. */
export function zonesOfCountry(code: string): string[] {
  try {
    const locale = new Intl.Locale(`und-${code}`) as Intl.Locale & {
      getTimeZones?: () => string[] | undefined
      timeZones?: string[]
    }
    return locale.getTimeZones?.() ?? locale.timeZones ?? []
  } catch {
    return []
  }
}

let cached: ZoneCatalog | null = null

/**
 * Every country with at least one zone, and every zone.
 *
 * ⚠ COUNTRIES ARE FOUND BY ASKING, NOT LISTED. There is no `Intl` list of
 * regions, so all 676 two-letter codes are tried; a code the runtime has no
 * zones for, or no name for, is not a country it can speak about.
 */
export function zoneCatalog(): ZoneCatalog {
  if (cached) return cached
  const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" })
  const countries: CountryZones[] = []
  for (const a of LETTERS) {
    for (const b of LETTERS) {
      const code = `${a}${b}`
      const zones = zonesOfCountry(code)
      if (zones.length === 0) continue
      const name = names.of(code)
      if (!name || name === code) continue
      countries.push({
        code,
        name,
        zones: zones.map((id) => ({ id, city: cityOf(id) })),
      })
    }
  }
  countries.sort((x, y) => x.name.localeCompare(y.name))
  const zones = Intl.supportedValuesOf("timeZone").map((id) => ({
    id,
    city: cityOf(id),
  }))
  cached = { countries, zones }
  return cached
}

/** Whether the runtime can format in this zone. */
export function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * The zone and country an expiry is worded in, checked: a country must use
 * that zone. `null` for anything the runtime does not know.
 */
export function resolveZone(input: {
  zone: unknown
  country?: unknown
}): { zone: string; country: string | null } | null {
  if (typeof input.zone !== "string" || !isZone(input.zone)) return null
  if (input.country === undefined || input.country === null || input.country === "")
    return { zone: input.zone, country: null }
  if (typeof input.country !== "string" || !/^[A-Z]{2}$/.test(input.country))
    return null
  return zonesOfCountry(input.country).includes(input.zone)
    ? { zone: input.zone, country: input.country }
    : null
}

/** "3:00 PM" in that zone. */
export function timeIn(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at)
}

/** "GMT+2" for that zone at that instant - daylight saving included. */
export function offsetIn(at: Date, zone: string): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")
  return part?.value ?? "GMT"
}

/** "15 March" in that zone. */
export function dayIn(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    day: "numeric",
    month: "long",
  }).format(at)
}

/**
 * How an invitation email states its expiry: "15 March at 3:00 PM Paris time"
 * for a country, "15 March at 3:00 PM GMT+2" for a zone picked directly.
 *
 * ⚠ THE COUNTRY FORM NAMES THE CITY, NOT THE COUNTRY. "Paris time" is what
 * people say; for a country with several zones the admin chose one, and its
 * city is the honest name for it.
 */
export function expiryForEmail(
  at: Date,
  where: { zone: string; country: string | null },
): string {
  const clock = timeIn(at, where.zone)
  const day = dayIn(at, where.zone)
  return where.country
    ? `${day} at ${clock} ${cityOf(where.zone)} time`
    : `${day} at ${clock} ${offsetIn(at, where.zone)}`
}

/** "1 day 12 hours", "3 hours", "45 minutes": the two largest units. */
export function spanOf(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const parts: string[] = []
  if (days > 0) parts.push(unit(days, "day"))
  if (hours > 0) parts.push(unit(hours, "hour"))
  if (days === 0 && mins > 0) parts.push(unit(mins, "minute"))
  return parts.slice(0, 2).join(" ") || "less than a minute"
}
