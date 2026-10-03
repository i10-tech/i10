"use client"

import * as React from "react"
import type { Editor } from "@tiptap/core"
import { motion } from "motion/react"
import {
  ArrowDown,
  ArrowUp,
  Braces,
  GripVertical,
  ImageIcon,
  Link2,
  Plus,
  Puzzle,
  Trash2,
  Type,
  Upload,
} from "lucide-react"
import {
  NodeSelection,
  PluginKey,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state"
import { useCurrentEditor, useEditorState } from "@tiptap/react"
import {
  BULLET_LIST,
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BUTTON,
  BubbleMenu,
  CODE,
  DIVIDER,
  EditorFocusScope,
  FOUR_COLUMNS,
  H1,
  H2,
  H3,
  Inspector,
  NUMBERED_LIST,
  QUOTE,
  SECTION,
  TEXT,
  THREE_COLUMNS,
  TWO_COLUMNS,
  type SlashCommandItem,
} from "@react-email/editor/ui"
import {
  setCurrentTheme,
  setGlobalCssInjected,
  useEmailTheming,
} from "@react-email/editor/plugins"
import { Button } from "@repo/ui/components/button"
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover"
import { Textarea } from "@repo/ui/components/textarea"
import { cn } from "cn"
import {
  blockMoves,
  deleteBlock,
  endComponentDrag,
  MOVED_META,
  moveBlock,
  selectedTextRow,
  startComponentDrag,
  startVariableDrag,
} from "@/components/template-editor/block-drag"
import type { DeclaredVariable } from "@/lib/types"

export const TEXT_BLOCKS: SlashCommandItem[] = [
  TEXT,
  H1,
  H2,
  H3,
  BULLET_LIST,
  NUMBERED_LIST,
  QUOTE,
  CODE,
]
export const COMPONENT_BLOCKS: SlashCommandItem[] = [
  BUTTON,
  DIVIDER,
  SECTION,
  TWO_COLUMNS,
  THREE_COLUMNS,
  FOUR_COLUMNS,
]

/** Runs a slash-menu item at the cursor, as if `/` had been typed there. */
function run(editor: Editor, item: SlashCommandItem) {
  const at = editor.state.selection.from
  item.command({ editor, range: { from: at, to: at } })
  editor.commands.focus()
}

/**
 * The floating toolbar on the left of the canvas: Text, Image, Components,
 * Variables - Resend's four, each a short menu of what `/` also offers.
 */
export function BlockToolbar({
  editor,
  variables,
  onUploadImage,
  onOpenVariables,
  onCreateVariable,
}: {
  editor: Editor
  variables: DeclaredVariable[]
  onUploadImage: () => void
  onOpenVariables: () => void
  /** Create a variable and, once made, put it in at the caret. */
  onCreateVariable: () => void
}) {
  const menus = useHoverMenus()
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 32, delay: 0.1 }}
      className="flex flex-col items-center gap-1 rounded-2xl border bg-popover/95 p-1.5 shadow-lg backdrop-blur"
      role="toolbar"
      aria-label="Insert"
      aria-orientation="vertical"
    >
      <ToolMenu menus={menus} label="Text" icon={<Type />}>
        {(close, drag) => (
          <ItemList
            editor={editor}
            items={TEXT_BLOCKS}
            onPick={(i) => (run(editor, i), close())}
            onDrag={drag}
          />
        )}
      </ToolMenu>
      <ToolMenu menus={menus} label="Image" icon={<ImageIcon />}>
        {(close) => (
          <ImageMenu
            onUpload={() => {
              close()
              onUploadImage()
            }}
            onUrl={(src, alt) => {
              editor.chain().focus().setImage({ src, alt, alignment: "center" }).run()
              close()
            }}
          />
        )}
      </ToolMenu>
      <ToolMenu menus={menus} label="Components" icon={<Puzzle />}>
        {(close, drag) => (
          <ItemList
            editor={editor}
            items={COMPONENT_BLOCKS}
            onPick={(i) => (run(editor, i), close())}
            onDrag={drag}
          />
        )}
      </ToolMenu>
      <ToolMenu menus={menus} label="Variables" icon={<Braces />}>
        {(close, drag) => (
          <div className="w-60">
            <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
              Insert a variable
            </p>
            {variables.length === 0 ? (
              <p className="px-2 pb-2 text-xs text-muted-foreground">
                None declared yet.
              </p>
            ) : (
              <div className="max-h-60 overflow-y-auto">
                {variables.map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    draggable
                    onClick={() => {
                      editor.chain().focus().insertVariable(v.name).run()
                      close()
                    }}
                    onDragStart={(event) => {
                      startVariableDrag(editor, v.name, event)
                      drag(true)
                    }}
                    onDragEnd={() => {
                      endComponentDrag(editor)
                      drag(false)
                    }}
                    className="group/item flex w-full cursor-grab items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-accent active:cursor-grabbing"
                  >
                    <span className="truncate">{`{{{${v.name}}}}`}</span>
                    <span className="flex shrink-0 items-center gap-1.5 font-sans text-[10px] text-muted-foreground">
                      {v.fallback !== null ? "has fallback" : "required"}
                      <GripVertical
                        aria-hidden
                        className="size-3.5 opacity-0 transition-opacity group-hover/item:opacity-100"
                      />
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-1 border-t pt-1">
              <button
                type="button"
                onClick={() => {
                  close()
                  onCreateVariable()
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
              >
                <Plus className="size-3.5 text-muted-foreground" />
                Create variable
              </button>
              <button
                type="button"
                onClick={() => {
                  close()
                  onOpenVariables()
                }}
                className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Manage variables…
              </button>
            </div>
          </div>
        )}
      </ToolMenu>
    </motion.div>
  )
}

/**
 * Which toolbar menu is open, opened by hovering its button - Resend's way.
 *
 * ⚠ ONE STATE FOR ALL FOUR, so moving from one button to the next swaps the
 * menu at once instead of two overlapping while the first one's leave delay
 * runs out.
 *
 * ⚠ A MENU STAYS OPEN while an item is being dragged out of it (closing it
 * would cancel the drag) and while something in it has focus, like the image
 * URL field.
 */
function useHoverMenus() {
  const [open, setOpen] = React.useState<string | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragging = React.useRef(false)
  return React.useMemo(() => {
    const cancel = () => {
      if (timer.current) clearTimeout(timer.current)
    }
    return {
      open,
      setOpen: (label: string | null) => {
        cancel()
        setOpen(label)
      },
      enter: (label: string) => {
        cancel()
        setOpen(label)
      },
      leave: () => {
        cancel()
        timer.current = setTimeout(() => {
          if (dragging.current) return
          const menu = document.querySelector("[data-i10-tool-menu]")
          if (menu?.contains(document.activeElement)) return
          setOpen(null)
        }, 160)
      },
      dragStart: () => {
        dragging.current = true
      },
      dragEnd: () => {
        dragging.current = false
      },
    }
  }, [open])
}

function ToolMenu({
  menus,
  label,
  icon,
  children,
}: {
  menus: ReturnType<typeof useHoverMenus>
  label: string
  icon: React.ReactNode
  /** `drag` says an item is being dragged out of the menu, or no longer. */
  children: (close: () => void, drag: (dragging: boolean) => void) => React.ReactNode
}) {
  const open = menus.open === label
  const close = () => menus.setOpen(null)
  // ⚠ HIDDEN, NOT CLOSED, WHILE AN ITEM IS DRAGGED OUT: unmounting the
  // element a drag started from cancels the drag in Chrome.
  const [dragging, setDragging] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={(o) => menus.setOpen(o ? label : null)}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onPointerEnter={(e) => e.pointerType === "mouse" && menus.enter(label)}
          onPointerLeave={(e) => e.pointerType === "mouse" && menus.leave()}
          // ⚠ NO FOCUS ON PRESS: the editor keeps its caret visible, and an
          // item goes in where it blinks.
          onMouseDown={(e) => e.preventDefault()}
          className={cn("size-9 rounded-xl", open && "bg-accent")}
        >
          {icon}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        data-i10-tool-menu
        onPointerEnter={() => menus.enter(label)}
        onPointerLeave={() => menus.leave()}
        // Opening on hover must not pull focus out of the editor either.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className={cn(
          "w-auto p-1.5 transition-opacity",
          dragging && "pointer-events-none opacity-0",
        )}
      >
        {/* Focus inside the menu still counts as the editor's. */}
        <EditorFocusScope>
          {children(close, (d) => {
            if (d) {
              menus.dragStart()
              // ⚠ A TICK LATER: Chrome cancels a drag whose source changes
              // inside its own dragstart, which closed the menu at once.
              setTimeout(() => setDragging(true), 0)
              // The drop may land where the item's own dragend never fires.
              const done = () => {
                menus.dragEnd()
                setDragging(false)
                close()
                window.removeEventListener("drop", done, true)
                window.removeEventListener("dragend", done, true)
              }
              window.addEventListener("drop", done, true)
              window.addEventListener("dragend", done, true)
            } else {
              menus.dragEnd()
              setDragging(false)
              close()
            }
          })}
        </EditorFocusScope>
      </PopoverContent>
    </Popover>
  )
}

function ItemList({
  editor,
  items,
  onPick,
  onDrag,
}: {
  editor: Editor
  items: SlashCommandItem[]
  onPick: (item: SlashCommandItem) => void
  onDrag: (dragging: boolean) => void
}) {
  return (
    <div className="w-64">
      {items.map((item) => (
        <button
          key={item.title}
          type="button"
          draggable
          onClick={() => onPick(item)}
          onDragStart={(event) => {
            startComponentDrag(editor, item, event)
            onDrag(true)
          }}
          onDragEnd={() => {
            endComponentDrag(editor)
            onDrag(false)
          }}
          className="group/item flex w-full cursor-grab items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent active:cursor-grabbing"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background text-muted-foreground [&_svg]:size-4">
            {item.icon}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm">{item.title}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {item.description}
            </span>
          </span>
          <GripVertical
            aria-hidden
            className="ml-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/item:opacity-100"
          />
        </button>
      ))}
    </div>
  )
}

const HTTPS = /^https:\/\/[^\s]+$/i

function ImageMenu({
  onUpload,
  onUrl,
}: {
  onUpload: () => void
  onUrl: (src: string, alt: string) => void
}) {
  const [url, setUrl] = React.useState("")
  const [alt, setAlt] = React.useState("")
  const valid = HTTPS.test(url.trim())
  return (
    <div className="w-72 space-y-2 p-1">
      <button
        type="button"
        onClick={onUpload}
        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
      >
        <span className="grid size-8 place-items-center rounded-lg border bg-background text-muted-foreground">
          <Upload className="size-4" />
        </span>
        <span>
          <span className="block text-sm">Upload an image</span>
          <span className="block text-[11px] text-muted-foreground">
            PNG, JPEG, GIF or WebP, up to 5 MB
          </span>
        </span>
      </button>
      <form
        className="space-y-2 border-t px-1 pt-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onUrl(url.trim(), alt.trim())
        }}
      >
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Link2 className="size-3" /> Or by address
        </p>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className="h-8 w-full rounded-lg border bg-background px-2 text-xs outline-none focus:border-foreground/30"
          aria-label="Image address"
        />
        {url.trim() !== "" && !valid && (
          <p className="text-[11px] text-destructive">
            An https:// address, so it loads in every inbox.
          </p>
        )}
        <input
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          placeholder="Describe it (alt text)"
          className="h-8 w-full rounded-lg border bg-background px-2 text-xs outline-none focus:border-foreground/30"
          aria-label="Alt text"
        />
        <Button type="submit" size="xs" disabled={!valid} className="w-full">
          Insert image
        </Button>
      </form>
    </div>
  )
}

/**
 * The inspector: page style when nothing is selected, the block's own
 * settings when one is, text settings for a selection - React Email's
 * Inspector, with the email theme and global CSS added under page style.
 */
export function InspectorPanel({ editor }: { editor: Editor }) {
  return (
    <Inspector.Root className="i10-inspector flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <Inspector.Breadcrumb>
          {(segments) => (
            <ol className="flex flex-wrap items-center gap-1 pr-8 text-xs">
              {segments.length === 0 && (
                <li className="font-medium text-foreground">Page style</li>
              )}
              {segments.map((segment, i) => {
                const type = segment.node?.nodeType
                const label =
                  !type || type === "body" || type === "doc" ? "Page style" : type
                const last = i === segments.length - 1
                return (
                  <li key={i} className="flex items-center gap-1 capitalize">
                    {i > 0 && <span className="text-muted-foreground">/</span>}
                    {last ? (
                      <span className="font-medium text-foreground">{label}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => segment.focus()}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {label}
                      </button>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </Inspector.Breadcrumb>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <Inspector.Document />
        <Inspector.Document>
          {() => <ThemeSettings editor={editor} />}
        </Inspector.Document>
        <Inspector.Node>
          {(context) => <NodeSettings editor={editor} context={context} />}
        </Inspector.Node>
        <Inspector.Text>
          {(context) => <TextSettings editor={editor} context={context} />}
        </Inspector.Text>
      </div>
    </Inspector.Root>
  )
}

/**
 * Text settings: React Email's own sections, with Size and Line height
 * filled in when the block does not set them.
 *
 * ⚠ REACT EMAIL READS ONLY WHAT THE BLOCK SETS, plus the theme's colour,
 * weight and padding - never its font size or line height. Under the Basic
 * theme those come from the theme, so the two fields sat empty beside text
 * that plainly had a size. What the email actually renders is read from the
 * block instead; typing a value still sets it on the block, as before.
 */
function TextSettings({
  editor,
  context,
}: {
  editor: Editor
  context: Parameters<
    NonNullable<React.ComponentProps<typeof Inspector.Text>["children"]>
  >[0]
}) {
  const rendered = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { $from } = e.state.selection
      for (let d = $from.depth; d > 0; d--) {
        if (!$from.node(d).isTextblock) continue
        return renderedStyle(e.view.nodeDOM($from.before(d)))
      }
      return null
    },
  })
  const full = {
    ...context,
    getStyle: withRendered(
      context.getStyle as (prop: string) => string | number | undefined,
      rendered,
    ) as typeof context.getStyle,
  }
  return (
    <>
      <Inspector.Typography {...full} />
      {full.isLinkActive && <Inspector.Link {...full} />}
    </>
  )
}

/**
 * What a block actually renders with - for the fields React Email leaves
 * blank when the block itself sets nothing.
 */
function renderedStyle(node: Node | null): Rendered | null {
  if (!(node instanceof HTMLElement)) return null
  const dom = textHolder(node)
  const style = getComputedStyle(dom)
  const size = parseFloat(style.fontSize)
  const line = parseFloat(style.lineHeight)
  // The colour behind it: its own, or the first one painted under it.
  let backgroundColor: string | undefined
  for (let el: HTMLElement | null = dom; el; el = el.parentElement) {
    const hex = toHex(getComputedStyle(el).backgroundColor)
    if (hex) {
      backgroundColor = hex
      break
    }
    if (el.classList.contains("i10-canvas")) break
  }
  return {
    fontSize: Number.isFinite(size) ? Math.round(size) : undefined,
    // "normal" has no number; the field is a percentage of the size.
    lineHeight:
      Number.isFinite(line) && size > 0 ? Math.round((line / size) * 100) : undefined,
    backgroundColor,
  }
}

/**
 * The element a block's text is set in.
 *
 * ⚠ NOT THE BLOCK'S OUTER ELEMENT. A heading is drawn through a wrapper that
 * keeps the default 16px; its 36px is on the h1 inside, so the outer element
 * reported 16 for every heading. The text's own parent is what renders it.
 */
function textHolder(dom: HTMLElement): HTMLElement {
  const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement
    // A variable chip is drawn smaller than the text around it: not it.
    if (n.textContent?.trim() && parent && !parent.closest('[contenteditable="false"]'))
      return parent
  }
  // Empty: the innermost text-level element there is.
  return (
    dom.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6, p, a, li, blockquote") ??
    dom
  )
}

type Rendered = {
  fontSize: number | undefined
  lineHeight: number | undefined
  backgroundColor: string | undefined
}

/** `rgb(255, 255, 255)` as `#ffffff`; nothing for a see-through colour. */
function toHex(color: string): string | undefined {
  const m = color.match(
    /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/,
  )
  if (!m) return undefined
  if (m[4] !== undefined && Number(m[4]) === 0) return undefined
  return `#${[m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, "0")).join("")}`
}

/** A blank value is one the block does not set. */
function withRendered(
  own: (prop: string) => string | number | undefined,
  rendered: Rendered | null,
) {
  return (prop: string) => {
    const value = own(prop)
    if (value !== undefined && value !== "") return value
    if (prop === "fontSize") return rendered?.fontSize
    if (prop === "lineHeight") return rendered?.lineHeight
    if (prop === "backgroundColor") return rendered?.backgroundColor
    return value
  }
}

/** React Email's sections per block - its own layout, which it does not export. */
function layoutOf(nodeType: string): string[] {
  switch (nodeType) {
    case "image":
      return ["attributes", "size", "padding", "border"]
    case "button":
      return ["typography", "size", "padding", "border", "background"]
    case "section":
    case "div":
      return ["background", "padding", "border"]
    case "codeBlock":
      return ["attributes", "padding", "border"]
    case "footer":
      return ["typography", "padding", "background"]
    case "twoColumns":
    case "threeColumns":
    case "fourColumns":
      return ["columnSpacing", "typography", "padding", "background", "border"]
    default:
      return ["typography", "padding", "background", "border"]
  }
}

/**
 * A block's settings: React Email's sections in its order, with Size, Line
 * height and Background showing what the block renders when it sets none -
 * see `TextSettings`. A background is the colour behind the block: its own,
 * or the container's it shows through.
 */
function NodeSettings({
  editor,
  context,
}: {
  editor: Editor
  context: Parameters<
    NonNullable<React.ComponentProps<typeof Inspector.Node>["children"]>
  >[0]
}) {
  const rendered = useEditorState({
    editor,
    selector: ({ editor: e }) => renderedStyle(e.view.nodeDOM(context.nodePos.pos)),
  })
  const full = {
    ...context,
    getStyle: withRendered(
      context.getStyle as (prop: string) => string | number | undefined,
      rendered,
    ) as typeof context.getStyle,
  }
  return (
    <>
      {layoutOf(context.nodeType).map((section) => {
        switch (section) {
          case "attributes":
            return <Inspector.Attributes key={section} {...full} />
          case "size":
            return <Inspector.Size key={section} {...full} />
          case "typography":
            return <Inspector.Typography key={section} {...full} />
          case "padding":
            return <Inspector.Padding key={section} {...full} />
          case "columnSpacing":
            return <Inspector.ColumnSpacing key={section} {...full} />
          case "background":
            return <Inspector.Background key={section} {...full} />
          case "border":
            return <Inspector.Border key={section} {...full} />
          default:
            return null
        }
      })}
    </>
  )
}

/** The email theme and global CSS, under page style. */
function ThemeSettings({ editor }: { editor: Editor }) {
  const theming = useEmailTheming(editor)
  const [css, setCss] = React.useState(theming?.css ?? "")
  const applied = React.useRef(theming?.css ?? "")
  React.useEffect(() => {
    if (css === applied.current) return
    const timer = setTimeout(() => {
      applied.current = css
      setGlobalCssInjected(editor, css)
    }, 400)
    return () => clearTimeout(timer)
  }, [css, editor])

  const theme = theming?.theme ?? "basic"
  return (
    <div className="space-y-5 border-t pt-4">
      <div className="space-y-2">
        <p className="text-xs font-medium">Theme</p>
        <div
          className="grid grid-cols-2 gap-1 rounded-xl bg-foreground/[0.04] p-1"
          role="radiogroup"
          aria-label="Email theme"
        >
          {(["basic", "minimal"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={theme === t}
              onClick={() => setCurrentTheme(editor, t)}
              className={cn(
                "relative rounded-lg px-2 py-1.5 text-xs capitalize transition-colors",
                theme === t
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {theme === t && (
                <motion.span
                  layoutId="i10-theme-pill"
                  className="absolute inset-0 rounded-lg bg-background shadow-sm"
                  transition={{ type: "spring", stiffness: 500, damping: 36 }}
                />
              )}
              <span className="relative">{t}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Basic styles every block; minimal leaves a blank slate for your own.
        </p>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">Global CSS</p>
        <Textarea
          value={css}
          onChange={(e) => setCss(e.target.value)}
          spellCheck={false}
          placeholder={
            "/* Added to the email's <head> */\n@media (max-width: 600px) {\n  h1 { font-size: 24px; }\n}"
          }
          className="min-h-28 p-2.5 font-mono text-[11px] leading-relaxed md:text-[11px]"
          aria-label="Global CSS"
        />
        <p className="text-[11px] text-muted-foreground">
          For media queries and dark-mode rules. Many inboxes ignore &lt;style&gt;, so
          block styles stay inline.
        </p>
      </div>
    </div>
  )
}

/**
 * The menu over selected text: React Email's own, plus a group that acts on
 * the whole block the text is in - move it up, move it down, delete it.
 *
 * ⚠ THE DEFAULT, REBUILT FROM ITS PARTS. React Email's menu takes no extra
 * items; passing children swaps it for exactly these, so its four groups are
 * listed here in its order and stay as they were.
 */
const TEXT_MENU = new PluginKey("i10TextBubbleMenu")

/**
 * What the text menu sits under when a line is selected whole: the fitted
 * ring around its text, not the line's full-width box.
 *
 * ⚠ SO IT GLIDES WITH AN ALIGNMENT CHANGE. Anchored to the box - which does
 * not move when the text inside it does - the menu stayed centred while the
 * text went right; anchored to the ring, it follows the text there, as it
 * does for a hand-made selection. Nothing for a text selection: TipTap's own
 * anchor (the selected text) is already right.
 */
function anchorToRing() {
  const ring = document.querySelector<HTMLElement>("[data-i10-selection-ring]")
  if (!ring || ring.style.display !== "block") return null
  return {
    getBoundingClientRect: () => ring.getBoundingClientRect(),
    getClientRects: () => [ring.getBoundingClientRect()],
  }
}

/** Where the text menu never shows: these have menus of their own. */
const OWN_MENUS = new Set(["button", "image", "horizontalRule", "variable"])

/**
 * When the text menu shows: a text line selected whole (empty or not), or a
 * text selection that is not inside a button, image, divider or link.
 *
 * ⚠ OURS, NOT REACT EMAIL'S. Its rule asked whether a variable was "active",
 * which a line selected whole with a chip in it answered yes - so the menu
 * hid after the first edit made from it.
 */
function showTextMenu({
  editor,
  state,
}: {
  editor: Editor
  state: EditorState
}): boolean {
  const { selection } = state
  if (selection instanceof NodeSelection) return selection.node.isTextblock
  if (selection.empty) return false
  const { $from } = selection
  for (let d = $from.depth; d > 0; d--)
    if (OWN_MENUS.has($from.node(d).type.name)) return false
  if (editor.isActive("link")) return false
  // Only a chip selected, nothing else: the chip is not text to format.
  const content = selection.content().content
  if (content.childCount === 1 && content.firstChild?.type.name === "variable")
    return false
  return true
}

export function TextBubbleMenu() {
  const { editor } = useCurrentEditor()
  const [nodeOpen, setNodeOpen] = React.useState(false)
  const [linkOpen, setLinkOpen] = React.useState(false)
  const code = useEditorState({
    editor,
    selector: ({ editor: e }) => e?.isActive("code") ?? false,
  })
  const moves = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? blockMoves(e) : { up: false, down: false }),
  })
  const element = React.useRef<HTMLDivElement | null>(null)

  // ⚠ ALIGNMENT IS THE SELECTED LINE'S, HOWEVER IT IS SELECTED. React Email's
  // buttons read the alignment from a text selection; a line selected whole
  // - an empty one, picked by its grip - has none inside it, so they always
  // said "left". This reads and sets the line's own `alignment`.
  const alignment = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const row = e ? selectedTextRow(e.state) : null
      return String(row?.node.attrs.alignment ?? "left")
    },
  })
  const align = (value: "left" | "center" | "right") => {
    if (!editor) return
    const row = selectedTextRow(editor.state)
    if (!row) return
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setNodeMarkup(row.pos, undefined, { ...row.node.attrs, alignment: value })
        // A line selected whole stays selected whole.
        if (editor.state.selection instanceof NodeSelection)
          tr.setSelection(NodeSelection.create(tr.doc, row.pos))
        return true
      })
      .run()
  }

  // ⚠ IT STAYS UP THROUGH ITS OWN EDITS. After a change - an alignment, a
  // move - with text still selected and the editor still focused, it is told
  // to show and re-measure, so an edit made from the menu never leaves the
  // menu gone.
  React.useEffect(() => {
    if (!editor) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // React Email takes no ref, so the element is found while it is shown;
    // hidden, it is out of the document.
    const find = () => {
      element.current ??= document.querySelector<HTMLDivElement>("[data-i10-text-menu]")
      // It appears 250ms after the selection does.
      if (!element.current)
        setTimeout(() => {
          element.current ??=
            document.querySelector<HTMLDivElement>("[data-i10-text-menu]")
        }, 320)
    }
    // ⚠ THE GLIDE STARTS WITH THE EDIT, NOT AFTER IT. TipTap re-measures the
    // menu 250ms after a change, so the text snapped to its new alignment,
    // the menu sat still for a quarter second, then glided after it. Asked to
    // re-measure at once, it moves together with the text. A block move
    // carries the menu itself (`carryTextMenu`), so it is left out here.
    const follow = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.getMeta(MOVED_META)) return
      const menu = element.current
      if (!menu?.isConnected || menu.style.visibility === "hidden") return
      queueMicrotask(() => {
        if (editor.isDestroyed) return
        editor.view.dispatch(editor.state.tr.setMeta(TEXT_MENU, "updatePosition"))
      })
    }
    const keep = () => {
      find()
      clearTimeout(timer)
      // After TipTap's own 250ms debounce has had its say.
      timer = setTimeout(() => {
        if (editor.isDestroyed || !editor.view.hasFocus()) return
        if (editor.state.selection.empty) return
        editor.view.dispatch(editor.state.tr.setMeta(TEXT_MENU, "show"))
      }, 300)
    }
    editor.on("update", keep)
    editor.on("update", follow)
    editor.on("selectionUpdate", find)
    return () => {
      clearTimeout(timer)
      editor.off("update", keep)
      editor.off("update", follow)
      editor.off("selectionUpdate", find)
    }
  }, [editor])

  if (!editor) return null
  return (
    <BubbleMenu
      data-i10-text-menu=""
      pluginKey={TEXT_MENU}
      trigger={showTextMenu}
      // React Email passes unlisted props on to TipTap's menu, which takes
      // this one; its own types just do not name it.
      {...({ getReferencedVirtualElement: anchorToRing } as object)}
      onHide={() => {
        setNodeOpen(false)
        setLinkOpen(false)
        // Forget where it was, so it appears in place next time instead of
        // gliding over from here (see editor.css).
        element.current?.style.removeProperty("left")
        element.current?.style.removeProperty("top")
      }}
    >
      <BubbleMenu.NodeSelector
        open={nodeOpen}
        onOpenChange={(open) => {
          setNodeOpen(open)
          if (open) setLinkOpen(false)
        }}
      />
      {code ? (
        <BubbleMenu.Code />
      ) : (
        <>
          <BubbleMenu.LinkSelector
            open={linkOpen}
            onOpenChange={(open) => {
              setLinkOpen(open)
              if (open) setNodeOpen(false)
            }}
          />
          <BubbleMenu.ItemGroup>
            <BubbleMenu.Bold />
            <BubbleMenu.Italic />
            <BubbleMenu.Underline />
            <BubbleMenu.Strike />
            <BubbleMenu.Code />
            <BubbleMenu.Uppercase />
          </BubbleMenu.ItemGroup>
          <BubbleMenu.ItemGroup>
            {(
              [
                ["left", <AlignLeftIcon key="l" />],
                ["center", <AlignCenterIcon key="c" />],
                ["right", <AlignRightIcon key="r" />],
              ] as const
            ).map(([value, icon]) => (
              <BubbleMenu.Item
                key={value}
                name={`align-${value}`}
                isActive={alignment === value}
                onCommand={() => align(value)}
              >
                {icon}
              </BubbleMenu.Item>
            ))}
          </BubbleMenu.ItemGroup>
        </>
      )}
      <BubbleMenu.ItemGroup>
        <BubbleMenu.Item
          name="move-up"
          isActive={false}
          disabled={!moves?.up}
          title="Move up"
          onCommand={() => moveBlock(editor, -1)}
        >
          <ArrowUp className="size-4" />
        </BubbleMenu.Item>
        <BubbleMenu.Item
          name="move-down"
          isActive={false}
          disabled={!moves?.down}
          title="Move down"
          onCommand={() => moveBlock(editor, 1)}
        >
          <ArrowDown className="size-4" />
        </BubbleMenu.Item>
        <BubbleMenu.Item
          name="delete"
          isActive={false}
          title="Delete"
          onCommand={() => deleteBlock(editor)}
        >
          <Trash2 className="size-4" />
        </BubbleMenu.Item>
      </BubbleMenu.ItemGroup>
    </BubbleMenu>
  )
}
