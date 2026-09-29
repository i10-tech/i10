import { parse } from "tldts"
import { fingerprint, linkHosts } from "../risk/fingerprint.js"
import {
  joinBody,
  match,
  render,
  skeletonHash,
  splitBody,
  staticBytes,
  type BodyParts,
  type Template,
} from "./templates.js"

/**
 * Trusted content (#222): whether a message IS a piece of known public
 * boilerplate, or one of its workspace's staff-approved templates, with only
 * its holes filled in.
 *
 * ⚠ THE EXISTING MATCHER, BYTE FOR BYTE. Credit needs `match()` from
 * content/templates.ts to fit the whole body - every static byte where the
 * skeleton says - so the only freedom a sender has is the holes. Nothing here
 * is fuzzy: "close to the approved template" gets no credit at all.
 *
 * ⚠ AND THE HOLES ARE FENCED. Each has a length limit; none may carry markup
 * (`<` or `>`), so a hole cannot open a new paragraph or a new link; and any
 * link or hostname a hole carries must be on the SENDING workspace's own
 * verified domains and clean in Web Risk. That is what makes "submit something
 * clean, then send something else through the holes" not work.
 *
 * ⚠ PURE, APART FROM THE VERDICT CALLBACK. The caller decides where Web Risk
 * verdicts come from (the accept path reads the cache only; the hourly job may
 * spend the daily budget), and an unknown verdict is a no.
 */

/** `{{name}}` marks a hole in a submission. */
export const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]{0,63})\s*\}\}/g
export const DEFAULT_HOLE_MAX = 100
export const MAX_HOLE_MAX = 1_000
export const MAX_TRUSTED_HOLES = 32
/** Below this much fixed text there is nothing distinctive to approve. */
export const MIN_STATIC_BYTES = 100
/** A submission's html and text, each. */
export const MAX_SUBMISSION_BYTES = 200_000

export interface Hole {
  name: string
  max: number
}

export interface Skeleton {
  template: Template
  holes: Hole[]
  skeletonHash: string
  bands: string[]
  staticBytes: number
  /** Hosts the fixed part links to. Staff check them before approving. */
  staticHosts: string[]
}

export interface SubmissionInput {
  html: string | null
  text: string | null
  /** Longest value per hole name; unnamed holes get `DEFAULT_HOLE_MAX`. */
  holes?: Record<string, number>
}

/**
 * A submission, with `{{name}}` wherever a value goes, as a skeleton.
 *
 * ⚠ THE VARIABLE PARTS MAY NOT OUTWEIGH THE FIXED ONE. The sum of the hole
 * limits must not exceed the fixed text; otherwise the "template" is a frame
 * around whatever the sender likes, and approving it approves nothing.
 */
export function parseSubmission(input: SubmissionInput): Skeleton | { error: string } {
  const html = input.html === "" ? null : input.html
  const text = input.text === "" ? null : input.text
  if (html === null && text === null) return { error: "Give `html`, `text` or both." }
  if (
    (html?.length ?? 0) > MAX_SUBMISSION_BYTES ||
    (text?.length ?? 0) > MAX_SUBMISSION_BYTES
  )
    return {
      error: `\`html\` and \`text\` are limited to ${MAX_SUBMISSION_BYTES} characters each.`,
    }
  const joined = joinBody({ html, text })
  if (joined === null)
    return { error: "The body contains a control character we cannot store." }

  const segments: string[] = []
  const names: string[] = []
  let last = 0
  for (const m of joined.matchAll(PLACEHOLDER)) {
    segments.push(joined.slice(last, m.index))
    names.push(m[1]!)
    last = m.index + m[0].length
  }
  segments.push(joined.slice(last))

  if (names.length > MAX_TRUSTED_HOLES)
    return { error: `At most ${MAX_TRUSTED_HOLES} placeholders.` }
  // ⚠ TWO HOLES SIDE BY SIDE ARE ONE HOLE WITH TWO NAMES: nothing fixed
  // between them says where one value ends, so the limits mean nothing.
  for (let i = 1; i < segments.length - 1; i++) {
    if (segments[i] === "")
      return { error: "Two placeholders must be separated by fixed text." }
  }
  const limits = input.holes ?? {}
  for (const [name, max] of Object.entries(limits)) {
    if (!names.includes(name)) return { error: `No placeholder named {{${name}}}.` }
    if (!Number.isInteger(max) || max < 1 || max > MAX_HOLE_MAX)
      return {
        error: `The limit for {{${name}}} must be between 1 and ${MAX_HOLE_MAX}.`,
      }
  }
  const holes = names.map((name) => ({ name, max: limits[name] ?? DEFAULT_HOLE_MAX }))
  const template: Template = { segments }
  const fixed = staticBytes(template)
  if (fixed < MIN_STATIC_BYTES)
    return { error: `The fixed text must be at least ${MIN_STATIC_BYTES} characters.` }
  const variable = holes.reduce((n, h) => n + h.max, 0)
  if (variable > fixed)
    return {
      error:
        "The placeholders' limits add up to more than the fixed text. Lower the limits " +
        "(`holes`) or submit more of the email as fixed text.",
    }

  const empty = splitBody(render(template, []))
  return {
    template,
    holes,
    skeletonHash: skeletonHash(template),
    bands: fingerprint(null, empty.html, empty.text)?.bands ?? [],
    staticBytes: fixed,
    staticHosts: linkHosts(empty.html, empty.text),
  }
}

/** The submission as staff read it: the skeleton with its holes named. */
export function describe(template: Template, holes: readonly Hole[]): BodyParts {
  return splitBody(
    render(
      template,
      holes.map((h) => `{{${h.name}}}`),
    ),
  )
}

// ─── Matching ────────────────────────────────────────────────────────────────

export interface TrustEntry {
  kind: "boilerplate" | "template"
  id: string
  name: string
  template: Template
  /** Longest value per hole, in order. */
  limits: number[]
}

export type Verdict = "clean" | "unsafe" | "unknown"

export interface TrustContext {
  /** Registrable parents of the sending workspace's verified domains. */
  verifiedParents: ReadonlySet<string>
  verdict: (host: string) => Promise<Verdict>
}

export interface TrustMatch {
  entry: TrustEntry
  values: string[]
}

/** `boilerplate:<id>` or `template:<id>`: what a fingerprint or vector records. */
export const trustMark = (e: Pick<TrustEntry, "kind" | "id">) => `${e.kind}:${e.id}`

/**
 * The entry a body IS, holes filled within their fences, or null.
 *
 * ⚠ THE WORKSPACE'S OWN TEMPLATES FIRST, then boilerplate: the more specific
 * credit is the one staff will want to see.
 */
export async function classify(
  parts: BodyParts,
  entries: readonly TrustEntry[],
  ctx: TrustContext,
): Promise<TrustMatch | null> {
  const joined = joinBody(parts)
  if (joined === null) return null
  const ordered = [
    ...entries.filter((e) => e.kind === "template"),
    ...entries.filter((e) => e.kind === "boilerplate"),
  ]
  for (const entry of ordered) {
    const values = match(entry.template, joined)
    if (!values) continue
    if (await holesAcceptable(entry, values, ctx)) return { entry, values }
  }
  return null
}

const URL_CONTEXT = /(?:href|src|action|formaction)\s*=\s*["']?\s*$/i
const SCHEME_CONTEXT = /[a-z][a-z0-9+.-]*:\/\/$/i
const URLS = /https?:\/\/([^\s/"'<>?#:]+)/gi
const BARE_HOST =
  /(?<![@\w.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?![\w-])/gi

/** Every host a hole's value points at or names, or null when it may not be a link at all. */
export function valueHosts(before: string, value: string): string[] | null {
  const hosts = new Set<string>()
  if (URL_CONTEXT.test(before)) {
    // ⚠ A HOLE THAT IS A WHOLE LINK TARGET must be a web address we can
    // check: not `javascript:`, not `data:`, not something relative that a
    // client resolves against who knows what.
    const m = /^https?:\/\/([^\s/"'<>?#:]+)/i.exec(value)
    if (!m) return value.trim() === "" ? [] : null
  }
  if (SCHEME_CONTEXT.test(before)) {
    const host = /^([^\s/"'<>?#:]+)/.exec(value)?.[1]
    if (host) hosts.add(host.toLowerCase())
  }
  for (const m of value.matchAll(URLS)) hosts.add(m[1]!.toLowerCase())
  for (const m of value.matchAll(BARE_HOST)) {
    const host = m[1]!.toLowerCase()
    const p = parse(host)
    if (p.isIcann && p.domain) hosts.add(host)
  }
  return [...hosts]
}

async function holesAcceptable(
  entry: TrustEntry,
  values: readonly string[],
  ctx: TrustContext,
): Promise<boolean> {
  if (values.length !== entry.limits.length) return false
  const hosts = new Set<string>()
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (v.length > entry.limits[i]!) return false
    if (/[<>]/.test(v)) return false
    const found = valueHosts(entry.template.segments[i] ?? "", v)
    if (found === null) return false
    for (const h of found) hosts.add(h)
  }
  for (const host of hosts) {
    const parent = parse(host).domain
    if (!parent || !ctx.verifiedParents.has(parent)) return false
    if ((await ctx.verdict(host)) !== "clean") return false
  }
  return true
}
