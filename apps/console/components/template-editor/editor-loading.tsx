"use client"

import * as React from "react"
import {
  ChevronRight,
  Code2,
  Home,
  LayoutTemplate,
  MoreHorizontal,
  PenLine,
} from "lucide-react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Button } from "@repo/ui/components/button/button"

export function TemplateEditorLoading() {
  return (
    <BoneScope id="template-editor" loading={true}>
      <div className="flex h-dvh flex-col overflow-hidden bg-sidebar text-foreground">
        {/* Top bar */}
        <header className="relative z-20 flex h-12 shrink-0 items-center justify-between gap-3 px-3">
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center gap-2 text-sm"
          >
            <span className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground">
              <LayoutTemplate className="size-4" />
              Templates
            </span>
            <ChevronRight
              className="size-3.5 shrink-0 text-muted-foreground/60"
              aria-hidden
            />
            <Bone id="title" lineHeight={20} width={140} inline />
          </nav>

          <div className="ml-auto flex min-w-0 items-center gap-2">
            <Bone id="status" shape="box" width={52} height={22} radius={9999} inline />
            <Bone id="save" shape="box" width={64} height={20} radius={4} inline />
            <Button variant="secondary" size="sm" disabled aria-label="More actions">
              <MoreHorizontal />
            </Button>
            <Button size="sm" disabled>
              Publish
            </Button>
          </div>
        </header>

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          {/* Rail */}
          <nav
            className="flex w-14 shrink-0 flex-col items-center gap-1 pt-1"
            aria-label="Editor"
          >
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="size-9 rounded-lg p-0 text-muted-foreground"
            >
              <Home className="size-4" />
            </Button>
            <div className="my-1 h-px w-6 bg-border" />
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="size-9 rounded-lg p-0 bg-accent text-accent-foreground"
            >
              <PenLine className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="size-9 rounded-lg p-0 text-muted-foreground"
            >
              <Code2 className="size-4" />
            </Button>
          </nav>

          {/* Work area */}
          <main className="flex min-w-0 flex-1 gap-3 pr-3 pb-3">
            <div className="relative flex min-w-0 flex-1 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 dark:ring-white/10">
              <Bone id="canvas" shape="box" width="100%" height={600} radius={16} />
            </div>
          </main>
        </div>
      </div>
    </BoneScope>
  )
}
