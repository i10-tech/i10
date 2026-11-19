import { type Currency, PACKS, type LangPack } from "./packs.js"
import { type Rng, pick, pickMany, randomString } from "./rng.js"
import type { Lang, Style } from "./types.js"

/**
 * The fill data for one mail: every value a template can name with `{key}`.
 *
 * All of it is fictional. Company and product names are coined words. Hosts are
 * built only from reserved names (hosts.ts). IP addresses come from the three
 * documentation ranges of RFC 5737. Names are common given and family names
 * combined at random. Values are made on first use and then kept, so a mail
 * that names `{amount}` twice shows the same amount twice.
 */

interface Brand {
  name: string
  legal: string
}

const BRANDS: Record<Style, Brand[]> = {
  "dev-terse": [
    { name: "Quorvane", legal: "Quorvane Labs Ltd" },
    { name: "Tendrel", legal: "Tendrel Systems Inc." },
    { name: "Brisbyl", legal: "Brisbyl Software GmbH" },
    { name: "Pellora", legal: "Pellora Technologies Ltd" },
    { name: "Zindrel", legal: "Zindrel Inc." },
    { name: "Lintwell", legal: "Lintwell Cloud Ltd" },
    { name: "Orbitrel", legal: "Orbitrel Labs, Inc." },
    { name: "Vantora", legal: "Vantora Software Ltd" },
    { name: "Kelmark", legal: "Kelmark Engineering Inc." },
    { name: "Hobsyl", legal: "Hobsyl Tools Ltd" },
  ],
  "consumer-friendly": [
    { name: "Mellowly", legal: "Mellowly Apps Inc." },
    { name: "Tidbeam", legal: "Tidbeam Ltd" },
    { name: "Gladnest", legal: "Gladnest Technologies Ltd" },
    { name: "Pixelwick", legal: "Pixelwick Studio Inc." },
    { name: "Orchardly", legal: "Orchardly Ltd" },
    { name: "Fablemint", legal: "Fablemint Inc." },
    { name: "Wanderlark", legal: "Wanderlark Travel Ltd" },
    { name: "Dewdrift", legal: "Dewdrift Apps Ltd" },
    { name: "Hollowberry", legal: "Hollowberry Inc." },
    { name: "Sunnyplum", legal: "Sunnyplum Ltd" },
  ],
  "formal-bank": [
    { name: "Halden Mutual", legal: "Halden Mutual Bank plc" },
    { name: "Corvane Savings", legal: "Corvane Savings Bank AG" },
    { name: "Alderyn Credit Union", legal: "Alderyn Credit Union Ltd" },
    { name: "Merrowby Trust", legal: "Merrowby Trust Bank Ltd" },
    { name: "Tessmark Bank", legal: "Tessmark Bank N.V." },
    { name: "Ostrel Financial", legal: "Ostrel Financial Services Ltd" },
    { name: "Vireo Direct", legal: "Vireo Direct Bank S.A." },
    { name: "Kestrane Building Society", legal: "Kestrane Building Society" },
  ],
  "small-shop": [
    { name: "Pinecone & Pewter", legal: "Pinecone & Pewter Ltd" },
    { name: "Larkspur Goods", legal: "Larkspur Goods LLC" },
    { name: "The Copper Wren", legal: "The Copper Wren Co." },
    { name: "Tallow Row", legal: "Tallow Row Ltd" },
    { name: "Marrow & Moss", legal: "Marrow & Moss Ltd" },
    { name: "Bramble Hollow", legal: "Bramble Hollow Co." },
    { name: "Fennel Street Supply", legal: "Fennel Street Supply Ltd" },
    { name: "Quillfeather Books", legal: "Quillfeather Books Ltd" },
    { name: "Ember Loom", legal: "Ember Loom Studio" },
  ],
}

/** Sender domains: always reserved, never a real company's. Weighted by repeats. */
const DOMAIN_SUFFIXES = [
  ".example",
  ".example",
  ".example",
  ".example",
  ".test",
  ".test",
  ".example.com",
  ".example.org",
  ".example.net",
  ".invalid",
]

const SUBDOMAINS = ["app", "accounts", "my", "www", "go"]
const SENDER_PREFIXES = ["", "mail.", "notify.", "send."]
const SUPPORT_LOCALS = ["support", "help", "care", "hello"]

const STREETS = [
  "Larkspur Row",
  "Quarry Lane",
  "Meridian Way",
  "Tanner Street",
  "Orchard Close",
]
const TOWNS = ["Velmora", "Ashbren", "Tarnwick", "Corvale", "Hollenby", "Marrowfield"]

const TEAMS = [
  "Ridgeline",
  "Cobalt Unit",
  "Meadowlark Design",
  "Northfork Labs",
  "Sundial Studio",
  "Atlas Row",
  "Paper Lantern",
  "Kiln & Co",
]
const PROJECTS = [
  "Website relaunch",
  "Mobile beta",
  "Billing migration",
  "Onboarding flow",
  "Customer research",
  "Q3 roadmap",
]
const DOCS = [
  "Launch checklist",
  "Pricing page copy",
  "API rate limits",
  "Design review notes",
  "Release plan",
  "Interview summary",
]
const COMMENTS = [
  "Looks good to me, I will merge this after lunch.",
  "Can you check the numbers on the second tab?",
  "I moved the deadline to Friday, does that work for you?",
  "Added the screenshots you asked for.",
  "Should we split this into two tickets?",
  "Thanks, that fixes it on my side.",
]
const TICKET_SUBJECTS = [
  "Cannot export my data as CSV",
  "Invoice shows the wrong billing address",
  "Question about seat limits",
  "Webhook retries are not firing",
  "Please change the billing email",
  "Sign-in code is slow to arrive",
]
const SERVICES = [
  "Dental check-up",
  "Haircut and finish",
  "Annual car service",
  "Eye test",
  "Consultation call",
  "Massage, 60 minutes",
]
const PLACES = [
  "Velmora Wellness Studio",
  "Ashbren Family Clinic",
  "Tarnwick Garage",
  "Corvale Hair & Co",
  "Hollenby Optical",
]
const CARRIERS = [
  "Brindle Freight",
  "Kestrel Parcel",
  "Plover Express",
  "Marlowe Couriers",
]
const DEVICES = [
  "Chrome on Windows 11",
  "Safari on iPhone",
  "Firefox on Ubuntu",
  "Edge on Windows 10",
  "Safari on macOS",
  "Chrome on Android",
  "Firefox on macOS",
]
const PLANS = ["Starter", "Pro", "Team", "Business", "Plus"]
const REPORTS = [
  "Monthly activity report",
  "Audit log export",
  "Billing history",
  "Team usage summary",
]
const KEY_NAMES = [
  "CI deploy key",
  "Production backend",
  "Staging environment",
  "Reporting script",
  "Mobile app",
]
const HANDLES = [
  "river",
  "maple",
  "orbit",
  "harbor",
  "cedar",
  "pixel",
  "lumen",
  "ember",
  "quartz",
  "tundra",
]
const ORDER_ITEMS: { name: string; base: number }[] = [
  { name: "Hand-poured candle, cedar", base: 18 },
  { name: "Linen tea towel, set of two", base: 24 },
  { name: "Stoneware mug, speckled", base: 16 },
  { name: "Wool throw, oatmeal", base: 85 },
  { name: "Notebook, dot grid", base: 12 },
  { name: "Ceramic planter, small", base: 22 },
  { name: "Beeswax wrap, three pack", base: 14 },
  { name: "Enamel camp cup", base: 11 },
]

export interface OrderLine {
  name: string
  quantity: number
  price: number
}

export interface FillOptions {
  rng: Rng
  lang: Lang
  style: Style
  year: number
}

type Filler = (c: FillContext) => string

function groupDigits(n: number, sep: string): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep)
}

export function formatMoney(minor: number, cur: Currency): string {
  const factor = cur.decimals === 2 ? 100 : 1
  const whole = Math.floor(minor / factor)
  const cents = minor % factor
  const number =
    cur.decimals === 2
      ? `${groupDigits(whole, cur.group)}${cur.decimal}${String(cents).padStart(2, "0")}`
      : groupDigits(whole, cur.group)
  const gap = cur.space ? " " : ""
  return cur.symbolFirst
    ? `${cur.symbol}${gap}${number}`
    : `${number}${gap}${cur.symbol}`
}

/** Fill values for one mail; see the placeholder table in `FILLERS`. */
export class FillContext {
  readonly rng: Rng
  readonly lang: Lang
  readonly style: Style
  readonly year: number
  readonly pack: LangPack
  private readonly memo = new Map<string, unknown>()

  constructor(opts: FillOptions) {
    this.rng = opts.rng
    this.lang = opts.lang
    this.style = opts.style
    this.year = opts.year
    this.pack = PACKS[opts.lang]
  }

  /** Makes a value once per mail and returns the same one afterwards. */
  once<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make())
    return this.memo.get(key) as T
  }

  brand(): Brand {
    return this.once("brand", () => pick(this.rng, BRANDS[this.style]))
  }

  host(): string {
    return this.once("host", () => {
      const slug = this.brand()
        .name.toLowerCase()
        .replace(/[^a-z0-9]/g, "")
      return `${slug}${pick(this.rng, DOMAIN_SUFFIXES)}`
    })
  }

  /** The domain mail is sent from, the value of the record's `from_domain`. */
  senderDomain(): string {
    return this.once("sender", () => `${pick(this.rng, SENDER_PREFIXES)}${this.host()}`)
  }

  appHost(): string {
    return this.once("appHost", () => `${pick(this.rng, SUBDOMAINS)}.${this.host()}`)
  }

  /** A link on the sender's own domain, with a tracking-style token. */
  link(path: string): string {
    return this.once(`link:${path}`, () => {
      const token = randomString(this.rng, "abcdefghijklmnopqrstuvwxyz0123456789", 24)
      return `https://${this.appHost()}/${path}?t=${token}`
    })
  }

  currency(): Currency {
    return this.once("currency", () => pick(this.rng, this.pack.currencies))
  }

  /** A price in minor units, scaled to the currency. */
  price(base: number): number {
    const cur = this.currency()
    const major = base * cur.scale
    if (cur.decimals === 0) return Math.max(100, Math.round(major / 100) * 100)
    return Math.round(major) * 100 + pick(this.rng, [0, 0, 50, 99])
  }

  money(minor: number): string {
    return formatMoney(minor, this.currency())
  }

  /** `base` price, tax and total of a subscription charge, in minor units. */
  charge(): { price: number; tax: number; total: number } {
    return this.once("charge", () => {
      const price = this.price(5 + this.rng.int(115))
      const tax = Math.round(price * pick(this.rng, [0, 0.07, 0.1, 0.19, 0.2]))
      return { price, tax, total: price + tax }
    })
  }

  usage(): { pct: number; limit: number } {
    return this.once("usage", () => ({
      pct: pick(this.rng, [80, 90, 100]),
      limit: pick(this.rng, [1000, 5000, 10000, 50000]),
    }))
  }

  order(): { lines: OrderLine[]; subtotal: number; shipping: number; total: number } {
    return this.once("order", () => {
      const lines = pickMany(this.rng, ORDER_ITEMS, 1 + this.rng.int(3)).map(
        (item) => ({
          name: item.name,
          quantity: 1 + this.rng.int(3),
          price: this.price(item.base),
        }),
      )
      const subtotal = lines.reduce((sum, l) => sum + l.price * l.quantity, 0)
      const shipping = pick(this.rng, [0, this.price(5)])
      return { lines, subtotal, shipping, total: subtotal + shipping }
    })
  }

  /** A person per slot; the recipient is "self" and every other slot differs from it. */
  person(slot = "self"): { given: string; family: string; full: string } {
    return this.once(`person:${slot}`, () => {
      const glue = this.lang === "zh" ? "" : " "
      for (;;) {
        const given = pick(this.rng, this.pack.given)
        const family = pick(this.rng, this.pack.family)
        const full = this.pack.familyFirst
          ? `${family}${glue}${given}`
          : `${given}${glue}${family}`
        if (slot === "self" || full !== this.person().full)
          return { given, family, full }
      }
    })
  }

  /** A date in the generation year, `offsetDays` after a random base date. */
  date(slot: string, offsetDays = 0): string {
    return this.once(`date:${slot}`, () => {
      const base = this.once("baseDate", () => ({
        month: this.rng.int(10),
        day: 1 + this.rng.int(28),
      }))
      const d = new Date(Date.UTC(this.year, base.month, base.day + offsetDays))
      const month = this.pack.months[d.getUTCMonth()] ?? ""
      const day = d.getUTCDate()
      const year = d.getUTCFullYear()
      switch (this.lang) {
        case "en":
          return this.rng.chance(0.5)
            ? `${month} ${day}, ${year}`
            : `${day} ${month} ${year}`
        case "es":
        case "pt":
          return `${day} de ${month} de ${year}`
        case "de":
          return `${day}. ${month} ${year}`
        case "ja":
        case "zh":
          return `${year}年${month}${day}日`
        default:
          return `${day} ${month} ${year}`
      }
    })
  }

  time(): string {
    return this.once("time", () => {
      const h = this.rng.int(24)
      const m = String(this.rng.int(60)).padStart(2, "0")
      const zone = pick(this.rng, this.pack.timeZones)
      if (this.lang === "en" && this.rng.chance(0.5)) {
        const hour12 = h % 12 === 0 ? 12 : h % 12
        return `${hour12}:${m} ${h < 12 ? "AM" : "PM"} ${zone}`
      }
      return `${String(h).padStart(2, "0")}:${m} ${zone}`
    })
  }
}

const num = (min: number, span: number) => (c: FillContext) =>
  String(min + c.rng.int(span))

/** Every placeholder a template may use. An unknown one is an error at render. */
export const FILLERS: Record<string, Filler> = {
  product: (c) => c.brand().name,
  company: (c) => c.brand().legal,
  host: (c) => c.host(),
  support: (c) =>
    `${c.once("supportLocal", () => pick(c.rng, SUPPORT_LOCALS))}@${c.host()}`,
  address: (c) =>
    c.once(
      "address",
      () =>
        `${1 + c.rng.int(180)} ${pick(c.rng, STREETS)}, ${pick(c.rng, TOWNS)} ${10000 + c.rng.int(89999)}`,
    ),
  ship_to: (c) =>
    `${1 + c.rng.int(180)} ${pick(c.rng, STREETS)}, ${pick(c.rng, TOWNS)}`,
  name: (c) => c.person().full,
  first: (c) => c.person().given,
  inviter: (c) => c.person("inviter").full,
  inviter_first: (c) => c.person("inviter").given,
  actor: (c) => c.person("actor").full,
  agent: (c) => c.person("agent").given,
  email: (c) =>
    c.once(
      "email",
      () =>
        `${pick(c.rng, HANDLES)}${10 + c.rng.int(990)}@${pick(c.rng, ["example.com", "example.net", "example.org"])}`,
    ),
  team: (c) => c.once("team", () => pick(c.rng, TEAMS)),
  project: (c) => pick(c.rng, PROJECTS),
  doc: (c) => pick(c.rng, DOCS),
  plan: (c) => c.once("plan", () => pick(c.rng, PLANS)),
  period: (c) =>
    c.once("period", () => pick(c.rng, [c.pack.period.month, c.pack.period.year])),
  code: (c) => c.once("code", () => String(100000 + c.rng.int(900000))),
  minutes: (c) => String(pick(c.rng, [10, 15, 30, 60])),
  hours: (c) => String(pick(c.rng, [24, 48, 72])),
  device: (c) => c.once("device", () => pick(c.rng, DEVICES)),
  location: (c) => c.once("location", () => pick(c.rng, c.pack.cities)),
  ip: (c) =>
    c.once(
      "ip",
      () =>
        `${pick(c.rng, ["192.0.2.", "198.51.100.", "203.0.113."])}${1 + c.rng.int(254)}`,
    ),
  time: (c) => c.time(),
  date: (c) => c.date("date"),
  date2: (c) => c.date("date2", 3 + c.rng.int(25)),
  eta: (c) => c.date("eta", 2 + c.rng.int(6)),
  appt_date: (c) => c.date("appt", 4 + c.rng.int(30)),
  appt_time: (c) =>
    c.once(
      "apptTime",
      () =>
        `${String(8 + c.rng.int(9)).padStart(2, "0")}:${pick(c.rng, ["00", "15", "30", "45"])}`,
    ),
  amount: (c) => c.money(c.charge().total),
  price: (c) => c.money(c.charge().price),
  tax: (c) => c.money(c.charge().tax),
  subtotal: (c) => c.money(c.order().subtotal),
  shipping: (c) => c.money(c.order().shipping),
  order_total: (c) => c.money(c.order().total),
  last4: (c) => c.once("last4", () => String(1000 + c.rng.int(9000))),
  invoice: (c) =>
    c.once("invoice", () => `INV-${String(c.year)}-${String(1000 + c.rng.int(9000))}`),
  order: (c) =>
    c.once("orderId", () =>
      pick(c.rng, [
        `#${10000 + c.rng.int(89999)}`,
        `ORD-${c.year}-${String(100000 + c.rng.int(899999))}`,
        `${randomString(c.rng, "ABCDEFGHJKLMNPQRSTUVWXYZ", 3)}-${1000 + c.rng.int(8999)}`,
      ]),
    ),
  tracking: (c) =>
    c.once(
      "tracking",
      () =>
        `BF${String(c.rng.int(1e9)).padStart(9, "0")}${randomString(c.rng, "0123456789", 3)}`,
    ),
  carrier: (c) => c.once("carrier", () => pick(c.rng, CARRIERS)),
  service: (c) => c.once("service", () => pick(c.rng, SERVICES)),
  provider: (c) => c.person("provider").full,
  place: (c) => c.once("place", () => pick(c.rng, PLACES)),
  ticket: (c) => `#${10000 + c.rng.int(89999)}`,
  ticket_subject: (c) => c.once("ticketSubject", () => pick(c.rng, TICKET_SUBJECTS)),
  comment: (c) => pick(c.rng, COMMENTS),
  n1: num(2, 30),
  n2: num(1, 25),
  n3: num(3, 40),
  report: (c) => pick(c.rng, REPORTS),
  fmt: (c) => pick(c.rng, ["CSV", "JSON", "PDF"]),
  size: (c) => `${(1 + c.rng.int(90)) / 10} MB`,
  days: (c) => String(pick(c.rng, [7, 14, 30])),
  days_left: (c) => String(pick(c.rng, [1, 3, 7])),
  key_name: (c) => c.once("keyName", () => pick(c.rng, KEY_NAMES)),
  key_hint: (c) =>
    `${c
      .brand()
      .name.toLowerCase()
      .replace(/[^a-z]/g, "")
      .slice(0, 3)}_****${randomString(c.rng, "abcdef0123456789", 4)}`,
  pct: (c) => String(c.usage().pct),
  limit: (c) => groupDigits(c.usage().limit, ","),
  used: (c) => groupDigits(Math.round((c.usage().limit * c.usage().pct) / 100), ","),
  version: (c) => `${1 + c.rng.int(3)}.${c.rng.int(30)}.${c.rng.int(10)}`,
  year: (c) => String(c.year),
}
