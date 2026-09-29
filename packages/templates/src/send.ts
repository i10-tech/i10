import { fill } from "./substitute.js"
import type { Variable } from "./variables.js"

/**
 * A send that names a template: from `{ template, variables }` to the email.
 *
 * ⚠ PURE, PORTABLE, AND BEHIND A PORT, BECAUSE THE SEND PATH'S FIRST LAYER IS
 * MOVING TO CLOUDFLARE. Today the API calls this with lookups against
 * Postgres; tomorrow a Worker in front of the API calls the same function with
 * lookups against its cache. Nothing here may touch a database, a Node API or
 * the network - which the build enforces: this package has no runtime types
 * but the language's own.
 *
 * ⚠ TWO LOOKUPS, BECAUSE THEY CACHE DIFFERENTLY.
 *
 *   ref -> version id     MUTABLE. "Live" moves when somebody promotes a
 *                         version, and a name can be given to another template.
 *                         An edge cache holds it briefly, or purges on promote.
 *   version id -> content IMMUTABLE. A version is never edited, so its content
 *                         can be cached by id forever, anywhere.
 *
 * A pinned send (`version` given) still needs the first lookup - the number is
 * per template - but its answer never changes either.
 */

/**
 * A version as stored and as served: plain JSON, the same bytes in Postgres,
 * in the API's answer and in any cache in front of it.
 */
export interface StoredVersion {
  id: string
  templateId: string
  number: number
  subject: string | null
  html: string | null
  text: string | null
  nonce: string
  variables: Variable[]
}

export interface TemplateRef {
  /** The template's id, or its name - the alias a caller can hard-code. */
  id: string
  /** Pin to this version. Absent means whatever is live. */
  version?: number
}

export interface TemplateLookup {
  /** Null when there is no such template, or no such version of it. */
  versionIdFor(ref: TemplateRef): Promise<string | null>
  /** Null only if the version was deleted between the two lookups. */
  version(id: string): Promise<StoredVersion | null>
}

export type SendResolution =
  | {
      ok: true
      versionId: string
      html: string | null
      text: string | null
      subject: string
    }
  | {
      ok: false
      /** `not_found` for the template or version; `invalid` for the variables. */
      error: "not_found" | "invalid"
      message: string
    }

export async function resolveTemplateSend(
  input: {
    template: TemplateRef
    variables?: unknown
    /** The request's own subject, which wins over the template's, as in Resend. */
    subject?: string
  },
  lookup: TemplateLookup,
): Promise<SendResolution> {
  const { template } = input
  const versionId = await lookup.versionIdFor(template)
  const version = versionId ? await lookup.version(versionId) : null
  if (!version) {
    return {
      ok: false,
      error: "not_found",
      message:
        template.version === undefined
          ? `No template \`${template.id}\` with a live version.`
          : `Template \`${template.id}\` has no version ${template.version}.`,
    }
  }

  // ⚠ THE REQUEST'S SUBJECT IS TAKEN LITERALLY. Placeholders are the
  // template's feature; a caller writing its own subject already has the
  // values in hand.
  const filled = fill(
    { ...version, subject: input.subject !== undefined ? null : version.subject },
    input.variables ?? {},
  )
  if (!filled.ok) {
    const parts = []
    if (filled.missing.length > 0) parts.push(`missing ${quote(filled.missing)}`)
    if (filled.invalid.length > 0) {
      parts.push(`not a string, number or boolean: ${quote(filled.invalid)}`)
    }
    return {
      ok: false,
      error: "invalid",
      message: `Template \`${template.id}\` v${version.number} variables: ${parts.join("; ")}.`,
    }
  }

  const subject = input.subject ?? filled.filled.subject
  if (subject === null || subject === undefined || subject === "") {
    return {
      ok: false,
      error: "invalid",
      message: `Template \`${template.id}\` has no subject, so the request must give one.`,
    }
  }

  return {
    ok: true,
    versionId: version.id,
    html: filled.filled.html,
    text: filled.filled.text,
    subject,
  }
}

function quote(paths: string[]): string {
  return paths.map((p) => `\`${p}\``).join(", ")
}
