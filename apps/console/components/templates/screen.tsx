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
import { GithubPanel } from "@/components/github-panel"
import { TemplateLibrary } from "@/components/templates/library"
import { NewTemplateMenu } from "@/components/templates/new-menu"
import { ApiButton } from "@/components/list/api-button"
import { SNIPPETS } from "@/lib/snippets"
import {
  SubmitTrustedTemplateButton,
  WithdrawTrustedTemplate,
} from "@/components/trusted-templates"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatRelative } from "@/lib/format"
import type {
  GithubState,
  TemplateFolder,
  TemplateSummary,
  TrustedTemplateRow,
} from "@/lib/types"

/**
 * The list, at the top level or inside one folder. Shared by
 * `/templates` and `/templates/folder/[id]`.
 */
export async function TemplatesScreen({ folderId }: { folderId: string | null }) {
  const [result, trusted, github] = await Promise.all([
    tryApi<{
      data: TemplateSummary[]
      folders?: TemplateFolder[]
      assets_origin?: string | null
    }>("/console/templates"),
    folderId === null
      ? tryApi<{ data: TrustedTemplateRow[] }>("/console/trusted-templates")
      : null,
    folderId === null ? tryApi<GithubState>("/console/github") : null,
  ])

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Templates</PageTitle>
          <PageActions>
            <ApiButton snippet={SNIPPETS.templates} />
            <NewTemplateMenu folderId={folderId} />
          </PageActions>
        </PageHeaderRow>
        {folderId === null && (
          <PageDescription>
            Write emails in the editor or upload React Email files, then send them by id
            or alias. Nothing changes what is going out until it is published, and any
            earlier version can be made live again.
          </PageDescription>
        )}
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError title="Could not load templates" message={result.error.message} />
        ) : (
          <TemplateLibrary
            templates={result.data.data}
            folders={result.data.folders ?? []}
            folderId={folderId}
            imagesFrom={result.data.assets_origin ?? null}
          />
        )}

        {/*
         * ⚠ AFTER THE TEMPLATES, NOT BEFORE, and only at the top level. The
         * page is for the templates; where some of them come from is a
         * setting of the workspace, looked at far less often.
         */}
        {github?.ok && github.data.configured && (
          <div className="mt-4">
            <GithubPanel state={github.data} />
          </div>
        )}

        {trusted && <ReviewedTemplates result={trusted} />}
      </PageBody>
    </Page>
  )
}

const STATUS: Record<
  TrustedTemplateRow["status"],
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  pending: { label: "Waiting for review", variant: "outline" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Not approved", variant: "secondary" },
  revoked: { label: "Approval withdrawn", variant: "destructive" },
  withdrawn: { label: "Withdrawn", variant: "secondary" },
}

/**
 * Templates submitted for review (#222), below the workspace's own templates.
 *
 * ⚠ A DIFFERENT THING FROM THE LIST ABOVE, AND SAID SO. Those are emails this
 * workspace keeps here and sends by id; these are emails it sends often, from
 * anywhere, that our team reviewed so their repetition stops counting against
 * it. One template can be both, and most are only one.
 *
 * ⚠ OUR NOTE IS SHOWN, because a rejection without its reason is a dead end,
 * and staff write it knowing the workspace reads it.
 */
function ReviewedTemplates({
  result,
}: {
  result: Awaited<ReturnType<typeof tryApi<{ data: TrustedTemplateRow[] }>>>
}) {
  const rows = result.ok ? result.data.data : []
  return (
    <section className="mt-10 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Reviewed for repeat sending</h2>
          <p className="max-w-prose text-xs text-muted-foreground">
            Email you send often, like password resets or receipts, can be reviewed by
            our team so that sending it many times does not count as repeated content.
            Approval never excuses bounces or spam complaints, and too many of them
            withdraw it.
          </p>
        </div>
        {result.ok && <SubmitTrustedTemplateButton />}
      </div>

      {!result.ok ? (
        <PanelError
          title="Could not load reviewed templates"
          message={result.error.message}
        />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          Nothing submitted yet.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-2xl border">
          {rows.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.holes.length === 0
                    ? "No placeholders"
                    : t.holes.map((h) => `{{${h.name}}}`).join(" ")}
                  {t.decision_reason ? ` - ${t.decision_reason}` : ""}
                </p>
              </div>
              <Badge variant={STATUS[t.status].variant}>{STATUS[t.status].label}</Badge>
              {t.status === "approved" && (
                <span className="tabular shrink-0 font-mono text-2xs text-muted-foreground">
                  {t.matched.toLocaleString("en")} matched
                </span>
              )}
              <span
                className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
                title={t.decided_at ?? t.submitted_at}
              >
                {formatRelative(t.decided_at ?? t.submitted_at)}
              </span>
              {(t.status === "pending" || t.status === "approved") && (
                <WithdrawTrustedTemplate id={t.id} name={t.name} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
