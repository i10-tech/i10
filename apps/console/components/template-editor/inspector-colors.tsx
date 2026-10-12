"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/core"
import { ColorPicker } from "@repo/ui/components/color-picker/color-picker"

/**
 * Arc's colour picker in place of the browser's, in every colour field of the
 * React Email inspector (page and container background, a block's background,
 * its border, text and link colour).
 *
 * ⚠ GRAFTED ONTO REACT EMAIL'S OWN FIELDS, NOT A REWRITE OF ITS SECTIONS. The
 * inspector draws its colour control in eight places and offers no render
 * prop for it; rebuilding those sections would mean owning their layout and
 * their style plumbing too. So each control (`[data-re-inspector-color-control]`)
 * gets an Arc picker portalled into it, its two native inputs are hidden
 * (editor.css), and a pick is typed into React Email's hex field the way a
 * person would - a native value set and an `input` event - so React Email
 * still owns the value and records the change itself.
 *
 * ⚠ READ BACK ON EVERY EDITOR TRANSACTION. React Email sets the hex field's
 * value as a property, which no DOM observer sees; an undo, or selecting a
 * different block, changes it through a transaction, so that is the signal.
 */
export function InspectorColors({
  root,
  editor,
}: {
  root: React.RefObject<HTMLElement | null>
  editor: Editor
}) {
  const [hosts, setHosts] = React.useState<HTMLElement[]>([])

  React.useEffect(() => {
    const element = root.current
    if (!element) return
    const collect = () => {
      const found = [
        ...element.querySelectorAll<HTMLElement>("[data-re-inspector-color-control]"),
      ]
      setHosts((prev) =>
        prev.length === found.length && prev.every((h, i) => h === found[i])
          ? prev
          : found,
      )
    }
    collect()
    const observer = new MutationObserver(collect)
    observer.observe(element, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [root])

  return (
    <>
      {hosts.map((host) =>
        createPortal(<HostedPicker host={host} editor={editor} />, host, keyOf(host)),
      )}
    </>
  )
}

/** A stable key per host element, so a new block's field gets a new picker. */
const ids = new WeakMap<HTMLElement, number>()
let next = 0
function keyOf(host: HTMLElement) {
  let id = ids.get(host)
  if (id === undefined) {
    id = next++
    ids.set(host, id)
  }
  return `color-${id}`
}

const SECTION_NAMES: Record<string, string> = {
  Typography: "Text",
  Container: "Container",
}

function nameFor(host: HTMLElement): string {
  const row = host.closest("[data-re-inspector-prop-row]")
  const own =
    row?.querySelector("[data-re-inspector-label]")?.textContent?.trim() || "Color"
  if (own.toLowerCase() !== "color") return own
  const section = host
    .closest("[data-re-inspector-section]")
    ?.querySelector("[data-re-inspector-section-header]")
    ?.textContent?.trim()
  if (!section) return "Color"
  return `${SECTION_NAMES[section] ?? section} color`
}

function hexField(host: HTMLElement) {
  return host.querySelector<HTMLInputElement>("[data-re-inspector-color-hex]")
}

function HostedPicker({ host, editor }: { host: HTMLElement; editor: Editor }) {
  const [value, setValue] = React.useState(() => hexField(host)?.value ?? "")

  React.useEffect(() => {
    const sync = () => {
      const current = hexField(host)?.value ?? ""
      setValue((prev) => (prev === current ? prev : current))
    }
    editor.on("transaction", sync)
    return () => {
      editor.off("transaction", sync)
    }
  }, [editor, host])

  // The trigger names the colour, since the row's own label is hidden
  // (editor.css): "Background color", "Border color", "Text color".
  const label = nameFor(host)

  return (
    <span className="i10-inspector-color">
      <ColorPicker
        label={label}
        value={/^#[0-9a-f]{3,8}$/i.test(value) ? value : "#ffffff"}
        onValueChange={(hex) => {
          setValue(hex)
          const field = hexField(host)
          if (!field) return
          const set = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set
          set?.call(field, hex)
          field.dispatchEvent(new Event("input", { bubbles: true }))
        }}
      />
    </span>
  )
}
