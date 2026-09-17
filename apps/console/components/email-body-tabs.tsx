"use client"

import * as React from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs"
import { CopyButton } from "@repo/ui/components/copy"

/**
 * What was actually sent: rendered, as source, as text, and as headers.
 *
 * ⚠ THE PREVIEW IS A SANDBOXED IFRAME WITH `srcDoc`, AND THIS IS THE SINGLE
 * MOST IMPORTANT DECISION ON THIS PAGE. The HTML being rendered is a CUSTOMER'S
 * — it arrived through `POST /emails` from whatever system they run, and on a
 * shared console it is attacker-controlled the moment one tenant can get a
 * message into another's log. Rendering it with `dangerouslySetInnerHTML` would
 * execute its scripts in the console's own origin, with the person's session:
 * stored XSS, in the dashboard, triggered by opening a delivery log.
 *
 * ⚠ THE `sandbox` ATTRIBUTE IS PRESENT AND CARRIES NO TOKENS. An empty
 * `sandbox=""` is the maximally restrictive setting: no scripts, no forms, no
 * top-level navigation, and — critically — a UNIQUE OPAQUE ORIGIN, so the frame
 * cannot reach `parent`, cannot read our cookies, and cannot touch
 * `localStorage`. Adding `allow-scripts` would defeat the whole thing;
 * `allow-scripts` together with `allow-same-origin` would be strictly worse
 * than no sandbox at all, because the frame could then remove its own sandbox.
 *
 * ⚠ AND `srcDoc` RATHER THAN A BLOB URL, because a blob inherits the creating
 * document's origin. The sandbox would still contain it, but the two mechanisms
 * would be fighting and only one of them is load-bearing.
 *
 * What we accept in exchange: remote images do not load, because the frame has
 * no network permission the parent can grant it beyond the default — which is
 * fine and arguably correct, since loading them would fire the sender's own
 * tracking pixels every time somebody opened the log.
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

  return (
    <section className="overflow-hidden rounded-lg border">
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
          <TabsList className="bg-transparent p-0">
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

          {tab === "html" && html && <CopyButton value={html} label="Copy HTML" />}
          {tab === "text" && text && <CopyButton value={text} label="Copy text" />}
          {tab === "headers" && headerLines && (
            <CopyButton value={headerLines} label="Copy headers" />
          )}
        </div>

        <TabsContent value="preview" className="m-0">
          {html ? (
            <iframe
              // ⚠ SEE THE BLOCK COMMENT. Do not add tokens to this attribute.
              sandbox=""
              srcDoc={html}
              title="Email preview"
              className="h-[36rem] w-full bg-white"
              // ⚠ `referrerPolicy` AND `loading` ARE BELT AND BRACES. The frame
              // cannot navigate, but any subresource it references would
              // otherwise carry our URL — which contains the message id — to a
              // third-party image host.
              referrerPolicy="no-referrer"
              loading="lazy"
            />
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

function Source({ children }: { children: string }) {
  return (
    /*
     * ⚠ `<pre>` WITH THE CONTENT AS A TEXT CHILD, WHICH IS THE SAFE WAY TO SHOW
     * SOURCE. React escapes it; the browser renders `<script>` as four visible
     * characters rather than as a tag. This is the difference between showing
     * somebody their HTML and running it.
     */
    <pre className="max-h-[36rem] overflow-auto bg-muted/30 px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {children}
    </pre>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-12 text-center text-sm text-muted-foreground">{children}</p>
  )
}
