"use client"

import * as React from "react"
import { BoneScope } from "@repo/ui/components/bone/bone"
import {
  Page,
  PageActions,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  TITLE,
} from "@repo/ui/components/i10/page"
import { PlaceholderTitle } from "@repo/ui/components/i10/page-title"
import { ApiButton } from "@/components/list/api-button"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import { TemplateLibrary } from "@/components/templates/library"
import { NewTemplateMenu } from "@/components/templates/new-menu"
import { PanelError } from "@/components/panel-error"
import { PAGE_COPY } from "@/lib/page-copy"
import {
  templateFolderShape,
  type TemplateFolderData,
  type TemplateFolderShape,
} from "@/lib/shapes/template-folder"
import { SNIPPETS } from "@/lib/snippets"
import { usePreviewsReady } from "@/components/template-snapshot"

export function TemplateFolderLoading({ folderId }: { folderId: string }) {
  const def = React.useMemo(() => templateFolderShape(folderId), [folderId])
  const shape = useRememberedShape(def)
  return <TemplateFolderView shape={shape} folderId={folderId} />
}

export function TemplateFolderView({
  shape,
  data,
  folderId,
}: {
  shape: TemplateFolderShape
  data?: TemplateFolderData
  folderId: string
}) {
  // The list resolves with its first cards' pictures, not before them
  // (template-snapshot.tsx), so folders and templates resolve together.
  const previews = usePreviewsReady(data?.error ? [] : data?.templates, folderId)
  const loading = data === undefined || !previews
  const def = React.useMemo(() => templateFolderShape(folderId), [folderId])

  return (
    <BoneScope id={`folder-${folderId}`} loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.templates.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.templates.title}</PageTitle>
            )}
            <PageActions>
              <ApiButton snippet={SNIPPETS.templates} />
              <NewTemplateMenu folderId={folderId} />
            </PageActions>
          </PageHeaderRow>
        </PageHeader>

        <PageBody>
          {data?.error ? (
            <PanelError title="Could not load templates" message={data.error} />
          ) : (
            <TemplateLibrary
              templates={data?.templates}
              folders={data?.folders}
              folderId={folderId}
              loading={loading}
              shape={shape}
            />
          )}
        </PageBody>

        {data && !data.error && (
          // Each folder is its own list: what it holds, and at the top its folders too.
          <RememberShape def={def} shape={shape} />
        )}
      </Page>
    </BoneScope>
  )
}
