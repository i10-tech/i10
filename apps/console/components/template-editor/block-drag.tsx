"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { Extension, type Editor } from "@tiptap/core"
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model"
import {
  NodeSelection,
  Plugin,
  TextSelection,
  type EditorState,
  type Selection,
} from "@tiptap/pm/state"
import { dropPoint } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import type { SlashCommandItem } from "@react-email/editor/ui"
import { GripVertical } from "lucide-react"
import { cn } from "cn"

/**
 * Blocks move by dragging, Resend's way: a grip beside the block under the
 * pointer reorders it, and a component dragged out of the toolbar lands
 * where the line says.
 *
 * ⚠ BOTH RIDE PROSEMIRROR'S OWN DRAG. Setting `view.dragging` to a slice is
 * all ProseMirror needs to move a node on drop and to snap the drop line to
 * a block boundary; nothing here re-implements either. That is also why
 * TipTap's drag-handle extension is not used - it pulls in Yjs as a peer.
 *
 * ⚠ A COMPONENT HAS NO SLICE UNTIL IT IS INSERTED. Its menu command builds
 * it, so a toolbar drag carries an empty paragraph as a stand-in - which is
 * what makes the line snap between blocks - and the drop runs the command on
 * a fresh line at that spot, exactly as `/` would.
 */

/** The MIME type a dragged component travels as. */
const BLOCK_TYPE = "application/x-i10-block"

const pending = new WeakMap<EditorView, { editor: Editor; item: SlashCommandItem }>()
const pendingVariable = new WeakMap<EditorView, string>()

/**
 * What follows the pointer during a drag: the item's icon and name on a
 * small chip, instead of the browser's ghost of the whole menu row.
 *
 * ⚠ BUILT IN THE PAGE, THEN REMOVED A TICK LATER. The browser snapshots a
 * drag image when dragstart returns, from an element that is in the
 * document; plain styles, because it lives outside the app's CSS scope.
 */
function setChipDragImage(event: React.DragEvent, label: string) {
  const chip = document.createElement("div")
  Object.assign(chip.style, {
    position: "fixed",
    top: "-1000px",
    left: "-1000px",
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "7px 12px 7px 9px",
    borderRadius: "12px",
    background: "#171717",
    color: "#fafafa",
    font: "500 13px/1 ui-sans-serif, system-ui, -apple-system, sans-serif",
    boxShadow: "0 8px 24px -8px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.08)",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>)
  const source = (event.currentTarget as HTMLElement).querySelector("svg")
  if (source) {
    const copy = source.cloneNode(true) as SVGElement
    copy.setAttribute("width", "16")
    copy.setAttribute("height", "16")
    copy.style.flexShrink = "0"
    copy.style.opacity = "0.85"
    chip.append(copy)
  }
  chip.append(label)
  document.body.append(chip)
  event.dataTransfer.setDragImage(chip, 14, chip.offsetHeight / 2)
  setTimeout(() => chip.remove(), 0)
}

/**
 * A variable drags as the chip it becomes - `{{{name}}}`, braces dimmed, in the
 * editor chip's own blue - so what follows the pointer is what will land.
 */
function setVariableDragImage(event: React.DragEvent, name: string) {
  const chip = document.createElement("div")
  Object.assign(chip.style, {
    position: "fixed",
    top: "-1000px",
    left: "-1000px",
    display: "inline-flex",
    alignItems: "center",
    padding: "3px 8px",
    borderRadius: "7px",
    background: "rgb(239 246 255)",
    color: "rgb(37 99 235)",
    boxShadow:
      "inset 0 0 0 1px rgb(59 130 246 / 0.3), 0 6px 18px -8px rgb(0 0 0 / 0.35)",
    font: "500 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>)
  const brace = (text: string) => {
    const span = document.createElement("span")
    span.textContent = text
    span.style.opacity = "0.55"
    return span
  }
  chip.append(brace("{{{"), name, brace("}}}"))
  document.body.append(chip)
  event.dataTransfer.setDragImage(chip, 12, chip.offsetHeight / 2)
  setTimeout(() => chip.remove(), 0)
}

/**
 * What follows the pointer when content of the email is dragged - a block by
 * its grip, or selected text: the content on a small white card.
 *
 * ⚠ NEVER THE BROWSER'S OWN GHOST. It paints dragged text in the PAGE's text
 * colour, and the console is dark while the email is white - so the text
 * travelled as white, all but invisible over the email it was moving in.
 * The card carries the email's own colour and font.
 */
export function setContentDragImage(
  data: DataTransfer,
  view: EditorView,
  content: HTMLElement | string,
) {
  const font = getComputedStyle(view.dom)
  const card = document.createElement("div")
  Object.assign(card.style, {
    position: "fixed",
    top: "-1000px",
    left: "-1000px",
    maxWidth: "360px",
    maxHeight: "160px",
    overflow: "hidden",
    padding: "8px 12px",
    borderRadius: "10px",
    background: "#fff",
    color: "#0a0a0a",
    fontFamily: font.fontFamily,
    fontSize: font.fontSize,
    lineHeight: font.lineHeight,
    boxShadow: "0 10px 30px -10px rgb(0 0 0 / 0.35), 0 0 0 1px rgb(0 0 0 / 0.06)",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>)
  if (typeof content === "string") {
    card.style.whiteSpace = "nowrap"
    card.style.textOverflow = "ellipsis"
    card.textContent = content.length > 80 ? `${content.slice(0, 80)}…` : content
  } else {
    const copy = content.cloneNode(true) as HTMLElement
    copy.style.margin = "0"
    copy.style.padding = "0"
    card.append(copy)
  }
  document.body.append(card)
  data.setDragImage(card, 16, 16)
  setTimeout(() => card.remove(), 0)
}

/** Starts dragging a component from the toolbar into the email. */
export function startComponentDrag(
  editor: Editor,
  item: SlashCommandItem,
  event: React.DragEvent,
) {
  const { view } = editor
  event.dataTransfer.effectAllowed = "copy"
  // ⚠ SOME DATA IS REQUIRED: Firefox starts no drag without it.
  event.dataTransfer.setData(BLOCK_TYPE, item.title)
  setChipDragImage(event, item.title)
  const stand = view.state.schema.nodes.paragraph?.create()
  if (!stand) return
  pending.set(view, { editor, item })
  view.dragging = { slice: new Slice(Fragment.from(stand), 0, 0), move: false }
}

/**
 * Starts dragging a variable from the toolbar. Unlike a component it is
 * inline content with a real slice, so ProseMirror drops it at the caret
 * under the pointer by itself, inside a line of text.
 *
 * ⚠ IT ALSO TRAVELS AS `{{{ name }}}` TEXT, so dropping it on the subject or
 * preview line types the placeholder there.
 */
export function startVariableDrag(
  editor: Editor,
  name: string,
  event: React.DragEvent,
) {
  const { view } = editor
  const { variable } = view.state.schema.nodes
  if (!variable) return
  event.dataTransfer.effectAllowed = "copy"
  event.dataTransfer.setData("text/plain", `{{{ ${name} }}}`)
  setVariableDragImage(event, name)
  pending.delete(view)
  pendingVariable.set(view, name)
  view.dragging = {
    slice: new Slice(Fragment.from(variable.create({ name })), 0, 0),
    move: false,
  }
}

/**
 * The editor's `handleDrop` for a variable: placed where ProseMirror would,
 * but spaced like a word - a space before it when it lands against one, and
 * after it unless a space is already there.
 */
export function dropVariable(view: EditorView, event: DragEvent): boolean {
  const name = pendingVariable.get(view)
  if (name === undefined) return false
  pendingVariable.delete(view)
  const { schema, doc } = view.state
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
  const chip = schema.nodes.variable?.create({ name })
  if (!at || !chip) return true
  const target = dropPoint(doc, at.pos, new Slice(Fragment.from(chip), 0, 0)) ?? at.pos
  const $at = doc.resolve(target)
  const inText = $at.parent.isTextblock
  const before = inText
    ? doc.textBetween(Math.max($at.start(), target - 1), target)
    : ""
  const after = inText ? doc.textBetween(target, Math.min($at.end(), target + 1)) : ""
  const nodes = [
    ...(before && !/\s/.test(before) ? [schema.text(" ")] : []),
    chip,
    ...(/\s/.test(after) ? [] : [schema.text(" ")]),
  ]
  const tr = view.state.tr.insert(target, Fragment.from(nodes))
  tr.setSelection(TextSelection.create(tr.doc, target + Fragment.from(nodes).size))
  view.focus()
  view.dispatch(tr.setMeta("uiEvent", "drop"))
  return true
}

/** The drag ended without a drop in the email: forget it. */
export function endComponentDrag(editor: Editor) {
  pending.delete(editor.view)
  pendingVariable.delete(editor.view)
  if (editor.view.dragging && !editor.view.dragging.move) editor.view.dragging = null
}

/**
 * The editor's `handleDrop`: places a component dragged from the toolbar.
 * False for anything else, which ProseMirror then drops as usual.
 */
export function dropComponent(view: EditorView, event: DragEvent): boolean {
  const drag = pending.get(view)
  if (!drag) return false
  pending.delete(view)
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
  const paragraph = view.state.schema.nodes.paragraph
  if (!at || !paragraph) return true
  const target =
    dropPoint(
      view.state.doc,
      at.pos,
      new Slice(Fragment.from(paragraph.create()), 0, 0),
    ) ?? at.pos
  placeComponent(view, drag, target)
  return true
}

/** Puts a component in at `pos`: a fresh line there, then its `/` command. */
function placeComponent(
  view: EditorView,
  drag: { editor: Editor; item: SlashCommandItem },
  pos: number,
) {
  const paragraph = view.state.schema.nodes.paragraph
  if (!paragraph) return
  const tr = view.state.tr.insert(pos, paragraph.create())
  tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  view.dispatch(tr)
  drag.item.command({ editor: drag.editor, range: { from: pos + 1, to: pos + 1 } })
  drag.editor.commands.focus()
}

/**
 * Where a dragged block or component would land: before or after the row
 * under the pointer, by which HALF of the row the pointer is in.
 *
 * ⚠ BY HEIGHT, NOT BY TEXT POSITION. ProseMirror's own drop point asks which
 * half of the row's TEXT the pointer is over, so on a short line - pointer
 * past its last word - it always meant "after", and the line showed under a
 * row the pointer was plainly on top of.
 */
function dropSpot(
  view: EditorView,
  x: number,
  y: number,
  carried: PMNode,
): number | null {
  const { doc } = view.state
  const at = view.posAtCoords({ left: x, top: y })
  const row = at ? blockAt(doc, at.pos, at.inside) : null
  let pos: number
  if (row) {
    const dom = view.nodeDOM(row.pos)
    const rect = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null
    const before = rect ? y < rect.top + rect.height / 2 : true
    pos = before ? row.pos : row.pos + row.node.nodeSize
  } else {
    // Below everything: the end of the email.
    const container = doc.firstChild
    pos = container ? container.nodeSize - 1 : doc.content.size
  }
  const $pos = doc.resolve(pos)
  if ($pos.parent.canReplaceWith($pos.index(), $pos.index(), carried.type)) return pos
  return dropPoint(doc, pos, new Slice(Fragment.from(carried), 0, 0))
}

/** Where the line goes for a drop at `pos`: in the gap, as wide as the rows. */
function lineAt(
  view: EditorView,
  pos: number,
): { top: number; left: number; width: number } | null {
  const $pos = view.state.doc.resolve(pos)
  const prev = $pos.nodeBefore ? view.nodeDOM(pos - $pos.nodeBefore.nodeSize) : null
  const next = $pos.nodeAfter ? view.nodeDOM(pos) : null
  const a = prev instanceof HTMLElement ? prev.getBoundingClientRect() : null
  const b = next instanceof HTMLElement ? next.getBoundingClientRect() : null
  const box = b ?? a
  if (!box) return null
  const top = a && b ? (a.bottom + b.top) / 2 : b ? b.top : (a?.bottom ?? box.bottom)
  return { top, left: box.left, width: box.width }
}

/** Starts dragging the block at `pos`; ProseMirror moves it on drop. */
function startBlockMove(editor: Editor, pos: number, event: React.DragEvent) {
  const { view } = editor
  // ⚠ NOT DISPATCHED AS THE EDITOR'S SELECTION. A click on the grip with the
  // slightest movement starts a drag instead, and a drag fires no click: a
  // selection set here was left behind as the line selected as a node - the
  // text menu then read its alignment as "left" and hid after one edit. The
  // move only needs to know which node it carries.
  const selection = NodeSelection.create(view.state.doc, pos)
  const slice = selection.content()
  const { dom, text } = view.serializeForClipboard(slice)
  event.dataTransfer.clearData()
  event.dataTransfer.setData("text/html", dom.innerHTML)
  event.dataTransfer.setData("text/plain", text)
  event.dataTransfer.effectAllowed = "copyMove"
  const el = view.nodeDOM(pos)
  if (el instanceof HTMLElement) setContentDragImage(event.dataTransfer, view, el)
  // ⚠ `node` IS WHAT ProseMirror DELETES FROM ON A MOVE, though its types
  // leave it out; without it the move deletes "the selection".
  const drag = { slice, move: true, node: selection }
  view.dragging = drag
}

/**
 * What clicking a row's grip (or dropping it) selects: the row, whole - text
 * line or not, empty or not. The text menu understands a row selected whole
 * (see `TextBubbleMenu`: its alignment and when it shows are the row's own).
 */
export function rowSelection(doc: PMNode, pos: number): Selection {
  return NodeSelection.create(doc, pos)
}

/** Blocks that move as a whole, never by the line inside them. */
const WHOLE = new Set(["listItem", "bulletList", "orderedList", "blockquote"])

/**
 * The row a position is in - what the grip drags and the menu's move and
 * delete act on: the innermost paragraph, heading, button, divider or image.
 *
 * ⚠ ROWS, NOT TOP-LEVEL BLOCKS. An email whose content sits in one wrapper -
 * a section, or the `div` imported HTML brings - is ONE top-level block, so
 * the grip only ever found its first row. A list item or a quote moves as its
 * whole list or quote. Over a section's own padding (`inside` is the
 * section), the section itself is the row, so it can still move as one.
 */
function blockAt(
  doc: PMNode,
  pos: number,
  inside = -1,
): { pos: number; node: PMNode } | null {
  if (inside >= 0) {
    const node = doc.nodeAt(inside)
    if (node?.isBlock && node.type.name !== "container") {
      const rowItself = node.isTextblock || node.isLeaf
      const layoutPadding = !doc.resolve(pos).parent.isTextblock
      if (rowItself || layoutPadding) return whole(doc, inside, node)
    }
  }
  const $pos = doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.isTextblock || node.isLeaf) return whole(doc, $pos.before(d), node)
  }
  // Between rows: the one right after.
  const after = $pos.nodeAfter
  if (after?.isBlock) return whole(doc, pos, after)
  return null
}

/** Out of a list item or quote, to the whole list or quote. */
function whole(doc: PMNode, pos: number, node: PMNode): { pos: number; node: PMNode } {
  const $pos = doc.resolve(pos)
  let found = { pos, node }
  for (let d = $pos.depth; d > 0; d--) {
    const ancestor = $pos.node(d)
    if (WHOLE.has(ancestor.type.name)) found = { pos: $pos.before(d), node: ancestor }
  }
  return found
}

/**
 * The middle of a block's first line of text - where the grip belongs, so it
 * sits level with the words and not with the block's padding.
 *
 * ⚠ FROM THE CARET'S OWN BOX, which knows the line height and the padding
 * both; a fixed offset from the block's top was off by the padding. A block
 * with no text (a divider, an image) is centred as a whole instead.
 */
function firstLineMiddle(
  view: EditorView,
  block: { pos: number; node: PMNode },
  rect: DOMRect,
): number {
  let textAt: number | null = null
  if (block.node.isTextblock) textAt = block.pos + 1
  else
    block.node.descendants((child, offset) => {
      if (textAt !== null) return false
      if (child.isTextblock) textAt = block.pos + 1 + offset + 1
      return textAt === null
    })
  if (textAt !== null) {
    try {
      const caret = view.coordsAtPos(textAt)
      if (caret.bottom > caret.top) return (caret.top + caret.bottom) / 2
    } catch {
      // Not drawn yet: fall through to the block's own middle.
    }
  }
  return rect.top + Math.min(rect.height, 48) / 2
}

/**
 * The grip that follows the pointer down the email and drags the block it
 * sits beside.
 */
export function BlockHandle({ editor }: { editor: Editor }) {
  const [block, setBlock] = React.useState<{
    pos: number
    rect: DOMRect
    /** The vertical middle of the block's first line, where the grip sits. */
    line: number
  } | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const handle = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    const { view } = editor
    let frame = 0
    function locate(x: number, y: number) {
      const bounds = view.dom.getBoundingClientRect()
      // The gutter on the left counts, so the grip can be reached.
      if (
        y < bounds.top ||
        y > bounds.bottom ||
        x < bounds.left - 56 ||
        x > bounds.right
      ) {
        return setBlock(null)
      }
      const at = view.posAtCoords({ left: Math.max(x, bounds.left + 4), top: y })
      if (!at) return setBlock(null)
      const found = blockAt(view.state.doc, at.pos, at.inside)
      const dom = found && (view.nodeDOM(found.pos) as HTMLElement | null)
      if (!found || !dom?.getBoundingClientRect) return setBlock(null)
      const rect = dom.getBoundingClientRect()
      setBlock({ pos: found.pos, rect, line: firstLineMiddle(view, found, rect) })
    }
    function onMove(event: MouseEvent) {
      if (view.dragging) return
      if (handle.current?.contains(event.target as Node)) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => locate(event.clientX, event.clientY))
    }
    const hide = () => setBlock(null)
    // ⚠ EVERY DRAG ENDS HERE, AT THE WINDOW. The grip lives outside the
    // editor, so ProseMirror's own dragend never sees a block drag: one that
    // ended anywhere but the email left `view.dragging` set, and the grip
    // waited for it for ever. And a drop re-renders the email, which unmounts
    // the grip mid-drag, so its own onDragEnd never ran and it stayed faded.
    const settle = () => {
      setDragging(false)
      setTimeout(() => {
        if (view.dragging?.move) view.dragging = null
      }, 0)
    }
    window.addEventListener("dragend", settle, true)
    window.addEventListener("drop", settle, true)

    // ⚠ BLOCK AND COMPONENT DROPS ARE OURS, END TO END. The line and the
    // landing are both decided by `dropSpot` - the half of the row under the
    // pointer - so what is dropped goes exactly where the line was. These
    // listeners run in the capture phase on the canvas and stop the event,
    // so ProseMirror never shows its own cursor for them. A variable is
    // inline and keeps ProseMirror's caret; from the white space beside the
    // email it is handed in at the nearest point.
    //
    // ⚠ THE WHITE SPACE AROUND THE EMAIL CATCHES A DROP TOO, beside or below
    // it. The envelope fields above are left alone: a variable can still be
    // dropped on the subject.
    const canvas = view.dom.closest<HTMLElement>(".i10-canvas")
    const line = document.createElement("div")
    line.className = "i10-drop-line"
    line.setAttribute("aria-hidden", "true")
    document.body.append(line)
    const forwarded = new WeakSet<Event>()

    function hideLine() {
      line.removeAttribute("data-on")
    }
    function showLine(at: { top: number; left: number; width: number }) {
      const first = !line.hasAttribute("data-on")
      // Appearing, it starts where it is shown, not where it last was.
      if (first) line.style.transition = "none"
      line.style.top = `${at.top}px`
      line.style.left = `${at.left}px`
      line.style.width = `${at.width}px`
      if (first) {
        void line.offsetWidth
        line.style.transition = ""
      }
      line.setAttribute("data-on", "")
    }
    /** What is in hand, if it is a block or a component - not inline. */
    function carried(): PMNode | null {
      const first = view.dragging?.slice.content.firstChild
      return first && !first.isInline ? first : null
    }
    function clamp(event: DragEvent) {
      const b = view.dom.getBoundingClientRect()
      return {
        x: Math.min(Math.max(event.clientX, b.left + 2), b.right - 2),
        y: Math.min(Math.max(event.clientY, b.top + 2), b.bottom - 2),
        above: event.clientY < b.top - 8,
      }
    }
    function handInline(event: DragEvent) {
      if (view.dom.contains(event.target as Node)) return
      const { x, y, above } = clamp(event)
      if (above) return
      event.preventDefault()
      const copy = new DragEvent(event.type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        dataTransfer: event.dataTransfer,
      })
      forwarded.add(copy)
      view.dom.dispatchEvent(copy)
    }
    function onOver(event: DragEvent) {
      if (!view.dragging || forwarded.has(event)) return
      const node = carried()
      if (!node) return handInline(event)
      const { x, y, above } = clamp(event)
      if (above) return hideLine()
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = view.dragging.move ? "move" : "copy"
      const pos = dropSpot(view, x, y, node)
      const at = pos === null ? null : lineAt(view, pos)
      if (at) showLine(at)
      else hideLine()
    }
    function onDrop(event: DragEvent) {
      if (!view.dragging || forwarded.has(event)) return
      const node = carried()
      if (!node) return handInline(event)
      const { x, y, above } = clamp(event)
      hideLine()
      if (above) return
      event.preventDefault()
      event.stopPropagation()
      const pos = dropSpot(view, x, y, node)
      const dragging = view.dragging as { move: boolean; node?: NodeSelection }
      view.dragging = null
      if (pos === null) return
      const component = pending.get(view)
      if (component) {
        pending.delete(view)
        placeComponent(view, component, pos)
        return
      }
      const source = dragging.node
      if (!dragging.move || !source) return
      const from = source.from
      const size = source.node.nodeSize
      // Dropped onto itself: nothing moves, and it was a click - select the
      // row as a click on the grip does.
      if (pos >= from && pos <= from + size) {
        view.dispatch(view.state.tr.setSelection(rowSelection(view.state.doc, from)))
        view.focus()
        return
      }
      const tr = view.state.tr.delete(from, from + size)
      const at = tr.mapping.map(pos)
      tr.insert(at, source.node)
      tr.setSelection(rowSelection(tr.doc, at))
      view.dispatch(tr.scrollIntoView())
      view.focus()
    }
    function onLeave(event: DragEvent) {
      if (!canvas?.contains(event.relatedTarget as Node | null)) hideLine()
    }
    canvas?.addEventListener("dragover", onOver, true)
    canvas?.addEventListener("drop", onDrop, true)
    canvas?.addEventListener("dragleave", onLeave, true)
    window.addEventListener("dragend", hideLine, true)
    document.addEventListener("mousemove", onMove)
    document.addEventListener("scroll", hide, true)
    editor.on("update", hide)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("scroll", hide, true)
      window.removeEventListener("dragend", settle, true)
      window.removeEventListener("drop", settle, true)
      canvas?.removeEventListener("dragover", onOver, true)
      canvas?.removeEventListener("drop", onDrop, true)
      canvas?.removeEventListener("dragleave", onLeave, true)
      window.removeEventListener("dragend", hideLine, true)
      line.remove()
      editor.off("update", hide)
    }
  }, [editor])

  if (!block || !editor.isEditable) return null
  // The grip is 24px tall: centred on the first line.
  const top = Math.round(block.line - 12)

  return createPortal(
    <button
      ref={handle}
      type="button"
      draggable
      aria-label="Drag to move this block"
      title="Drag to move"
      onClick={() => {
        editor.view.dispatch(
          editor.state.tr.setSelection(rowSelection(editor.state.doc, block.pos)),
        )
        editor.view.focus()
      }}
      onDragStart={(event) => {
        startBlockMove(editor, block.pos, event)
        // ⚠ A TICK LATER: changing the source inside its own dragstart makes
        // Chrome cancel the drag.
        setTimeout(() => setDragging(true), 0)
      }}
      onDragEnd={() => {
        setDragging(false)
        setBlock(null)
      }}
      style={{ top, left: block.rect.left - 30 }}
      className={cn(
        "fixed z-30 grid h-6 w-5 cursor-grab place-items-center rounded-md text-neutral-400",
        "transition-colors hover:bg-neutral-100 hover:text-neutral-700 active:cursor-grabbing",
        dragging && "opacity-0",
      )}
    >
      <GripVertical className="size-4" />
    </button>,
    document.body,
  )
}

/**
 * The box around what a block actually shows - its text and its chips -
 * not the boxes they sit in.
 *
 * ⚠ NOT THE BLOCK'S CONTENTS AS A WHOLE. A heading is drawn through a
 * wrapper whose content box is the email's full width, so measuring its
 * contents ringed the whole row; only text and inline atoms are measured.
 */
function inkOf(dom: HTMLElement): DOMRect {
  let top = Infinity
  let left = Infinity
  let right = -Infinity
  let bottom = -Infinity
  const add = (r: DOMRect) => {
    if (r.width === 0 && r.height === 0) return
    top = Math.min(top, r.top)
    left = Math.min(left, r.left)
    right = Math.max(right, r.right)
    bottom = Math.max(bottom, r.bottom)
  }
  const walker = document.createTreeWalker(
    dom,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  )
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n instanceof Text) {
      if (!n.data.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of Array.from(range.getClientRects())) add(r)
    } else if (
      n instanceof HTMLElement &&
      n.getAttribute("contenteditable") === "false"
    ) {
      // A variable chip and the like: measured whole.
      add(n.getBoundingClientRect())
    }
  }
  return top === Infinity
    ? new DOMRect()
    : new DOMRect(left, top, right - left, bottom - top)
}

/**
 * Marks a selected text block for `SelectionRing`, so its own outline goes
 * (editor.css) and the two never show together.
 *
 * ⚠ A DECORATION, NOT AN ATTRIBUTE SET BY HAND. ProseMirror redraws a node
 * whose DOM changes behind its back, which wiped a hand-set marker at once;
 * a decoration is ProseMirror's own, and lands on a node view's wrapper too
 * - a heading is drawn through one, which a rule by tag had missed.
 */
export const RingedSelection = Extension.create({
  name: "i10RingedSelection",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const { selection } = state
            if (!(selection instanceof NodeSelection) || !selection.node.isTextblock)
              return null
            return DecorationSet.create(state.doc, [
              Decoration.node(selection.from, selection.to, { "data-i10-ringed": "" }),
            ])
          },
        },
      }),
    ]
  },
})

/**
 * The ring around a selected text block - a paragraph after it was moved,
 * or picked by its grip - drawn around its words, not its box.
 *
 * ⚠ AN OVERLAY, BECAUSE AN OUTLINE CAN ONLY FOLLOW THE BOX. A paragraph is
 * the email's full width with the theme's padding above and below, so its
 * outline framed a 600px slab around one short line and hung over whatever
 * sat under it. This measures the text itself, so it grows as it is typed.
 */
export function SelectionRing({
  editor,
  container,
}: {
  editor: Editor
  container: React.RefObject<HTMLElement | null>
}) {
  const ring = React.useRef<HTMLDivElement>(null)

  // ⚠ POSITIONED DIRECTLY, NOT THROUGH STATE. A move up or down slides the
  // line the moment it lands; a ring that waited for React to re-render
  // arrived after it. Set here, it is in place when the move's slide starts,
  // and `slide` carries it along with the line.
  React.useEffect(() => {
    const { view } = editor
    function measure() {
      const el = ring.current
      const box = container.current
      if (!el) return
      const selection = view.state.selection
      const dom =
        box && selection instanceof NodeSelection && selection.node.isTextblock
          ? view.nodeDOM(selection.from)
          : null
      if (!box || !(dom instanceof HTMLElement)) {
        el.style.display = "none"
        return
      }
      // Mid-slide, its rectangle is still moving: measure once it lands.
      const running = dom.getAnimations()
      if (running.length > 0) {
        void Promise.all(running.map((a) => a.finished)).then(measure, measure)
        return
      }
      let text = inkOf(dom)
      if (text.width === 0 || text.height === 0) {
        // Empty: the whole line it would hold, not a caret-wide sliver.
        const caret = view.coordsAtPos(selection.from + 1)
        const row = dom.getBoundingClientRect()
        text = new DOMRect(row.left, caret.top, row.width, caret.bottom - caret.top)
      }
      const origin = box.getBoundingClientRect()
      const gap = 4
      Object.assign(el.style, {
        display: "block",
        top: `${text.top - origin.top - gap}px`,
        left: `${text.left - origin.left - gap}px`,
        width: `${text.width + gap * 2}px`,
        height: `${text.height + gap * 2}px`,
      })
    }
    measure()
    editor.on("transaction", measure)
    const resize = new ResizeObserver(measure)
    resize.observe(view.dom)
    return () => {
      editor.off("transaction", measure)
      resize.disconnect()
    }
  }, [editor, container])

  return (
    <div
      ref={ring}
      aria-hidden
      data-i10-selection-ring=""
      className="pointer-events-none absolute z-10 hidden rounded-md outline-2 outline-[rgb(59_130_246/0.6)] outline-solid"
    />
  )
}

/** Marks a move-up/down transaction: the text menu is carried, not re-measured. */
export const MOVED_META = "i10BlockMoved"

/** Whether the block the caret is in can move up, down - for the menu. */
export function blockMoves(editor: Editor): { up: boolean; down: boolean } {
  const { doc, selection } = editor.state
  const found = blockAt(doc, selection.from)
  if (!found) return { up: false, down: false }
  const $at = doc.resolve(found.pos)
  return { up: $at.index() > 0, down: $at.index() < $at.parent.childCount - 1 }
}

/**
 * Swaps the block the caret is in with the one above or below it, keeping
 * the caret where it was inside it.
 */
export function moveBlock(editor: Editor, direction: -1 | 1): boolean {
  const { state, view } = editor
  const found = blockAt(state.doc, state.selection.from)
  if (!found) return false
  const $at = state.doc.resolve(found.pos)
  const index = $at.index() + direction
  if (index < 0 || index >= $at.parent.childCount) return false
  const neighbour = $at.parent.child(index)
  const size = found.node.nodeSize
  const target =
    direction < 0 ? found.pos - neighbour.nodeSize : found.pos + neighbour.nodeSize
  const { from, to } = state.selection
  // Positions before the parent do not change, so its content starts at the
  // same place after the move.
  const contentStart = $at.start()
  const before = snapshot(view, contentStart)
  const tr = state.tr.delete(found.pos, found.pos + size).insert(target, found.node)
  const shift = target - found.pos
  tr.setSelection(
    state.selection instanceof NodeSelection
      ? NodeSelection.create(tr.doc, target)
      : TextSelection.create(tr.doc, from + shift, to + shift),
  )
  view.dispatch(tr.setMeta(MOVED_META, true).scrollIntoView())
  slide(view, contentStart, before, found.node)
  view.focus()
  return true
}

/**
 * Where each block beside the moved one sits on screen, by its node.
 *
 * ⚠ BY NODE, NOT BY ELEMENT. ProseMirror may re-create the elements of
 * blocks around a move, but the document's nodes are immutable and carried
 * over unchanged, so a node is the one thing that is the same block before
 * and after. Only siblings are measured: their children ride along.
 */
function snapshot(view: EditorView, contentStart: number): Map<PMNode, number> {
  const tops = new Map<PMNode, number>()
  eachSibling(view, contentStart, (node, el) =>
    tops.set(node, el.getBoundingClientRect().top),
  )
  return tops
}

function eachSibling(
  view: EditorView,
  contentStart: number,
  visit: (node: PMNode, el: HTMLElement) => void,
) {
  view.state.doc.resolve(contentStart).parent.forEach((node, offset) => {
    const el = view.nodeDOM(contentStart + offset)
    if (el instanceof HTMLElement) visit(node, el)
  })
}

/**
 * Slides each block from where it was to where it now is - the FLIP
 * technique - so a move reads as a move instead of a jump.
 */
function slide(
  view: EditorView,
  contentStart: number,
  before: Map<PMNode, number>,
  moved: PMNode,
) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const timing = { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
  eachSibling(view, contentStart, (node, el) => {
    const from = before.get(node)
    if (from === undefined) return
    const offset = from - el.getBoundingClientRect().top
    if (Math.abs(offset) < 1) return
    if (node === moved) {
      carryTextMenu(-offset, offset, reduce ? null : timing)
      // The ring around the moved line is already at its new place; slide
      // it there from the old one, with the line.
      const ringEl = document.querySelector<HTMLElement>("[data-i10-selection-ring]")
      if (!reduce && ringEl && ringEl.style.display !== "none")
        ringEl.animate(
          [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
          timing,
        )
    }
    if (reduce) return
    el.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
      timing,
    )
  })
}

/**
 * The text menu travels WITH the line it belongs to, the same distance on the
 * same curve, instead of waiting for the line to arrive and then gliding
 * after it.
 *
 * ⚠ PLACED AT ITS NEW SPOT AT ONCE, THEN SLID THERE FROM THE OLD ONE, the
 * way the line itself is. Its own glide (editor.css) is switched off for the
 * jump, and TipTap's later re-measure lands where it already is.
 */
function carryTextMenu(
  distance: number,
  startOffset: number,
  timing: KeyframeAnimationOptions | null,
) {
  const menu = document.querySelector<HTMLElement>("[data-i10-text-menu]")
  if (!menu?.isConnected || menu.style.visibility === "hidden") return
  const top = parseFloat(menu.style.top)
  if (!Number.isFinite(top)) return
  menu.style.transition = "none"
  menu.style.top = `${top + distance}px`
  void menu.offsetWidth
  menu.style.transition = ""
  if (timing)
    menu.animate(
      [{ transform: `translateY(${startOffset}px)` }, { transform: "translateY(0)" }],
      timing,
    )
}

/**
 * Deletes the block the caret is in. The email's container may not be
 * empty, so its last block becomes an empty line instead.
 */
export function deleteBlock(editor: Editor): boolean {
  const { state, view } = editor
  const found = blockAt(state.doc, state.selection.from)
  if (!found) return false
  const $at = state.doc.resolve(found.pos)
  const tr = state.tr
  if ($at.parent.childCount === 1) {
    const line = state.schema.nodes.paragraph?.create()
    if (!line) return false
    tr.replaceWith(found.pos, found.pos + found.node.nodeSize, line)
  } else {
    tr.delete(found.pos, found.pos + found.node.nodeSize)
  }
  tr.setSelection(
    TextSelection.near(tr.doc.resolve(Math.min(found.pos + 1, tr.doc.content.size))),
  )
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

/**
 * The text row a selection is on - text inside it, or the row itself
 * selected whole (an empty line can only be selected that way) - or null.
 */
export function selectedTextRow(
  state: EditorState,
): { pos: number; node: PMNode } | null {
  const { selection } = state
  if (selection instanceof NodeSelection)
    return selection.node.isTextblock
      ? { pos: selection.from, node: selection.node }
      : null
  const { $from } = selection
  for (let d = $from.depth; d > 0; d--)
    if ($from.node(d).isTextblock) return { pos: $from.before(d), node: $from.node(d) }
  return null
}
