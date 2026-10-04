"use client"

import { ChevronDown } from "lucide-react"

/**
 * What a message from this domain looks like in an inbox: the sender line
 * with the domain filled in as it is typed, over a body sketched in bars.
 *
 * ⚠ THE DOMAIN SLOT IS A BAR UNTIL THERE IS SOMETHING IN IT, the same grey as
 * the body's lines, so the empty preview reads as a sketch rather than as an
 * address with a hole in it.
 */
export function EmailPreview({ domain }: { domain: string }) {
  return (
    <div className="sticky top-8 rounded-tl-3xl border-t border-l p-6 [mask-image:linear-gradient(to_right,#000_70%,transparent),linear-gradient(to_bottom,#000_70%,transparent)] [mask-composite:intersect]">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-sm text-muted-foreground">
          Y
        </span>
        <div className="min-w-0 pt-0.5">
          <p className="flex min-w-0 items-center text-sm whitespace-nowrap">
            <span className="font-semibold">Your Name</span>
            <span className="ml-1.5 flex min-w-0 items-center text-muted-foreground">
              &lt;youremail@
              {domain ? (
                <span className="truncate text-foreground">{domain}</span>
              ) : (
                <span className="inline-block h-3 w-24 rounded-full bg-muted" />
              )}
              &gt;
            </span>
          </p>
          <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
            to me <ChevronDown aria-hidden className="size-3" />
          </p>
        </div>
      </div>
      <div className="mt-5 space-y-3 border-t pt-5">
        <div className="h-3 w-3/5 rounded-full bg-muted" />
        <div className="h-3 w-4/5 rounded-full bg-muted" />
        <div className="h-3 w-2/3 rounded-full bg-muted" />
      </div>
    </div>
  )
}
