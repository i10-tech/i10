import {
  buildProps,
  flattenPreview,
  marker,
  nonceFrom,
  verifyRenders,
  type Render,
  type Skeleton,
} from "@repo/templates"

/**
 * The two round trips to a template's sandbox, and the verdict.
 *
 * ⚠ EVERYTHING THE SANDBOX RETURNS IS UNTRUSTED. It ran the customer's code, so
 * its answers are shaped like ours only if that code let them be. Every field
 * is checked for type and size here, and the decision about the template is
 * made by `verifyRenders` in this process, from renders the sandbox could not
 * have predicted: the nonces are drawn after the source is fixed.
 */

export interface Sandbox {
  /** One request to the sandbox's harness; resolves to what it answered. */
  ask(request: unknown): Promise<unknown>
}

export type Compiled =
  | { ok: true; skeleton: Skeleton; subject: string | null }
  | { ok: false; problems: string[] }

/** A header line's limit in RFC 5322; a subject longer than this is a mistake. */
const MAX_SUBJECT_CHARS = 998

/** A rendered email larger than this is not a template anybody should send. */
const MAX_RENDER_CHARS = 2 * 1024 * 1024

export async function compileTemplate(
  sandbox: Sandbox,
  random: (length: number) => Uint8Array,
): Promise<Compiled> {
  const first = unwrap(await sandbox.ask({ op: "preview" }))
  if (!first.ok) return { ok: false, problems: [first.error] }

  const preview = isObject(first.value) ? first.value.preview : undefined
  const flat = flattenPreview(preview)
  if (!flat.ok) return { ok: false, problems: [flat.error] }

  const exported = isObject(first.value) ? first.value.subject : null
  if (
    exported !== null &&
    exported !== undefined &&
    (typeof exported !== "string" || exported.length > MAX_SUBJECT_CHARS)
  ) {
    return {
      ok: false,
      problems: [
        `The exported \`subject\` must be a string of at most ${MAX_SUBJECT_CHARS} characters.`,
      ],
    }
  }
  const subject = typeof exported === "string" && exported.trim() ? exported : null

  const nonceA = nonceFrom(random(12))
  let nonceB = nonceFrom(random(12))
  while (nonceB === nonceA) nonceB = nonceFrom(random(12))

  const second = unwrap(
    await sandbox.ask({
      op: "render",
      sets: [
        buildProps(flat.variables, (_v, i) => marker(nonceA, i)),
        buildProps(flat.variables, (_v, i) => marker(nonceB, i)),
        buildProps(flat.variables, () => ""),
      ],
      probe: buildProps(flat.variables, (v) => v.preview),
    }),
  )
  if (!second.ok) return { ok: false, problems: [second.error] }

  const answer = isObject(second.value) ? second.value : {}
  const renders = Array.isArray(answer.renders) ? answer.renders.map(asRender) : []
  const [a, b, empty] = renders
  if (renders.length !== 3 || !a || !b || !empty) {
    return {
      ok: false,
      problems: ["The template's sandbox returned something that is not a render."],
    }
  }
  const accessed = Array.isArray(answer.accessed)
    ? answer.accessed.filter((k): k is string => typeof k === "string").slice(0, 500)
    : []

  const verified = verifyRenders({
    variables: flat.variables,
    nonceA,
    nonceB,
    a,
    b,
    empty,
    accessed,
  })
  return verified.ok ? { ...verified, subject } : verified
}

function asRender(value: unknown): Render | null {
  if (!isObject(value)) return null
  const { html, text } = value
  if (typeof html !== "string" || typeof text !== "string") return null
  if (html.length > MAX_RENDER_CHARS || text.length > MAX_RENDER_CHARS) return null
  return { html, text }
}

function unwrap(
  answer: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!isObject(answer))
    return { ok: false, error: "The template's sandbox did not answer." }
  if (answer.ok === true) return { ok: true, value: answer.value }
  const error =
    typeof answer.error === "string" ? answer.error.slice(0, 2000) : "unknown error"
  return { ok: false, error: `The template failed while rendering: ${error}` }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
