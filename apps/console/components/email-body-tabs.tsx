"use client"

import * as React from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs/tabs"
import { CodeBlock } from "@repo/ui/components/code-block/code-block"
import { CopyButton } from "@repo/ui/components/copy-button/copy-button"
import { EmailFrame } from "@/components/email-frame"

/**
 * What was actually sent: rendered, as source, as text, and as headers.
 *
 * ⚠ THE PREVIEW IS A SANDBOXED IFRAME WITH `srcDoc`, AND THIS IS THE SINGLE
 * MOST IMPORTANT DECISION ON THIS PAGE. The HTML being rendered is a CUSTOMER'S
 * - it arrived through `POST /emails` from whatever system they run, and on a
 * shared console it is attacker-controlled the moment one tenant can get a
 * message into another's log. Rendering it with `dangerouslySetInnerHTML` would
 * execute its scripts in the console's own origin, with the person's session:
 * stored XSS, in the dashboard, triggered by opening a delivery log.
 *
 * ⚠ THE `sandbox` ATTRIBUTE IS PRESENT AND CARRIES NO TOKENS. An empty
 * `sandbox=""` is the maximally restrictive setting: no scripts, no forms, no
 * top-level navigation, and - critically - a UNIQUE OPAQUE ORIGIN, so the frame
 * cannot reach `parent`, cannot read our cookies, and cannot touch
 * `localStorage`. Adding `allow-scripts` would defeat the whole thing;
 * `allow-scripts` together with `allow-same-origin` would be strictly worse
 * than no sandbox at all, because the frame could then remove its own sandbox.
 *
 * ⚠ AND `srcDoc` RATHER THAN A BLOB URL, because a blob inherits the creating
 * document's origin. The sandbox would still contain it, but the two mechanisms
 * would be fighting and only one of them is load-bearing.
 *
 * ⚠ THE SANDBOX ALONE DID NOT STOP REMOTE IMAGES, whatever this comment once
 * said: `sandbox` restricts scripts, forms and navigation, not subresources.
 * `EmailFrame` adds the CSP that does (#189), so opening a log no longer fires
 * the sender's tracking pixels, and the viewer can still load images on
 * purpose.
 */
export function EmailBodyTabs({
  html,
  text,
  headers,
}: {
  html: string | null
  text: string | null
  headers: Record<string, string> | null
}) {
  /*
   * ⚠ THE DEFAULT TAB FOLLOWS WHAT EXISTS. A transactional API caller who sends
   * only `text` would otherwise land on an empty Preview and conclude the body
   * was lost.
   */
  const initial = html ? "preview" : text ? "text" : "headers"
  const [tab, setTab] = React.useState(initial)

  const headerLines = React.useMemo(
    () =>
      headers
        ? Object.entries(headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n")
        : "",
    [headers],
  )

  const copyable =
    tab === "html"
      ? html
      : tab === "text"
        ? text
        : tab === "headers"
          ? headerLines
          : null

  return (
    <section className="overflow-hidden rounded-2xl border">
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
          <TabsList>
            <TabsTrigger value="preview" disabled={!html}>
              Preview
            </TabsTrigger>
            <TabsTrigger value="html" disabled={!html}>
              HTML
            </TabsTrigger>
            <TabsTrigger value="text" disabled={!text}>
              Plain text
            </TabsTrigger>
            <TabsTrigger value="headers" disabled={!headers}>
              Headers
            </TabsTrigger>
          </TabsList>

          {/* One button for every source tab, so it stays put while the tab changes. */}
          {copyable && (
            <CopyButton value={copyable} label="Copy" iconOnly variant="plain" />
          )}
        </div>

        <TabsContent value="preview" className="m-0">
          {html ? (
            // ⚠ SEE `EmailFrame`: sandboxed, with a CSP that keeps the
            // sender's tracking pixels from firing every time somebody opens
            // the log, and remote images one click away (#189).
            <EmailFrame html={html} title="Email preview" className="h-[36rem]" />
          ) : (
            <Empty>This message had no HTML body.</Empty>
          )}
        </TabsContent>

        <TabsContent value="html" className="m-0">
          {html ? (
            <Source>{html}</Source>
          ) : (
            <Empty>This message had no HTML body.</Empty>
          )}
        </TabsContent>

        <TabsContent value="text" className="m-0">
          {text ? (
            <Source>{text}</Source>
          ) : (
            <Empty>
              This message had no plain-text part. Most clients will render the HTML,
              but a text alternative improves deliverability.
            </Empty>
          )}
        </TabsContent>

        <TabsContent value="headers" className="m-0">
          {headers ? (
            <Source>{headerLines}</Source>
          ) : (
            <Empty>No custom headers were set on this message.</Empty>
          )}
        </TabsContent>
      </Tabs>
    </section>
  )
}

function Source({
  children,
  filename = "Source",
  language = "html",
}: {
  children: string
  filename?: string
  language?: string
}) {
  return (
    /*
     * ⚠ ARC'S CODE BLOCK RENDERS THE SOURCE AS A TEXT CHILD, WHICH IS THE SAFE WAY TO SHOW
     * SOURCE. React escapes it; the browser renders `<script>` as four visible
     * characters rather than as a tag. This is the difference between showing
     * somebody their HTML and running it.
     */
    // Embedded: the tab bar above owns the one copy button (2026-10-13).
    <CodeBlock
      code={children}
      filename={filename}
      language={language}
      maxLines={40}
      embedded
    />
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-12 text-center text-sm text-muted-foreground">{children}</p>
  )
}
