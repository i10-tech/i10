import { marker } from "./markers.js"
import { positionAt } from "./context.js"
import { SUBJECT_PLACEHOLDER } from "./substitute.js"
import type { Skeleton } from "./verify.js"
import type { Variable } from "./variables.js"

/**
 * A version from HTML somebody wrote by hand, with `{{ name }}` placeholders.
 *
 * ⚠ THE SAME SKELETON AND THE SAME FILL AS A RENDERED TSX VERSION. Nothing is
 * executed here - the placeholders are found by pattern - so an HTML template
 * needs no sandbox, but a send treats both kinds identically: one fill, one set
 * of escaping rules, one place to get them right.
 *
 * ⚠ THE AUTHOR'S HTML IS OTHERWISE STORED EXACTLY AS WRITTEN. An email API
 * delivers what it was given (#189); only the placeholders change.
 */
export function skeletonFromHtml(input: {
  html: string | null
  text: string | null
  nonce: string
}): { ok: true; skeleton: Skeleton } | { ok: false; problems: string[] } {
  const paths: string[] = []
  const indexOf = (path: string) => {
    let i = paths.indexOf(path)
    if (i === -1) i = paths.push(path) - 1
    return i
  }

  const problems: string[] = []
  const html = input.html ?? ""
  const lower = html.toLowerCase()
  const outHtml = html.replace(
    SUBJECT_PLACEHOLDER,
    (whole, path: string, at: number) => {
      const position = positionAt(html, lower, at)
      if (position.kind === "forbidden") {
        problems.push(
          `\`{{ ${path} }}\` is inside ${position.where}, where a value cannot be made safe.`,
        )
        return whole
      }
      return marker(
        input.nonce,
        indexOf(path),
        position.kind === "attribute" && position.url,
      )
    },
  )
  const outText = (input.text ?? "").replace(SUBJECT_PLACEHOLDER, (_w, path: string) =>
    marker(input.nonce, indexOf(path)),
  )

  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] }

  const variables: Variable[] = paths.map((path) => ({ path, preview: "" }))
  return {
    ok: true,
    skeleton: { html: outHtml, text: outText, nonce: input.nonce, variables },
  }
}
