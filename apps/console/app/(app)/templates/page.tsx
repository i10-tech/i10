import type { Metadata } from "next"
import Link from "next/link"
import { Badge } from "@repo/ui/components/badge"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { NewTemplateButton } from "@/components/new-template"
import { EmptyState } from "@/components/empty-state"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatRelative } from "@/lib/format"
import type { TemplateSummary } from "@/lib/types"

export const metadata: Metadata = { title: "Templates" }

/**
 * Reusable emails, referenced by id from a send.
 *
 * ⚠ DRAFT AND PUBLISHED ARE TWO DIFFERENT THINGS, AND THE LIST SHOWS WHICH IS
 * WHICH. A template is referenced by `template_id` from production code that is
 * sending mail right now; editing it must not change what goes out mid-
 * sentence. "Unpublished changes" on a row means the editor and the live
 * version have diverged — which is exactly the state somebody forgets they are
 * in.
 */
export default async function TemplatesPage() {
  const result = await tryApi<{ data: TemplateSummary[] }>("/console/templates")

  // ⚠ GROUPED IN THE RENDER RATHER THAN BY THE API. Folders are a display
  // concept — the column is a flat string — so the grouping belongs where the
  // tree is drawn. An API that returned a nested shape would make every other
  // consumer unpack it.
  const grouped = new Map<string, TemplateSummary[]>()
  if (result.ok) {
    for (const template of result.data.data) {
      const key = template.folder ?? ""
      const list = grouped.get(key)
      if (list) list.push(template)
      else grouped.set(key, [template])
    }
  }

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Templates</PageTitle>
          <PageActions>
            <NewTemplateButton />
          </PageActions>
        </PageHeaderRow>
        <PageDescription>
          Write once, send by id. Editing a template does not change what is going out
          until you publish it.
        </PageDescription>
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError title="Could not load templates" message={result.error.message} />
        ) : result.data.data.length === 0 ? (
          <EmptyState
            title="No templates yet"
            description="Create one and reference it from your send call, so changing the copy does not mean a deploy."
          />
        ) : (
          <div className="space-y-6">
            {[...grouped.entries()].map(([folder, templates]) => (
              <section key={folder || "root"}>
                {folder && (
                  <h2 className="mb-2 font-mono text-xs text-muted-foreground">
                    {folder}
                  </h2>
                )}
                <ul className="divide-y overflow-hidden rounded-lg border">
                  {templates.map((template) => (
                    <li key={template.id}>
                      <Link
                        href={`/templates/${template.id}`}
                        className="flex items-center gap-3 px-4 py-3 transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-muted/30"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {template.name}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {template.subject || <em>No subject yet</em>}
                          </p>
                        </div>

                        {template.published_at === null ? (
                          <Badge variant="outline">Never published</Badge>
                        ) : (
                          template.updated_at > template.published_at && (
                            <Badge variant="secondary">Unpublished changes</Badge>
                          )
                        )}

                        {template.version > 0 && (
                          <span className="tabular shrink-0 font-mono text-2xs text-muted-foreground">
                            v{template.version}
                          </span>
                        )}

                        <span
                          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
                          title={template.updated_at}
                        >
                          {formatRelative(template.updated_at)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </PageBody>
    </Page>
  )
}
