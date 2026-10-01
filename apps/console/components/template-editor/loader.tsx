"use client"

import dynamic from "next/dynamic"
import { Loader2 } from "lucide-react"

/**
 * The editor, loaded in the browser only: it is TipTap, ProseMirror and
 * CodeMirror - several hundred kilobytes no other page should pay for, and
 * none of it renders on a server.
 *
 * ⚠ THE SKELETON IS THE EDITOR'S OWN SHAPE (top bar, rail, white canvas), so
 * the page does not jump when the real thing arrives.
 */
export const TemplateEditorLoader = dynamic(
  () => import("@/components/template-editor/shell").then((m) => m.TemplateEditorApp),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-dvh flex-col bg-sidebar">
        <div className="h-14 shrink-0" />
        <div className="flex min-h-0 flex-1">
          <div className="w-14 shrink-0" />
          <div className="mr-3 mb-3 grid flex-1 place-items-center rounded-2xl bg-white ring-1 ring-black/5 dark:ring-white/10">
            <Loader2 className="size-5 animate-spin text-neutral-400" />
          </div>
        </div>
      </div>
    ),
  },
)
