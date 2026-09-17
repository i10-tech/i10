/**
 * Formatting shared across the console.
 *
 * ⚠ EVERY FUNCTION HERE IS PURE AND SAFE ON THE SERVER *AND* THE CLIENT, which
 * is why the file has no "use client" and no `server-only`. Half of these are
 * called inside server components rendering a table and half inside a client
 * component re-rendering a filter; two copies with slightly different rounding
 * is how the same number ends up different in two places on one screen.
 *
 * ⚠ AND NONE OF THEM PASS A LOCALE. `toLocaleString()` with no argument uses
 * the runtime's locale — which on the SERVER is the container's (always
 * `en-US`, because that is what the base image sets) and in the BROWSER is the
 * person's. A date rendered on the server and re-rendered on the client can
 * therefore differ, and React calls that a hydration mismatch. Everything that
 * formats a date below is used in a client component or is explicitly UTC; the
 * one exception is `formatDay`, which takes an already-UTC `YYYY-MM-DD`.
 */

/** 1,234 · 12,345 · 1,234,567 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value)
}

/**
 * 1.2K · 45K · 1.2M — for places where the exact figure does not fit.
 *
 * ⚠ USED IN THE RAIL AND IN STAT TILES, NEVER IN A TABLE CELL OR AN INVOICE.
 * "45K" is fine as a sense of scale and useless as a number somebody is
 * checking; anywhere the precise value matters, `formatNumber` is correct.
 */
export function formatCompact(value: number): string {
  if (value < 1000) return String(value)
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
}

/**
 * Bytes, in the units a person expects.
 *
 * ⚠ BASE 1024 WITH THE `KB`/`MB` SPELLING, WHICH IS TECHNICALLY WRONG AND
 * DELIBERATE. `KiB` is correct and nobody outside this file says it; every
 * mail client, every hosting panel and every operating system shows 1024 bytes
 * as 1 KB. Being right here means being the only place in the product that
 * disagrees with the storage figure the customer sees in their own mail client.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  )
  const value = bytes / Math.pow(1024, exponent)
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

/** A percentage of a total, guarding the zero denominator. */
export function formatRate(part: number, total: number): string {
  // ⚠ `0%` RATHER THAN `NaN%` OR A DASH. A tenant who has sent nothing has a
  // 0% bounce rate, which is true and is what they expect to see; `—` reads as
  // "we could not work it out".
  if (total === 0) return "0%"
  const rate = (part / total) * 100
  // Two decimals below 1% because a complaint rate is judged against 0.08% —
  // rounding that to "0%" hides the one number deliverability depends on.
  return rate < 1 ? `${rate.toFixed(2)}%` : `${rate.toFixed(1)}%`
}

/** `2026-09-17` → `17 Sep`. The input is already a UTC calendar day. */
export function formatDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number)
  if (!year || !month || !date) return day
  // ⚠ CONSTRUCTED AS UTC, NOT PARSED FROM THE STRING. `new Date("2026-09-17")`
  // is parsed as UTC midnight and then RENDERED in local time, so anybody west
  // of Greenwich sees the 16th. Building the date from parts in UTC and
  // formatting with `timeZone: "UTC"` keeps the calendar day the one the
  // database meant.
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })
}

/**
 * "2 minutes ago", "3 days ago".
 *
 * ⚠ IT RETURNS AN ABSOLUTE DATE PAST A WEEK, because "37 days ago" is a number
 * somebody has to do arithmetic on. Relative time is useful exactly while it is
 * still relative to now.
 *
 * ⚠ AND IT READS `Date.now()`, SO IT HAS THE SAME RULE AS `formatExact`: not
 * during the first render of a client component. A row that is 59 seconds old
 * on the server and 61 seconds old at hydration says two different things, and
 * React treats that as a mismatch. Use `<Time>`.
 */
export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso

  const seconds = Math.round((Date.now() - then) / 1000)

  if (seconds < 45) return "just now"
  if (seconds < 90) return "a minute ago"

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minutes ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`

  const days = Math.round(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`

  return new Date(then).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    ...(new Date(then).getUTCFullYear() === new Date().getUTCFullYear()
      ? {}
      : { year: "numeric" }),
  })
}

/**
 * `17 Sep 2026, 14:32:05` — the precise form, for a detail page.
 *
 * ⚠ IT FORMATS IN THE RUNTIME'S TIME ZONE, SO IT MUST NOT BE CALLED DURING THE
 * FIRST RENDER OF A CLIENT COMPONENT. The server container is UTC and the
 * reader is not, so the two passes disagree by hours and React discards the
 * server HTML for that subtree. In a client component, render it through
 * `<Time>`, which holds `formatUtc` until mounted. In a server component it is
 * fine — that output is never re-rendered in the browser.
 */
export function formatExact(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

/**
 * `550 5.1.1 User unknown` → the first line, trimmed.
 *
 * ⚠ SMTP ERRORS ARRIVE AS MULTI-LINE STRINGS WITH THE WHOLE SERVER RESPONSE IN
 * THEM. Rendering one raw into a table cell blows the row height out to fifteen
 * lines and pushes every other row off screen. The full text is on the detail
 * page; this is the summary.
 */
export function firstLine(value: string, max = 120): string {
  const line = value.split("\n")[0]?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * `bob@acme.com` → `bob@acme.com`, `Acme <bob@acme.com>` → `bob@acme.com`.
 *
 * ⚠ THE DISPLAY NAME IS DROPPED FOR THE *COMPACT* COLUMN ONLY. A `from` of
 * `"Acme Support" <support@acme.com>` is 34 characters of which 14 are the same
 * on every row; the address is the part that differs. The full value is shown
 * on the detail page and in the title attribute.
 */
export function bareAddress(value: string): string {
  const match = value.match(/<([^>]+)>/)
  return (match?.[1] ?? value).trim()
}

/**
 * The same instant, formatted identically wherever it is rendered.
 *
 * ⚠ EXPLICIT `timeZone: "UTC"` AND AN EXPLICIT LOCALE, WHICH IS THE WHOLE POINT
 * OF THE FUNCTION. It is what a client component renders BEFORE hydration, so
 * the server pass and the browser's first pass have to agree exactly — and they
 * only do if neither of them is allowed to consult the machine it is running
 * on. `formatExact` and `formatRelative` both do, which is why they cannot be
 * used until after mount. See components/time.tsx.
 *
 * ⚠ AND IT SAYS "UTC" OUT LOUD. A timestamp shown in a zone that is not the
 * reader's, without saying so, is worse than one they have to convert — they
 * will read it as local and be wrong by hours. It is on screen for one frame,
 * but a slow hydration makes that frame visible.
 */
export function formatUtc(iso: string, mode: "relative" | "exact" = "exact"): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso

  if (mode === "relative") {
    // Short, because it sits in a narrow "when" column. The exact form is in
    // the `title`, which is stable too.
    return date.toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    })
  }

  return `${date.toLocaleString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })} UTC`
}

/** `1234` → `1.2s`, `45` → `45ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
}
