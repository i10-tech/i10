import type { TemplateSummary } from "@/lib/types"

/**
 * What the templates screens agree on about one template.
 *
 * ⚠ ONE COPY, because the card, the table row, the editor's badge and the
 * status filter all have to give the same answer, and four copies of "is
 * this a draft" is how a filter ends up hiding the cards it is named after.
 */

export type TemplateStatus = "draft" | "published" | "changes"

/**
 * Draft: never published, so a send naming it fails. Published: what is
 * live is what the draft says. Changes: live, with edits nobody published.
 *
 * ⚠ "CHANGES" ONLY FOR TEMPLATES WRITTEN HERE. An upload or a push IS a
 * version, so for those the draft is never ahead of what is live.
 */
export function statusOf(
  t: Pick<TemplateSummary, "published_at" | "updated_at" | "source" | "kind">,
): TemplateStatus {
  if (t.published_at === null) return "draft"
  if (isEditable(t) && t.updated_at > t.published_at) return "changes"
  return "published"
}

export const STATUS_LABEL: Record<TemplateStatus, string> = {
  draft: "Draft",
  published: "Published",
  changes: "Unpublished changes",
}

/** Written in the editor here, rather than uploaded or kept in GitHub. */
export function isEditable(t: Pick<TemplateSummary, "source" | "kind">): boolean {
  return t.source === "managed" && t.kind !== "tsx"
}

/**
 * Where a template opens: the editor for one written here, its own page
 * (preview, versions, source) for one that is uploaded or pushed.
 */
export function hrefOf(t: Pick<TemplateSummary, "id" | "source" | "kind">): string {
  const id = encodeURIComponent(t.id)
  return isEditable(t) ? `/templates/${id}/editor` : `/templates/${id}`
}

/** What a person calls it: the title, else the alias. */
export function titleOf(t: Pick<TemplateSummary, "title" | "name">): string {
  return t.title?.trim() || t.name
}

/** Search across what a person would type to find it. */
export function matches(t: TemplateSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [t.title ?? "", t.name, t.subject ?? ""].some((s) =>
    s.toLowerCase().includes(q),
  )
}

/** `Password reset!` as `password-reset` - the API's rule for an alias made from a title. */
export function slugOf(title: string): string {
  return (
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled-template"
  )
}

/**
 * Whether the alias is still the one its title made (with the `-2` that
 * freed it), so renaming the template moves it too - as the API does.
 */
export function followsTitle(name: string, title: string | null): boolean {
  const base = slugOf(title ?? "")
  return (
    name === base ||
    (name.startsWith(`${base}-`) && /^\d+$/.test(name.slice(base.length + 1)))
  )
}
