import type { Metadata } from "next"
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
import { TemplateGrid } from "@/components/template-grid"
import { GithubPanel } from "@/components/github-panel"
import { UploadTemplatesButton } from "@/components/upload-templates"
import {
  SubmitTrustedTemplateButton,
  WithdrawTrustedTemplate,
} from "@/components/trusted-templates"
import { EmptyState } from "@/components/empty-state"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatRelative } from "@/lib/format"
import type { GithubState, TemplateSummary, TrustedTemplateRow } from "@/lib/types"

export const metadata: Metadata = { title: "Templates" }

/**
 * Reusable emails, referenced by id from a send.
 *
 * ⚠ DRAFT AND PUBLISHED ARE TWO DIFFERENT THINGS, AND THE LIST SHOWS WHICH IS
 * WHICH. A template is referenced by `template_id` from production code that is
 * sending mail right now; editing it must not change what goes out mid-
 * sentence. "Unpublished changes" on a row means the editor and the live
 * version have diverged - which is exactly the state somebody forgets they are
 * in.
 */
export default async function TemplatesPage() {
  const [result, trusted, github] = await Promise.all([
    tryApi<{ data: TemplateSummary[]; assets_origin?: string | null }>(
      "/console/templates",
    ),
    tryApi<{ data: TrustedTemplateRow[] }>("/console/trusted-templates"),
    tryApi<GithubState>("/console/github"),
  ])
  const hasRows = result.ok && result.data.data.length > 0

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Templates</PageTitle>
          {/*
           * ⚠ HIDDEN WHILE THE LIST IS EMPTY, BECAUSE THE EMPTY STATE ALREADY
           * CARRIES THIS ACTION. Two buttons for one action, eight inches
           * apart, reads as two different things - and the one in the header is
           * the smaller and less explained of the two, so it wins attention it
           * has not earned. The empty state's version says what will happen;
           * this one just says a noun.
           */}
          {hasRows && (
            <PageActions>
              <UploadTemplatesButton />
              <NewTemplateButton />
            </PageActions>
          )}
        </PageHeaderRow>
        <PageDescription>
          Write one in the editor or upload React Email files, then send it by id. Every
          change is a new version; nothing changes what is going out until it is
          published, and any earlier version can be made live again.
        </PageDescription>
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError title="Could not load templates" message={result.error.message} />
        ) : !hasRows ? (
          <EmptyState
            title="No templates yet"
            description="Write one in the editor, or upload React Email .tsx files or a folder of them. Then reference it from your send call, so changing the copy does not mean a deploy."
            secondary={
              <div className="flex flex-wrap justify-center gap-2">
                <UploadTemplatesButton />
                <NewTemplateButton />
              </div>
            }
          />
        ) : (
          <TemplateGrid
            templates={result.data.data}
            imagesFrom={result.data.assets_origin ?? null}
          />
        )}

        {/*
         * ⚠ AFTER THE TEMPLATES, NOT BEFORE. The page is for the templates;
         * where some of them come from is a setting of the workspace, looked
         * at far less often than the emails themselves.
         */}
        {github.ok && github.data.configured && (
          <div className="mt-10">
            <GithubPanel state={github.data} />
          </div>
        )}

        <ReviewedTemplates result={trusted} />
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
        <ul className="divide-y overflow-hidden rounded-lg border">
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
