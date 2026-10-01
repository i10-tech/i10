"use client"

import * as React from "react"
import type { Editor } from "@tiptap/core"
import { motion } from "motion/react"
import { Braces, ImageIcon, Link2, Puzzle, Type, Upload } from "lucide-react"
import {
  BULLET_LIST,
  BUTTON,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { cn } from "cn"
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
}: {
  editor: Editor
  variables: DeclaredVariable[]
  onUploadImage: () => void
  onOpenVariables: () => void
}) {
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
      <ToolMenu label="Text" icon={<Type />}>
        {(close) => (
          <ItemList items={TEXT_BLOCKS} onPick={(i) => (run(editor, i), close())} />
        )}
      </ToolMenu>
      <ToolMenu label="Image" icon={<ImageIcon />}>
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
      <ToolMenu label="Components" icon={<Puzzle />}>
        {(close) => (
          <ItemList
            items={COMPONENT_BLOCKS}
            onPick={(i) => (run(editor, i), close())}
          />
        )}
      </ToolMenu>
      <ToolMenu label="Variables" icon={<Braces />}>
        {(close) => (
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
                    onClick={() => {
                      editor.chain().focus().insertVariable(v.name).run()
                      close()
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-accent"
                  >
                    <span className="truncate">{`{{ ${v.name} }}`}</span>
                    <span className="shrink-0 font-sans text-[10px] text-muted-foreground">
                      {v.fallback !== null ? "has fallback" : "required"}
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
                  onOpenVariables()
                }}
                className="w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
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

function ToolMenu({
  label,
  icon,
  children,
}: {
  label: string
  icon: React.ReactNode
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              className={cn("size-9 rounded-xl", open && "bg-accent")}
            >
              {icon}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        className="w-auto p-1.5"
      >
        {/* Focus inside the menu still counts as the editor's. */}
        <EditorFocusScope>{children(() => setOpen(false))}</EditorFocusScope>
      </PopoverContent>
    </Popover>
  )
}

function ItemList({
  items,
  onPick,
}: {
  items: SlashCommandItem[]
  onPick: (item: SlashCommandItem) => void
}) {
  return (
    <div className="w-64">
      {items.map((item) => (
        <button
          key={item.title}
          type="button"
          onClick={() => onPick(item)}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
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
        <Inspector.Node />
        <Inspector.Text />
      </div>
    </Inspector.Root>
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
        <textarea
          value={css}
          onChange={(e) => setCss(e.target.value)}
          spellCheck={false}
          rows={6}
          placeholder={
            "/* Added to the email's <head> */\n@media (max-width: 600px) {\n  h1 { font-size: 24px; }\n}"
          }
          className="w-full resize-y rounded-xl border bg-foreground/[0.03] p-2.5 font-mono text-[11px] leading-relaxed outline-none transition-colors focus:border-foreground/30"
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
