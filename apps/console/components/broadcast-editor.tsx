"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"
import { Label } from "@repo/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { Spinner } from "@repo/ui/components/spinner"
import { HtmlEditor } from "@/components/html-editor"
import { updateBroadcast } from "@/lib/actions"
import type { BroadcastDetail, DomainSummary, SegmentRow, TopicRow } from "@/lib/types"

/**
 * Writing a broadcast.
 *
 * ⚠ IT IS A DRAFT UNTIL IT IS NOT, AND EDITING STOPS THE MOMENT FAN-OUT STARTS.
 * The API refuses a PATCH on anything past `scheduled` — changing the subject
 * half-way through a send would put two different emails out under one name,
 * and the record of what was sent would match neither. This form goes read-only
 * rather than letting somebody type into a field that will be rejected.
 *
 * ⚠ AND THE FROM ADDRESS IS PICKED FROM VERIFIED DOMAINS, NOT TYPED. A typed
 * address on an unverified domain is accepted by the form, refused at send, and
 * the error arrives after the person has closed the tab. Offering only what can
 * actually send makes the failure impossible.
 */
export function BroadcastEditor({
  broadcast,
  segments,
  topics,
  domains,
}: {
  broadcast: BroadcastDetail
  segments: SegmentRow[]
  topics: TopicRow[]
  domains: DomainSummary[]
}) {
  const router = useRouter()

  const editable = broadcast.status === "draft" || broadcast.status === "scheduled"

  const [name, setName] = React.useState(broadcast.name)
  const [subject, setSubject] = React.useState(broadcast.subject)
  const [previewText, setPreviewText] = React.useState(broadcast.preview_text ?? "")
  const [localPart, setLocalPart] = React.useState(() => {
    const at = broadcast.from.indexOf("@")
    return at > 0 ? broadcast.from.slice(0, at) : "hello"
  })
  const [domain, setDomain] = React.useState(() => {
    const at = broadcast.from.indexOf("@")
    return at > 0 ? broadcast.from.slice(at + 1) : ""
  })
  const [segmentId, setSegmentId] = React.useState(broadcast.segment_id ?? "")
  const [topicId, setTopicId] = React.useState(broadcast.topic_id ?? "")
  const [html, setHtml] = React.useState(broadcast.html ?? "")
  const [text, setText] = React.useState(broadcast.text ?? "")
  const [saving, setSaving] = React.useState(false)

  const verified = domains.filter((d) => d.status === "verified")

  /*
   * ⚠ THE DIRTY CHECK IS A COMPARISON AGAINST THE SERVER'S VALUES, NOT A FLAG
   * SET BY EVERY onChange. A flag set on change never clears correctly when
   * somebody types a character and deletes it, so the "unsaved changes" warning
   * fires on a form identical to what is stored — and people learn to ignore it.
   */
  const dirty =
    name !== broadcast.name ||
    subject !== broadcast.subject ||
    previewText !== (broadcast.preview_text ?? "") ||
    `${localPart}@${domain}` !== broadcast.from ||
    segmentId !== (broadcast.segment_id ?? "") ||
    topicId !== (broadcast.topic_id ?? "") ||
    html !== (broadcast.html ?? "") ||
    text !== (broadcast.text ?? "")

  async function save() {
    if (saving || !editable) return
    setSaving(true)

    const result = await updateBroadcast(broadcast.id, {
      name,
      subject,
      preview_text: previewText || null,
      from: domain ? `${localPart}@${domain}` : "",
      segment_id: segmentId || null,
      topic_id: topicId || null,
      html: html || null,
      text: text || null,
    })

    setSaving(false)

    if (!result.ok) {
      toast.error("Could not save", { description: result.error })
      return
    }

    toast.success("Saved")
    router.refresh()
  }

  return (
    <div className="space-y-6">
      {!editable && (
        <p className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          This broadcast has started sending, so its content is fixed. Changing it now
          would mean two different emails going out under one name.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="broadcast-name">Internal name</Label>
          <Input
            id="broadcast-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!editable}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="broadcast-segment">Send to</Label>
          <Select
            value={segmentId}
            onValueChange={setSegmentId}
            disabled={!editable || segments.length === 0}
          >
            <SelectTrigger id="broadcast-segment">
              <SelectValue
                placeholder={
                  segments.length === 0 ? "No segments yet" : "Choose a segment"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {segments.map((segment) => (
                <SelectItem key={segment.id} value={segment.id}>
                  {segment.name}
                  <span className="ml-2 text-muted-foreground">
                    {segment.contact_count}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label>From</Label>
        <div className="flex items-center gap-0">
          <Input
            value={localPart}
            onChange={(event) => setLocalPart(event.target.value)}
            disabled={!editable}
            placeholder="hello"
            className="rounded-r-none font-mono text-xs"
            aria-label="From address, local part"
          />
          <span className="border-y bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
            @
          </span>
          <Select
            value={domain}
            onValueChange={setDomain}
            disabled={!editable || verified.length === 0}
          >
            <SelectTrigger
              className="rounded-l-none font-mono text-xs"
              aria-label="From address, domain"
            >
              <SelectValue
                placeholder={
                  verified.length === 0 ? "No verified domain" : "Choose a domain"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {verified.map((d) => (
                <SelectItem key={d.id} value={d.name}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {verified.length === 0 && (
          <p className="text-xs text-warning">
            You have no verified domains, so this cannot be sent yet.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="broadcast-subject">Subject</Label>
        <Input
          id="broadcast-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          disabled={!editable}
          placeholder="What we shipped in March"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="broadcast-preview">Preview text</Label>
        <Input
          id="broadcast-preview"
          value={previewText}
          onChange={(event) => setPreviewText(event.target.value)}
          disabled={!editable}
          placeholder="The line under the subject in the inbox"
        />
        <p className="text-xs text-muted-foreground">
          {/*
           * ⚠ REAL ADVICE, NOT FILLER. Left empty, every mail client falls back
           * to the first words of the body — which for most templates is "View
           * this email in your browser". It is the most-read and least-edited
           * line in any marketing email.
           */}
          Left empty, clients show the first words of your body — usually the
          unsubscribe preamble.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="broadcast-topic">Topic</Label>
        <Select
          value={topicId}
          onValueChange={setTopicId}
          disabled={!editable || topics.length === 0}
        >
          <SelectTrigger id="broadcast-topic">
            <SelectValue
              placeholder={
                topics.length === 0 ? "No topics yet" : "No topic — send to everyone"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {topics.map((topic) => (
              <SelectItem key={topic.id} value={topic.id}>
                {topic.name}
                <span className="ml-2 text-muted-foreground">
                  {topic.subscriber_count}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          With a topic, we skip anyone who opted out of it. Without one, we send to
          every subscribed contact in the segment.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Body</Label>
        <HtmlEditor
          html={html}
          text={text}
          onHtmlChange={setHtml}
          onTextChange={setText}
          disabled={!editable}
        />
        <p className="text-xs text-muted-foreground">
          Merge fields: <code className="font-mono">{"{{first_name}}"}</code>,{" "}
          <code className="font-mono">{"{{last_name}}"}</code>,{" "}
          <code className="font-mono">{"{{email}}"}</code>, plus any contact property.
          Include <code className="font-mono">{"{{unsubscribe_url}}"}</code> — it is
          required by law in most places and by every major inbox provider.
        </p>
      </div>

      {editable && (
        <div className="sticky bottom-0 flex items-center gap-2 border-t bg-background py-3">
          <Button onClick={save} disabled={saving || !dirty}>
            {saving ? <Spinner /> : <Save />}
            Save draft
          </Button>
          {dirty && (
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
          )}
        </div>
      )}
    </div>
  )
}
