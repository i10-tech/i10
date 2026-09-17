"use client"

import * as React from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs"
import { Textarea } from "@repo/ui/components/textarea"

/**
 * Writing the body of an email.
 *
 * ⚠ IT IS A SOURCE EDITOR WITH A PREVIEW, NOT A WYSIWYG, AND THAT IS A DECISION
 * RATHER THAN A STAGING POST. A rich-text editor for email is not a text editor
 * with buttons — it is a table-layout generator that has to produce markup
 * Outlook's Word rendering engine, Gmail's class stripper and Apple Mail all
 * agree on. Shipping a half-built one produces emails that look right here and
 * broken in the inbox, which is worse than no editor at all. The people using
 * this product write HTML.
 *
 * ⚠ THE PREVIEW IS THE SAME SANDBOXED IFRAME THE DELIVERY LOG USES, AND FOR THE
 * SAME REASON. It renders HTML that will be pasted in from anywhere;
 * `dangerouslySetInnerHTML` would execute its scripts in the console's origin
 * with the author's session. `sandbox=""` with no tokens gives it a unique
 * opaque origin — no scripts, no forms, no reach into `parent`.
 *
 * ⚠ AND THE PREVIEW IS DEBOUNCED. Re-creating the iframe document on every
 * keystroke makes typing visibly stutter on a long template, because each
 * change re-parses the whole document.
 */
export function HtmlEditor({
  html,
  text,
  onHtmlChange,
  onTextChange,
  disabled = false,
}: {
  html: string
  text: string
  onHtmlChange: (value: string) => void
  onTextChange: (value: string) => void
  disabled?: boolean
}) {
  const [preview, setPreview] = React.useState(html)

  React.useEffect(() => {
    const timer = setTimeout(() => setPreview(html), 300)
    return () => clearTimeout(timer)
  }, [html])

  return (
    <Tabs defaultValue="html" className="overflow-hidden rounded-lg border">
      <TabsList className="w-full justify-start rounded-none border-b bg-transparent px-2 py-1.5">
        <TabsTrigger value="html">HTML</TabsTrigger>
        <TabsTrigger value="text">Plain text</TabsTrigger>
        <TabsTrigger value="preview">Preview</TabsTrigger>
      </TabsList>

      <TabsContent value="html" className="m-0">
        <Textarea
          value={html}
          onChange={(event) => onHtmlChange(event.target.value)}
          disabled={disabled}
          placeholder="<p>Hello {{first_name}},</p>"
          // ⚠ `spellCheck` OFF. A spell-checker underlining every tag name and
          // every attribute makes a template unreadable, and none of the red
          // squiggles are about anything the author can fix.
          spellCheck={false}
          className="min-h-[24rem] resize-y rounded-none border-0 font-mono text-xs leading-relaxed focus-visible:ring-0"
        />
      </TabsContent>

      <TabsContent value="text" className="m-0">
        <Textarea
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          disabled={disabled}
          placeholder={"Hello {{first_name}},\n\n…"}
          className="min-h-[24rem] resize-y rounded-none border-0 font-mono text-xs leading-relaxed focus-visible:ring-0"
        />
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          {/*
           * ⚠ NOT DECORATION. Several spam filters score a message with no
           * text/plain part higher, and a recipient on a text-only client sees
           * nothing at all. Left empty, the send path derives one from the HTML
           * — which is better than nothing and worse than one somebody wrote.
           */}
          Left empty, we generate one from the HTML. A hand-written version reads better
          and scores better with spam filters.
        </p>
      </TabsContent>

      <TabsContent value="preview" className="m-0">
        {preview.trim() ? (
          <iframe
            sandbox=""
            srcDoc={preview}
            title="Body preview"
            className="h-[24rem] w-full bg-white"
            referrerPolicy="no-referrer"
          />
        ) : (
          <p className="px-4 py-24 text-center text-sm text-muted-foreground">
            Nothing to preview yet.
          </p>
        )}
      </TabsContent>
    </Tabs>
  )
}
