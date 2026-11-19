"use client"

import * as React from "react"
import { EmailFrame } from "@/components/email-frame"
import { inlineAssets } from "@/lib/email-snapshot"
import { useInlinedEmail } from "@/lib/inlined-email"
import { fetchAsset } from "@/lib/template-asset-client"

const inline = (html: string) => inlineAssets(html, fetchAsset)

/**
 * A TEMPLATE's email at full size, with its remote images, web fonts and
 * stylesheets inlined as `data:` URIs, the same way the thumbnails are drawn.
 *
 * ⚠ FOR TEMPLATES ONLY. The assets are fetched through our proxy by the
 * console, not by the sandboxed frame (its opaque origin carries no session),
 * and a customer's received mail must keep its "load remote images" prompt:
 * use `EmailFrame` for that.
 */
export function TemplateEmailFrame(props: React.ComponentProps<typeof EmailFrame>) {
  const shown = useInlinedEmail(props.html, inline)
  return <EmailFrame {...props} html={shown ?? ""} />
}
