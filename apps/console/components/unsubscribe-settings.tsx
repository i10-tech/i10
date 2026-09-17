"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"
import { Label } from "@repo/ui/components/label"
import { Textarea } from "@repo/ui/components/textarea"

/**
 * ⚠ FIXTURE — THE FORM IS REAL AND THE PERSISTENCE IS NOT.
 *
 * The unsubscribe page itself does not exist yet: it needs a public route on a
 * domain we control, a signed token per recipient so somebody cannot unsubscribe
 * a stranger by guessing an id, and a `core.unsubscribe_settings` row to render
 * from. None of those are built, and building the settings form against a
 * pretend API would be worse than building it against none — it would look
 * saved.
 *
 * So this deliberately does NOT call an action, and the banner says so in the
 * interface rather than only in a comment. Tracked in
 * docs/decisions/console.md §7.
 */
export function UnsubscribePageSettings() {
  const [title, setTitle] = React.useState("Manage your email preferences")
  const [description, setDescription] = React.useState(
    "Choose what you hear from us about. You can change this at any time.",
  )
  const [accent, setAccent] = React.useState("#000000")

  return (
    <div className="max-w-2xl space-y-6">
      <p className="rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
        The hosted preference page is not live yet, so nothing here is saved. The
        fields are the ones it will have — the page itself needs a public route
        and a signed per-recipient token before it can ship.
      </p>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="unsub-title">Title</Label>
            <Input
              id="unsub-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="unsub-description">Description</Label>
            <Textarea
              id="unsub-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="unsub-accent">Accent colour</Label>
            <div className="flex items-center gap-2">
              <Input
                id="unsub-accent"
                type="color"
                value={accent}
                onChange={(event) => setAccent(event.target.value)}
                className="h-9 w-14 p-1"
              />
              <Input
                value={accent}
                onChange={(event) => setAccent(event.target.value)}
                className="max-w-[8rem] font-mono text-xs"
                aria-label="Accent colour hex value"
              />
            </div>
          </div>

          <Button disabled>Save</Button>
        </div>

        {/*
         * ⚠ A LIVE PREVIEW RATHER THAN A SCREENSHOT, because the whole point of
         * the form is the appearance. It is rendered with our own components at
         * a smaller scale — not an iframe — since there is no page to frame yet.
         */}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Preview</p>
          <div className="rounded-lg border bg-background p-4">
            <p className="text-sm font-semibold">{title || "Title"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {description || "Description"}
            </p>
            <div className="mt-3 space-y-1.5">
              {["Product updates", "Monthly newsletter"].map((topic) => (
                <label key={topic} className="flex items-center gap-2 text-xs">
                  <span
                    aria-hidden="true"
                    className="size-3 rounded-sm border"
                    style={{ backgroundColor: accent, borderColor: accent }}
                  />
                  {topic}
                </label>
              ))}
            </div>
            <div
              className="mt-3 rounded-md px-2 py-1 text-center text-2xs text-white"
              style={{ backgroundColor: accent }}
            >
              Save preferences
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
