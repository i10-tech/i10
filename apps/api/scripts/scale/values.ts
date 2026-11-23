/**
 * Value generators with the variety real data has: scripts other than Latin,
 * right-to-left text, emoji, combining marks, very long values, and the
 * near-duplicates and case variants that break `=` against `lower(...)`.
 *
 * Every generator takes an `Rng`, so output is a function of the seed.
 */
import type { Rng } from "./rng.js"

const GIVEN = [
  "Amira",
  "Omar",
  "Lena",
  "Noah",
  "Sofia",
  "Kenji",
  "Priya",
  "Mateo",
  "Chloé",
  "Zoë",
  "Björn",
  "Ana",
  "Ivan",
  "Fatima",
  "Yuki",
  "Lucas",
  "Mia",
  "Emre",
  "Olga",
  "Tariq",
] as const
const FAMILY = [
  "Haddad",
  "Smith",
  "García",
  "Nguyen",
  "Kowalski",
  "Müller",
  "Okafor",
  "Rossi",
  "Tanaka",
  "Johansson",
  "O'Brien",
  "Abdelkhalek",
  "Dubois",
  "Silva",
  "Novak",
  "Kim",
  "Levi",
  "Ali",
] as const
/** Names in scripts that sort, case-fold and measure differently from ASCII. */
const NON_LATIN = [
  "محمد عبد الخالق", // Arabic, RTL
  "שרה לוי", // Hebrew, RTL
  "山田 太郎", // CJK
  "Дмитрий Иванов", // Cyrillic (has case)
  "Ελένη Παππά", // Greek (final sigma folds differently)
  "김민준", // Hangul
  "สมชาย ใจดี", // Thai (no spaces between words)
  "Zoë Bárbara", // combining marks: NOT the same bytes as "Zoë Bárbara"
  "Renée 🚀 Ops", // emoji
  "👩‍👩‍👧 Family", // ZWJ sequence: one glyph, many code points
  "‮evil‬", // bidi override
] as const
const WORDS = [
  "acme",
  "globex",
  "initech",
  "umbrella",
  "stark",
  "wayne",
  "hooli",
  "vandelay",
  "wonka",
  "tyrell",
  "cyberdyne",
  "soylent",
  "aperture",
  "massive",
  "pied",
  "piper",
  "north",
  "wind",
  "blue",
  "harbor",
  "cedar",
  "lumen",
  "orbit",
  "quartz",
  "atlas",
  "nimbus",
  "delta",
  "fable",
] as const
const TLDS = [
  "com",
  "io",
  "co",
  "net",
  "org",
  "de",
  "fr",
  "co.uk",
  "com.au",
  "app",
  "dev",
  "tech",
  "sa",
  "eg",
] as const
const IDN = ["xn--mller-kva", "xn--caf-dma", "xn--80ak6aa92e", "xn--fiq228c"] as const
const SUBJECT = [
  "Your receipt",
  "Reset your password",
  "Welcome aboard",
  "Weekly digest",
  "Invoice #",
  "Your code is",
  "Action required",
  "Shipping update",
  "New sign-in",
  "Re: question",
] as const

/** Very long values: a 63 character DNS label, a 254 character address, a 998 character line. */
export const LONG_LABEL = "a".repeat(63)

export function personName(rng: Rng): string {
  const r = rng.next()
  if (r < 0.62) return `${rng.pick(GIVEN)} ${rng.pick(FAMILY)}`
  if (r < 0.9) return rng.pick(NON_LATIN)
  if (r < 0.95) return `${rng.pick(GIVEN)}`.toUpperCase()
  if (r < 0.98) return `${rng.pick(GIVEN)} ${"Long".repeat(rng.int(20, 60))}`
  return rng.pick(["", " ", "x"])
}

/** A company-ish second-level name, with near-duplicates of the same few words. */
export function orgWord(rng: Rng): string {
  const w = rng.pick(WORDS)
  const r = rng.next()
  if (r < 0.55) return w
  if (r < 0.75) return `${w}${rng.pick(WORDS)}`
  if (r < 0.85) return `${w}-${rng.pick(WORDS)}`
  if (r < 0.92) return `${w}${rng.int(1, 999)}`
  // Look-alikes: the same name a digit or a letter away.
  if (r < 0.97) return w.replace(/l/g, "1").replace(/o/g, "0")
  return rng.pick(IDN)
}

/**
 * A domain name, lowercase. `n` makes it unique when the caller needs that;
 * the label before it is where the variety is.
 */
export function domainName(rng: Rng, n: number): string {
  const r = rng.next()
  const base = `${orgWord(rng)}${n}`
  if (r < 0.7) return `${base}.${rng.pick(TLDS)}`
  if (r < 0.85)
    return `${rng.pick(["mail", "mg", "send", "em", "news"])}.${base}.${rng.pick(TLDS)}`
  if (r < 0.95) return `${base}.${rng.pick(TLDS)}`
  if (r < 0.99) return `${base}-${"x".repeat(rng.int(20, 40))}.${rng.pick(TLDS)}`
  return `${LONG_LABEL.slice(0, 63 - String(n).length)}${n}.${rng.pick(TLDS)}`
}

/** A local part: dots, plus-addressing, digits, and now and then a very long one. */
export function localPart(rng: Rng, n: number): string {
  const r = rng.next()
  const g = rng
    .pick(GIVEN)
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
  if (r < 0.5)
    return `${g}.${rng
      .pick(FAMILY)
      .normalize("NFKD")
      .replace(/[^a-zA-Z]/g, "")
      .toLowerCase()}${n}`
  if (r < 0.7) return `${g}${n}`
  if (r < 0.85) return `${g}+${rng.pick(["news", "billing", "test", "a"])}${n}`
  if (r < 0.95)
    return `${rng.pick(["support", "info", "billing", "noreply", "hello", "team"])}${n}`
  return `${g}${n}.${"x".repeat(rng.int(30, 54))}`
}

/** Mixed case, as a person types it into a form: `Amira.Haddad@Acme.COM`. */
export function caseVariant(rng: Rng, s: string): string {
  const r = rng.next()
  if (r < 0.4) return s.toUpperCase()
  if (r < 0.8)
    return s.replace(
      /(^|[.@])([a-z])/g,
      (_, p: string, c: string) => p + c.toUpperCase(),
    )
  return [...s].map((c) => (rng.chance(0.5) ? c.toUpperCase() : c)).join("")
}

export function subject(rng: Rng): string {
  const r = rng.next()
  if (r < 0.7) return `${rng.pick(SUBJECT)} ${rng.int(1000, 99999)}`
  if (r < 0.85) return `${rng.pick(SUBJECT)} - ${rng.pick(NON_LATIN)}`
  if (r < 0.95) return `🎉 ${rng.pick(SUBJECT)} ✅`
  if (r < 0.99)
    return `${rng.pick(SUBJECT)} ${"lorem ipsum ".repeat(rng.int(20, 80))}`.trim()
  return ""
}

/** A Clerk-shaped id (`user_2abc...`), base62 like Clerk's. */
export function clerkId(rng: Rng, prefix: "user" | "org" | "sess" | "orgmem"): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let s = "2"
  for (let i = 0; i < 26; i++) s += alphabet[Math.floor(rng.next() * 62)]
  return `${prefix}_${s}`
}

/** A slug from a name, ASCII only, with the tenant number to keep it unique. */
export function slugOf(name: string, n: number): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return `${ascii || "ws"}-${n}`
}

export function ipv4(rng: Rng): string {
  return `${rng.int(1, 223)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`
}

export const USER_AGENTS = [
  "curl/8.7.1",
  "node-fetch/1.0",
  "i10-node/2.3.0",
  "python-requests/2.32.3",
  "Go-http-client/2.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
  null,
] as const

export const COUNTRIES = [
  "US",
  "DE",
  "EG",
  "SA",
  "GB",
  "IN",
  "BR",
  "JP",
  "FR",
  null,
] as const
