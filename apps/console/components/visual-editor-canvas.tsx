"use client"

import * as React from "react"
import { EmailEditor, type EmailEditorRef } from "@react-email/editor"
import "@react-email/editor/themes/default.css"
import "./visual-editor.css"

/**
 * The React Email editor itself (#243). Loaded only by the editor tab, and
 * only in the browser: it is TipTap and ProseMirror, a few hundred kilobytes
 * that no other page of the console should pay for.
 *
 * ⚠ IT IS HANDED THE TEMPLATE'S OWN DOCUMENT, NEVER HTML. ProseMirror renders
 * only the nodes its schema knows, so what is on screen is built from a
 * structure, not parsed from somebody's markup (#189).
 */
export default function VisualEditorCanvas({
  design,
  onReady,
  onChange,
}: {
  design: Record<string, unknown> | null
  onReady: (ref: EmailEditorRef) => void
  onChange: (ref: EmailEditorRef) => void
}) {
  // The document the editor opened with. Later edits live in the editor.
  const [initial] = React.useState(() => design ?? undefined)
  return (
    <div className="i10-email-editor min-h-[32rem] rounded-lg border bg-white px-6 py-8 text-neutral-900 dark:bg-neutral-50">
      <EmailEditor
        content={initial}
        placeholder="Type / for blocks, or just start writing"
        onReady={onReady}
        onUpdate={onChange}
      />
    </div>
  )
}
