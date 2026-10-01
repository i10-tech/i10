"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowUpRight, Code2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { CopyButton } from "@repo/ui/components/copy"
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { cn } from "cn"
import type { ApiSnippet } from "@/lib/snippets"

/**
 * The `</>` beside a page's main action: how code does what this page does,
 * Resend's "API" button.
 *
 * ⚠ ONLY WHAT THE PUBLIC API REALLY DOES. A page whose resource has no public
 * endpoint gets no button, rather than a snippet that 404s.
 */
export function ApiButton({ snippet }: { snippet: ApiSnippet }) {
  const [lang, setLang] = React.useState(0)
  const current = snippet.code[lang] ?? snippet.code[0]!

  return (
    <Popover onOpenChange={(open) => open && setLang(0)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={snippet.tooltip}
              className="transition-colors data-[state=open]:bg-muted"
            >
              <Code2 />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{snippet.tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-[30rem] max-w-[calc(100vw-2rem)] space-y-3 p-4"
      >
        <div className="space-y-1">
          <p className="text-sm font-medium">{snippet.title}</p>
          <p className="text-xs text-muted-foreground">{snippet.description}</p>
        </div>

        <div className="overflow-hidden rounded-xl border bg-muted/30">
          <div className="flex items-center justify-between border-b px-1.5 py-1">
            <div
              className="flex items-center gap-0.5"
              role="tablist"
              aria-label="Language"
            >
              {snippet.code.map((c, i) => (
                <button
                  key={c.label}
                  type="button"
                  role="tab"
                  aria-selected={i === lang}
                  onClick={() => setLang(i)}
                  className={cn(
                    "relative cursor-pointer rounded-md px-2 py-1 text-xs transition-colors",
                    i === lang
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {i === lang && (
                    <motion.span
                      layoutId={`api-tab-${snippet.title}`}
                      className="absolute inset-0 rounded-md bg-background shadow-xs ring-1 ring-border"
                      transition={{ type: "spring", stiffness: 500, damping: 38 }}
                    />
                  )}
                  <span className="relative">{c.label}</span>
                </button>
              ))}
            </div>
            <CopyButton value={current.code} label="Copy code" className="size-7" />
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.pre
              key={current.label}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.12 }}
              className="max-h-80 overflow-auto p-3 font-mono text-[11px] leading-relaxed"
            >
              <Highlighted code={current.code} />
            </motion.pre>
          </AnimatePresence>
        </div>

        <a
          href={snippet.docs ?? "https://docs.i10.tech"}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Read the docs
          <ArrowUpRight className="size-3" />
        </a>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Just enough colour to read code by: strings, comments, keywords. A real
 * highlighter is a dependency for twelve lines of snippet.
 */
const TOKEN =
  /(\/\/[^\n]*|#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|from|const|await|new|export|async|return|curl)\b/g

function Highlighted({ code }: { code: string }) {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const match of code.matchAll(TOKEN)) {
    const at = match.index ?? 0
    if (at > last) parts.push(code.slice(last, at))
    const [text, comment, string] = match
    parts.push(
      <span
        key={at}
        className={
          comment
            ? "text-muted-foreground italic"
            : string
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-violet-700 dark:text-violet-400"
        }
      >
        {text}
      </span>,
    )
    last = at + text.length
  }
  if (last < code.length) parts.push(code.slice(last))
  return <code>{parts}</code>
}
