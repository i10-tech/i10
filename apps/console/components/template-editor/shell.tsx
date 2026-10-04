"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import type { Editor, Extensions } from "@tiptap/core"
import { EditorContent, EditorContext, useEditor } from "@tiptap/react"
import { generateJSON } from "@tiptap/html"
import { Placeholder } from "@tiptap/extension-placeholder"
import { composeReactEmail, isDocumentVisuallyEmpty } from "@react-email/editor/core"
import { StarterKit } from "@react-email/editor/extensions"
import {
  EmailTheming,
  imageSlashCommand,
  useEditorImage,
} from "@react-email/editor/plugins"
import {
  BubbleMenu,
  SlashCommand,
  defaultSlashCommands,
  type SlashCommandItem,
} from "@react-email/editor/ui"
import "@react-email/editor/themes/default.css"
import "./editor.css"
import {
  AlertCircle,
  Braces,
  Check,
  ChevronRight,
  Code2,
  Copy,
  FileCode2,
  History,
  Home,
  Info,
  LayoutTemplate,
  Loader2,
  MoreHorizontal,
  PanelRightClose,
  Pin,
  PenLine,
  Save,
  Send,
  Trash2,
  Upload,
} from "lucide-react"
import { ActionButton } from "@repo/ui/components/action-button"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { Kbd } from "@repo/ui/components/kbd"
import { Switch } from "@repo/ui/components/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover"
import { Swap } from "@repo/ui/components/swap"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { cn } from "cn"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmailFrame } from "@/components/email-frame"
import { CodeEditor } from "@/components/template-editor/code-editor"
import { FolderGlyph } from "@/components/templates/folder-art"
import { LeaveDialog } from "@/components/template-editor/leave-dialog"
import {
  EnvelopeFields,
  fromProblem,
  replyToList,
  replyToProblem,
  type Envelope,
} from "@/components/template-editor/fields"
import { STARTERS, type Starter } from "@/components/template-editor/starters"
import {
  BlockHandle,
  RingedSelection,
  SelectionRing,
  dropComponent,
  dropVariable,
  setContentDragImage,
} from "@/components/template-editor/block-drag"
import {
  BlockToolbar,
  InspectorPanel,
  TextBubbleMenu,
} from "@/components/template-editor/surface"
import { TestEmailDialog } from "@/components/template-editor/test-email"
import { Variable } from "@/components/template-editor/variable-node"
import {
  MAX_VARIABLES,
  VariableDialog,
  VariablesPanel,
} from "@/components/template-editor/variables"
import { VersionsPanel } from "@/components/template-editor/versions"
import { TemplateDetailsDialog } from "@/components/templates/details-dialog"
import {
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  publishTemplate,
  updateTemplate,
  uploadTemplateImage,
} from "@/lib/actions"
import { htmlToText } from "@/lib/html-text"
import { useOutcome } from "@/lib/outcome"
import { STATUS_LABEL, titleOf, type TemplateStatus } from "@/lib/templates"
import { toastDone, toastError, toastFailure } from "@/lib/toast"
import type { DeclaredVariable, TemplateDetail, TemplateFolder } from "@/lib/types"

type View = "write" | "code"
type Panel = "inspector" | "variables" | "versions" | null

/** Where "the inspector is pinned" is remembered, per device. */
const PINNED_KEY = "i10.template-editor.inspector-pinned"

/**
 * Whether edits save themselves, per device. On by default - it is how the
 * editor has always behaved - and off means nothing is saved until ⌘S.
 */
const AUTOSAVE_KEY = "i10.template-editor.autosave"
const autosaveListeners = new Set<() => void>()
function subscribeAutosave(notify: () => void) {
  autosaveListeners.add(notify)
  return () => autosaveListeners.delete(notify)
}
function readAutosave(): boolean {
  try {
    return localStorage.getItem(AUTOSAVE_KEY) !== "0"
  } catch {
    return true
  }
}
function writeAutosave(on: boolean) {
  try {
    localStorage.setItem(AUTOSAVE_KEY, on ? "1" : "0")
  } catch {
    // Remembering is a convenience.
  }
  for (const notify of autosaveListeners) notify()
}
const pinnedListeners = new Set<() => void>()
function subscribePinned(notify: () => void) {
  pinnedListeners.add(notify)
  return () => pinnedListeners.delete(notify)
}
type SaveState = "saved" | "dirty" | "saving" | "error"

const SPRING = { type: "spring", stiffness: 380, damping: 38, mass: 0.9 } as const
const AUTOSAVE_MS = 800

/**
 * The template editor, Resend's way (#162): a page of its own, outside the
 * console's sidebar, with a rail on the left (home, writing, code), the email
 * in the middle and its inspector on the right.
 *
 * ⚠ THE DRAFT SAVES ITSELF; ONLY PUBLISH CHANGES WHAT IS SENT. Every pause in
 * typing saves the draft, quietly. What a send uses is a version, and the
 * only button that makes one is Publish.
 *
 * ⚠ ONE TEMPLATE, TWO WAYS TO WRITE IT. Writing is the React Email editor;
 * Code is its HTML. Opening Code shows the HTML the editor makes; changing
 * it makes the template an HTML one, and going back to Writing rebuilds the
 * blocks from that HTML - after saying that layout the editor cannot express
 * will be simplified, because that is a real loss and not a surprise.
 */
export function TemplateEditorApp({
  template: initial,
  folders,
  verified,
  userEmail,
  imagesFrom,
}: {
  template: TemplateDetail
  folders: TemplateFolder[]
  /** Verified domain names, lower-case. */
  verified: string[]
  userEmail: string | null
  imagesFrom: string | null
}) {
  const router = useRouter()
  const [tpl, setTpl] = React.useState(initial)
  const [title, setTitle] = React.useState(titleOf(initial))
  const [env, setEnv] = React.useState<Envelope>({
    from: initial.from ?? "",
    replyTo: (initial.reply_to ?? []).join(", "),
    subject: initial.subject ?? "",
    previewText: initial.preview_text ?? "",
  })
  const [variables, setVariables] = React.useState<DeclaredVariable[]>(
    initial.variables ?? [],
  )
  const [kind, setKind] = React.useState<"visual" | "html">(
    initial.kind === "html" ? "html" : "visual",
  )
  const [codeHtml, setCodeHtml] = React.useState(
    initial.kind === "html" ? (initial.html ?? "") : "",
  )
  const [view, setView] = React.useState<View>(
    initial.kind === "html" ? "code" : "write",
  )
  const [panel, setPanel] = React.useState<Panel>("inspector")
  // ⚠ THE INSPECTOR IS PINNED OR HIDDEN, Resend's way. Pinned, it sits beside
  // the email; hidden, a tab on the right edge brings it in over the email
  // while the pointer is on it. The choice is remembered on this device.
  const pinned = React.useSyncExternalStore(
    subscribePinned,
    () => {
      try {
        return localStorage.getItem(PINNED_KEY) !== "0"
      } catch {
        return true
      }
    },
    () => true,
  )
  const [peek, setPeek] = React.useState(false)
  const setPinned = React.useCallback((next: boolean) => {
    setPeek(false)
    try {
      localStorage.setItem(PINNED_KEY, next ? "1" : "0")
    } catch {
      // Remembering is a convenience.
    }
    for (const notify of pinnedListeners) notify()
  }, [])
  // ⚠ IN AT ONCE, OUT AFTER A BEAT, and never while something in it has
  // focus - leaving a colour field mid-edit must not snatch it away.
  const hovering = React.useRef(false)
  const leaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const peekIn = React.useCallback(() => {
    hovering.current = true
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    setPeek(true)
  }, [])
  const peekOut = React.useCallback(() => {
    hovering.current = false
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => {
      const focus = document.activeElement
      if (focus && document.querySelector("[data-i10-inspector]")?.contains(focus))
        return
      setPeek(false)
    }, 220)
  }, [])
  // ⚠ WATCHED FROM THE DOCUMENT WHILE IT IS IN: the panel slides in under a
  // pointer that never "entered" it, so its own leave event may never come.
  React.useEffect(() => {
    if (!peek) return
    function onMove(event: PointerEvent) {
      const target = event.target as Element | null
      const inside = target?.closest(
        "[data-i10-inspector-shell], [data-radix-popper-content-wrapper]",
      )
      if (inside) {
        if (!hovering.current) peekIn()
      } else if (hovering.current) peekOut()
    }
    document.addEventListener("pointermove", onMove)
    return () => document.removeEventListener("pointermove", onMove)
  }, [peek, peekIn, peekOut])
  const [save, setSave] = React.useState<SaveState>("saved")
  const [empty, setEmpty] = React.useState(true)
  const [dialog, setDialog] = React.useState<
    | null
    | "test"
    | "details"
    | "delete"
    | "to-visual"
    | { variable: DeclaredVariable | null; insert: boolean }
    | { importHtml: string; name: string }
  >(null)
  const publishing = useOutcome()
  // ⚠ THE EMAIL IS 600PX WIDE AND DOES NOT SHRINK. When the canvas cannot
  // hold it beside the inspector, the inspector opens over it on request
  // instead of pushing it under; it starts closed so the email shows whole.
  const canvas = React.useRef<HTMLDivElement>(null)
  const writing = React.useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = React.useState(false)
  React.useEffect(() => {
    const el = canvas.current
    if (!el) return
    let was = false
    const watch = new ResizeObserver(([entry]) => {
      const tight = (entry?.contentRect.width ?? 0) < 600 + 344 + 96 + 48
      setNarrow(tight)
      // Becoming narrow hides the inspector behind its tab, for now: it is
      // not unpinned for good, and comes back when there is room.
      if (tight !== was) setPeek(false)
      was = tight
    })
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  const folder = folders.find((f) => f.id === tpl.folder_id) ?? null
  const backHref = folder
    ? `/templates/folder/${encodeURIComponent(folder.id)}`
    : "/templates"

  // ── The editor ──────────────────────────────────────────────────────────
  const imageExtension = useEditorImage({
    uploadImage: async (file) => {
      const form = new FormData()
      form.append("file", file)
      const result = await uploadTemplateImage(form)
      if (!result.ok) {
        // ⚠ THROWN AFTER SAYING WHY: the editor removes its placeholder.
        toastFailure(result)
        throw new Error(result.error)
      }
      return { url: result.data.url }
    },
  })
  const extensions = React.useMemo<Extensions>(
    () => [
      StarterKit.configure(),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "heading"
            ? `Heading ${String(node.attrs.level)}`
            : "Press '/' for commands",
        includeChildren: true,
      }),
      // ⚠ NO `theme` OPTION. React Email reads a configured theme BEFORE the
      // document's own, so pinning "basic" here made the Basic / Minimal
      // switch write a theme nothing ever read. Unset, a new email is basic.
      EmailTheming,
      imageExtension,
      Variable,
      RingedSelection,
    ],
    [imageExtension],
  )

  const quiet = React.useRef(false)
  const touched = React.useRef(false)
  /** The draft as last saved (or as opened), for "is this a change?". */
  const baseline = React.useRef<string | null>(null)
  /** Take a new baseline after the next render: the content was replaced. */
  const rebase = React.useRef(false)
  const editor = useEditor(
    {
      extensions,
      content: initial.design ?? undefined,
      immediatelyRender: false,
      editorProps: {
        handlePaste: (view, event, slice) =>
          pasteHandler(extensions)(view, event, slice),
        handleDrop: (view, event) =>
          dropComponent(view, event) || dropVariable(view, event),
        handleDOMEvents: {
          // Text dragged inside the email travels on our card, not as the
          // browser's ghost; ProseMirror still runs the drag itself.
          dragstart: (view, event) => {
            const { selection } = view.state
            if (
              event.dataTransfer &&
              !selection.empty &&
              view.dom.contains(event.target as Node)
            )
              setContentDragImage(
                event.dataTransfer,
                view,
                view.state.doc.textBetween(selection.from, selection.to, " "),
              )
            return false
          },
        },
        attributes: { "aria-label": "Email body" },
      },
      onCreate: ({ editor }) => setEmpty(isDocumentVisuallyEmpty(editor.state.doc)),
      onUpdate: ({ editor }) => {
        setEmpty(isDocumentVisuallyEmpty(editor.state.doc))
        if (!quiet.current && touched.current) {
          markDirty()
          reconcile()
        }
      },
    },
    [],
  )
  // ⚠ NOTHING IS AN EDIT UNTIL SOMEONE HAS DONE SOMETHING. Opening a template
  // let the editor tidy the loaded document (its trailing line and the like),
  // and that counted as a change: every open saved for nothing, and with
  // auto-save off it opened on "Unsaved changes" and asked before leaving.
  // Until the first key or click, a change can only be that tidying.
  React.useEffect(() => {
    const touch = () => {
      touched.current = true
      // What "unchanged" means: the draft as it stands before the first edit,
      // after the editor's tidying.
      baseline.current = keyOf(latest.current)
      window.removeEventListener("pointerdown", touch, true)
      window.removeEventListener("keydown", touch, true)
    }
    window.addEventListener("pointerdown", touch, true)
    window.addEventListener("keydown", touch, true)
    return () => {
      window.removeEventListener("pointerdown", touch, true)
      window.removeEventListener("keydown", touch, true)
    }
  }, [])

  // ── Saving ──────────────────────────────────────────────────────────────
  const latest = React.useRef({ env, variables, kind, codeHtml, title, editor })
  latest.current = { env, variables, kind, codeHtml, title, editor }
  const dirty = React.useRef(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflight = React.useRef<Promise<boolean> | null>(null)

  const flush = React.useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current)
    while (inflight.current) await inflight.current
    if (!dirty.current) return true
    dirty.current = false
    setSave("saving")
    const work = (async () => {
      const l = latest.current
      const savedKey = keyOf(l)
      const patch: Record<string, unknown> = {
        title: l.title.trim() || null,
        subject: l.env.subject.trim() === "" ? null : l.env.subject,
        preview_text: l.env.previewText.trim() === "" ? null : l.env.previewText,
        variables: l.variables,
        kind: l.kind,
      }
      // ⚠ A FIELD THAT IS WRONG IS LEFT OUT, NOT SENT TO BE REFUSED. One bad
      // sender must not stop the body from saving; the field says what is
      // wrong, and the API keeps its last good value.
      if (fromProblem(l.env.from, verified) === null)
        patch.from = l.env.from.trim() || null
      if (replyToProblem(l.env.replyTo) === null)
        patch.reply_to = replyToList(l.env.replyTo)
      if (l.kind === "visual" && l.editor) {
        // ⚠ THE UNFORMATTED HTML IS WHAT IS SENT: the pretty one is up to ten
        // times larger on table layouts, and inboxes gain nothing from it.
        const { unformattedHtml: html, text } = await composeReactEmail({
          editor: l.editor,
        })
        const isEmpty = isDocumentVisuallyEmpty(l.editor.state.doc)
        // ⚠ A PLAIN JSON COPY. TipTap's attribute objects are not plain, and
        // a server action would turn them into temporary references.
        patch.design = JSON.parse(JSON.stringify(l.editor.getJSON())) as Record<
          string,
          unknown
        >
        patch.html = isEmpty ? null : html
        patch.text = isEmpty ? null : text
      } else if (l.kind === "html") {
        patch.html = l.codeHtml.trim() === "" ? null : l.codeHtml
        patch.text = l.codeHtml.trim() === "" ? null : htmlToText(l.codeHtml)
      }
      const result = await updateTemplate(tpl.id, patch, { quiet: true })
      if (!result.ok) {
        dirty.current = true
        setSave("error")
        toastFailure(result)
        return false
      }
      // ⚠ THE FIRST SAVE OF THE SHARED TEMPLATE COMES BACK UNDER A NEW ID: the
      // workspace's own copy. The address follows without a navigation, so
      // a reload opens the copy and nothing on screen is reset.
      if (result.data.id !== tpl.id) {
        window.history.replaceState(
          null,
          "",
          `/templates/${encodeURIComponent(result.data.id)}/editor`,
        )
      }
      setTpl((t) => ({ ...t, ...result.data, history: t.history }))
      if (baseline.current !== null || touched.current) baseline.current = savedKey
      setSave(dirty.current ? "dirty" : "saved")
      return true
    })()
    inflight.current = work
    const ok = await work
    inflight.current = null
    if (dirty.current && autosaveRef.current) schedule()
    return ok
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl.id, verified])

  const schedule = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS)
  }, [flush])

  const autosave = React.useSyncExternalStore(
    subscribeAutosave,
    readAutosave,
    () => true,
  )
  const autosaveRef = React.useRef(autosave)
  React.useEffect(() => {
    autosaveRef.current = autosave
  }, [autosave])

  const markDirty = React.useCallback(() => {
    dirty.current = true
    setSave((s) => (s === "saving" ? s : "dirty"))
    if (autosaveRef.current) schedule()
  }, [schedule])

  // ⚠ BACK TO WHAT WAS SAVED IS NOT A CHANGE. Typing a letter and deleting it
  // again leaves the draft exactly as saved, so it says so - and auto-save
  // skips a save that would write the same thing back.
  const reconcile = React.useCallback(() => {
    if (baseline.current === null || !dirty.current || inflight.current) return
    if (keyOf(latest.current) !== baseline.current) return
    dirty.current = false
    if (timer.current) clearTimeout(timer.current)
    setSave((s) => (s === "saving" ? s : "saved"))
  }, [])
  // The envelope, title and variables arrive through state: compare once
  // they have rendered.
  React.useEffect(() => {
    if (rebase.current) {
      rebase.current = false
      baseline.current = keyOf(latest.current)
      return
    }
    reconcile()
  }, [env, variables, kind, codeHtml, title, reconcile])

  // Leaving with something unsaved asks first.
  React.useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (dirty.current || inflight.current) event.preventDefault()
    }
    window.addEventListener("beforeunload", onLeave)
    return () => window.removeEventListener("beforeunload", onLeave)
  }, [])

  const edit = <K extends keyof Envelope>(
    patch: Pick<Envelope, K> | Partial<Envelope>,
  ) => {
    setEnv((e) => ({ ...e, ...patch }))
    markDirty()
  }

  // ── Where the template stands ──────────────────────────────────────────
  const hasContent = kind === "visual" ? !empty : codeHtml.trim() !== ""
  const unsaved = save !== "saved"
  const status: TemplateStatus =
    tpl.published_at === null
      ? "draft"
      : unsaved || tpl.updated_at > tpl.published_at
        ? "changes"
        : "published"
  const fromError = fromProblem(env.from, verified)
  const canPublish = hasContent && status !== "published" && publishing.state === "idle"

  async function publish() {
    if (publishing.state !== "idle") return
    if (fromError) {
      toastError("Fix the sender first", { description: fromError })
      return
    }
    await publishing.run(async () => {
      if (!(await flush())) return false
      const result = await publishTemplate(tpl.id)
      if (!result.ok) {
        toastFailure(result)
        return false
      }
      await refreshTemplate()
      return true
    }, publishing.reset)
  }

  async function refreshTemplate() {
    const fresh = await getTemplate(tpl.id)
    if (fresh.ok) setTpl(fresh.data)
  }

  // ── Switching views ────────────────────────────────────────────────────
  async function openCode() {
    if (view === "code") return
    if (kind === "visual" && editor) {
      const { html } = await composeReactEmail({ editor })
      setCodeHtml(isDocumentVisuallyEmpty(editor.state.doc) ? "" : html)
    }
    setView("code")
  }
  function openWrite() {
    if (view === "write") return
    if (kind === "html" && codeHtml.trim() !== "") return setDialog("to-visual")
    if (kind === "html") setKind("visual")
    setView("write")
  }
  function convertToVisual() {
    if (!editor) return
    setContent(editor, codeHtml, extensions, "import")
    setKind("visual")
    setView("write")
    markDirty()
  }

  // ── Keyboard ───────────────────────────────────────────────────────────
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault()
        dirty.current = true
        void flush().then((ok) => ok && toastDone("Draft saved"))
      } else if (mod && event.key === "Enter" && canPublish) {
        event.preventDefault()
        void publish()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  // ── Variables ──────────────────────────────────────────────────────────
  const used = React.useMemo(
    () => usedVariables(editor, env, kind, codeHtml),
    // `save` stands in for every edit inside the editor, which is not React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, env, kind, codeHtml, save],
  )
  function insertVariable(name: string) {
    if (view === "write" && editor) editor.chain().focus().insertVariable(name).run()
    else setCodeHtml((h) => `${h}{{{ ${name} }}}`)
    markDirty()
  }
  const variableItems = React.useMemo<SlashCommandItem[]>(
    () =>
      variables.map((v) => ({
        title: `{{{ ${v.name} }}}`,
        description:
          v.fallback !== null ? `Falls back to “${v.fallback}”` : "Required at send",
        icon: <Braces className="size-4" />,
        category: "Variables",
        searchTerms: [v.name, "variable"],
        command: ({ editor, range }) =>
          editor.chain().focus().deleteRange(range).insertVariable(v.name).run(),
      })),
    [variables],
  )

  // ── Leaving ────────────────────────────────────────────────────────────
  // ⚠ WITH AUTO-SAVE ON, LEAVING SAVES AND GOES, as it always has; off, an
  // unsaved change asks first (see LeaveDialog).
  const [leaving, setLeaving] = React.useState<string | null>(null)
  async function leave(href: string) {
    if (!autosave && dirty.current) return setLeaving(href)
    if (dirty.current || inflight.current) await flush()
    router.push(href)
  }

  // ── Starting points: a starter, or someone's own HTML ──────────────────
  const fileInput = React.useRef<HTMLInputElement>(null)
  function applyStarter(s: Starter) {
    if (!editor) return
    setContent(editor, s.html, extensions, "trusted")
    setEnv((e) => ({
      ...e,
      subject: e.subject || s.subject,
      previewText: e.previewText || s.previewText,
    }))
    setVariables((vs) => [
      ...vs,
      ...s.variables.filter((x) => !vs.some((v) => v.name === x.name)),
    ])
    if (!tpl.title || /^untitled template$/i.test(title)) setTitle(s.name)
    markDirty()
  }

  const showEmptyHelpers = view === "write" && kind === "visual" && empty
  const docked = pinned && !narrow
  const panelOpen =
    panel !== null &&
    (view === "write" || panel !== "inspector") &&
    (panel !== "inspector" || docked || peek)
  // ⚠ THE TAB STAYS WHILE THE PANEL PEEKS, and counts as the panel. The
  // panel sits 12px in from the edge, so a pointer still on the tab was
  // "outside" it: the panel left, the tab came back under the pointer, and
  // the two took turns for as long as the pointer stayed.
  const hiddenTab = view === "write" && panel === "inspector" && !docked

  return (
    <EditorContext.Provider value={{ editor }}>
      <div className="flex h-dvh flex-col overflow-hidden bg-sidebar text-foreground">
        {/* ── Top bar ── */}
        {/* ⚠ THREE COLUMNS, THE MIDDLE ONE CENTRED ON ITS OWN. The breadcrumb
            stays put whatever the right side says - "Auto-save", "Unsaved
            changes", "Saving…" - and the two can never overlap. */}
        <header className="relative z-20 grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3">
          <div />
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center justify-center gap-2 text-sm"
          >
            <Link
              href="/templates"
              onClick={(e) => {
                e.preventDefault()
                void leave("/templates")
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <LayoutTemplate className="size-4" />
              Templates
            </Link>
            <ChevronRight
              className="size-3.5 shrink-0 text-muted-foreground/60"
              aria-hidden
            />
            {folder && (
              <>
                <Link
                  href={backHref}
                  onClick={(e) => {
                    e.preventDefault()
                    void leave(backHref)
                  }}
                  className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <FolderGlyph className="shrink-0" />
                  <span className="max-w-[16vw] truncate">{folder.name}</span>
                </Link>
                <ChevronRight
                  className="size-3.5 shrink-0 text-muted-foreground/60"
                  aria-hidden
                />
              </>
            )}
            <TitleField
              value={title}
              onChange={(t) => {
                setTitle(t)
                markDirty()
              }}
            />
            <Swap id={status} className="shrink-0">
              <Badge variant={status === "published" ? "default" : "secondary"}>
                {STATUS_LABEL[status]}
              </Badge>
            </Swap>
          </nav>

          <div className="flex min-w-0 items-center justify-self-end gap-2">
            <SaveIndicator
              state={save}
              autosave={autosave}
              onRetry={() => void flush()}
            />
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="rounded-xl"
                  aria-label="More actions"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem
                  disabled={!hasContent}
                  onSelect={() => setDialog("test")}
                >
                  <Send />
                  Test email
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPanel("variables")}>
                  <Braces />
                  Variables
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPanel("versions")}>
                  <History />
                  Version history
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog("details")}>
                  <Info />
                  View details
                </DropdownMenuItem>
                <DropdownMenuItem
                  // Stays open: the switch is the answer, seen as it flips.
                  onSelect={(event) => {
                    event.preventDefault()
                    writeAutosave(!autosave)
                    // Turned on with changes waiting: they go now.
                    if (!autosave && dirty.current) void flush()
                  }}
                >
                  <Save />
                  Auto-save
                  <Switch
                    size="sm"
                    checked={autosave}
                    tabIndex={-1}
                    aria-hidden
                    className="pointer-events-none ml-auto"
                  />
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={async () => {
                    await flush()
                    const copy = await duplicateTemplate(tpl.id)
                    if (!copy.ok) return toastFailure(copy)
                    toastDone(`Duplicated as "${titleOf(copy.data)}"`)
                    router.push(`/templates/${encodeURIComponent(copy.data.id)}/editor`)
                  }}
                >
                  <Copy />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDialog("delete")}
                >
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <ActionButton
                    size="sm"
                    className="rounded-xl"
                    state={publishing.state}
                    onReset={publishing.reset}
                    pendingLabel="Publish"
                    doneLabel="Published"
                    disabled={!canPublish && publishing.state === "idle"}
                    onClick={() => void publish()}
                  >
                    Publish
                  </ActionButton>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {!hasContent ? (
                  "Write something to publish"
                ) : status === "published" ? (
                  `v${tpl.version} is live and up to date`
                ) : (
                  <>
                    Make this draft live <Kbd className="ml-1">⌘↵</Kbd>
                  </>
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* ── Rail ── */}
          <nav
            className="flex w-14 shrink-0 flex-col items-center gap-1 pt-1"
            aria-label="Editor"
          >
            <RailButton label="Back to templates" onClick={() => void leave(backHref)}>
              <Home />
            </RailButton>
            <div className="my-1 h-px w-6 bg-border" />
            <LayoutGroup id="rail">
              <RailButton label="Writing" active={view === "write"} onClick={openWrite}>
                <PenLine />
              </RailButton>
              <RailButton
                label="Code"
                active={view === "code"}
                onClick={() => void openCode()}
              >
                <Code2 />
              </RailButton>
            </LayoutGroup>
          </nav>

          {/* ── Work area ── */}
          <main className="flex min-w-0 flex-1 gap-3 pr-3 pb-3">
            <AnimatePresence initial={false}>
              {view === "code" && (
                <motion.section
                  key="code"
                  initial={{ flexBasis: "0%", opacity: 0 }}
                  animate={{ flexBasis: "50%", opacity: 1 }}
                  exit={{ flexBasis: "0%", opacity: 0 }}
                  transition={SPRING}
                  className="flex min-w-0 shrink-0 flex-col overflow-hidden"
                  aria-label="HTML code editor"
                >
                  <div className="flex h-11 items-center justify-between gap-4 px-2">
                    <p className="shrink-0 text-sm font-medium whitespace-nowrap">
                      HTML code editor
                    </p>
                    <CodeHint kind={kind} />
                  </div>
                  <div className="i10-code min-h-0 flex-1 overflow-hidden rounded-2xl border bg-background">
                    <CodeEditor
                      value={codeHtml}
                      onChange={(value) => {
                        setCodeHtml(value)
                        if (kind !== "html") setKind("html")
                        markDirty()
                      }}
                      className="h-full"
                    />
                  </div>
                </motion.section>
              )}
            </AnimatePresence>

            <motion.div
              ref={canvas}
              layout
              transition={SPRING}
              className="relative flex min-w-0 flex-1 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 dark:ring-white/10"
            >
              <div
                className="i10-canvas min-w-0 flex-1 overflow-y-auto"
                style={{
                  paddingRight:
                    panelOpen &&
                    view === "write" &&
                    (panel !== "inspector" || docked) &&
                    !narrow
                      ? 344
                      : 0,
                  transition: "padding-right 300ms cubic-bezier(0.22,1,0.36,1)",
                }}
              >
                <div
                  className={cn(
                    "mx-auto w-full max-w-[760px] pt-10 pr-10 pl-24",
                    view === "code" && "max-w-none px-8 pt-8",
                  )}
                >
                  <EnvelopeFields
                    value={env}
                    onChange={edit}
                    verified={verified}
                    compact={view === "code"}
                  />

                  {/* Writing */}
                  <div
                    ref={writing}
                    className={cn("relative pt-6", view !== "write" && "hidden")}
                  >
                    {editor && <EditorContent editor={editor} />}
                    {editor && <SelectionRing editor={editor} container={writing} />}
                    {editor && view === "write" && kind === "visual" && (
                      <BlockHandle editor={editor} />
                    )}
                    <AnimatePresence>
                      {showEmptyHelpers && (
                        <motion.div
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
                          className="pointer-events-none absolute top-[4.5rem] left-0 flex flex-col items-start gap-1 text-sm text-neutral-400 [&>*]:pointer-events-auto"
                        >
                          <StarterPicker onPick={applyStarter} />
                          <button
                            type="button"
                            onClick={() => fileInput.current?.click()}
                            className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:text-neutral-700"
                          >
                            <Upload className="size-4" />
                            Upload HTML or
                            <Kbd className="bg-neutral-100 text-neutral-500">⌘</Kbd>
                            <Kbd className="-ml-1 bg-neutral-100 text-neutral-500">
                              V
                            </Kbd>
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Code view's preview */}
                  {view === "code" && (
                    <LivePreview html={codeHtml} imagesFrom={imagesFrom} />
                  )}
                </div>
              </div>

              {/* Toolbar */}
              <AnimatePresence>
                {view === "write" && editor && (
                  <div className="pointer-events-none absolute inset-y-0 left-4 flex items-center">
                    <div className="pointer-events-auto">
                      <BlockToolbar
                        editor={editor}
                        variables={variables}
                        onUploadImage={() => editor.chain().focus().uploadImage().run()}
                        onOpenVariables={() => setPanel("variables")}
                        onCreateVariable={() =>
                          setDialog({ variable: null, insert: true })
                        }
                      />
                    </div>
                  </div>
                )}
              </AnimatePresence>

              {/* Right panel: inspector, variables, versions */}
              <AnimatePresence mode="wait">
                {panelOpen && (
                  <motion.aside
                    key={panel}
                    data-i10-inspector-shell
                    onBlur={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                        if (panel === "inspector" && !docked && !hovering.current)
                          peekOut()
                    }}
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{
                      opacity: 0,
                      x: 16,
                      // A fading panel must not catch the pointer and peek again.
                      pointerEvents: "none",
                      transition: { duration: 0.12 },
                    }}
                    transition={SPRING}
                    className="absolute top-3 right-3 bottom-3 z-10 w-80 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-xl"
                  >
                    {panel === "inspector" && editor && (
                      <div className="relative h-full" data-i10-inspector>
                        <InspectorPanel editor={editor} />
                        <div className="absolute top-2 right-2">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="size-7"
                                onClick={() => setPinned(!docked)}
                                aria-label={docked ? "Hide inspector" : "Pin inspector"}
                              >
                                <Swap id={docked ? "close" : "pin"}>
                                  {docked ? <PanelRightClose /> : <Pin />}
                                </Swap>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {docked
                                ? "Hide inspector"
                                : narrow
                                  ? "Pin when there is room"
                                  : "Pin inspector"}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    )}
                    {panel === "variables" && (
                      <VariablesPanel
                        variables={variables}
                        used={used}
                        canInsert={view === "write" ? !!editor : true}
                        onInsert={insertVariable}
                        onCreate={() => setDialog({ variable: null, insert: false })}
                        onEdit={(v) => setDialog({ variable: v, insert: false })}
                        onRemove={(name) => {
                          setVariables((vs) => vs.filter((v) => v.name !== name))
                          markDirty()
                        }}
                        onDeclare={(name) => {
                          setVariables((vs) => [
                            ...vs,
                            { name, type: "string", fallback: null },
                          ])
                          markDirty()
                        }}
                        onClose={() => setPanel(view === "write" ? "inspector" : null)}
                      />
                    )}
                    {panel === "versions" && (
                      <VersionsPanel
                        templateId={tpl.id}
                        history={tpl.history}
                        editable
                        imagesFrom={imagesFrom}
                        onClose={() => setPanel(view === "write" ? "inspector" : null)}
                        onPromoted={() => void refreshTemplate()}
                        onRestored={(row) => {
                          // The draft is the version now: start the editor over on it.
                          quiet.current = true
                          setTpl((t) => ({ ...t, ...row, history: t.history }))
                          setEnv({
                            from: row.from ?? "",
                            replyTo: (row.reply_to ?? []).join(", "),
                            subject: row.subject ?? "",
                            previewText: row.preview_text ?? "",
                          })
                          setVariables(row.variables ?? [])
                          const k = row.kind === "html" ? "html" : "visual"
                          setKind(k)
                          setCodeHtml(k === "html" ? (row.html ?? "") : "")
                          if (k === "visual" && editor)
                            editor.commands.setContent(row.design ?? "")
                          setView(k === "html" ? "code" : "write")
                          dirty.current = false
                          setSave("saved")
                          rebase.current = true
                          setTimeout(() => (quiet.current = false), 0)
                          void refreshTemplate()
                        }}
                      />
                    )}
                  </motion.aside>
                )}
              </AnimatePresence>

              {/* Inspector hidden: a tab on the right edge brings it in. */}
              <AnimatePresence>
                {hiddenTab && (
                  <motion.button
                    type="button"
                    aria-label="Show inspector"
                    // ⚠ CENTRED BY `y`, NOT A TAILWIND TRANSLATE: motion owns
                    // `transform` here and would wipe `-translate-y-1/2`.
                    initial={{ opacity: 0, x: 6, y: "-50%" }}
                    animate={{ opacity: 1, x: 0, y: "-50%" }}
                    exit={{ opacity: 0, x: 6, y: "-50%" }}
                    transition={SPRING}
                    onPointerEnter={peekIn}
                    onPointerLeave={peekOut}
                    onFocus={peekIn}
                    onClick={peekIn}
                    // Resend's target: a 36 x 128 box on the right edge, not
                    // the whole height, around a 5 x 96 pill.
                    // Under the panel (z-10), so where they overlap the
                    // panel takes the pointer.
                    data-i10-inspector-shell
                    className="group/tab absolute top-1/2 right-0 z-[5] flex h-32 w-9 items-center justify-center outline-none"
                  >
                    <span
                      className={cn(
                        "h-24 w-[5px] rounded-full bg-neutral-300 transition-[background-color,opacity] duration-(--duration-dismiss) group-hover/tab:bg-neutral-400 group-focus-visible/tab:bg-neutral-500",
                        peek && "opacity-0",
                      )}
                    />
                  </motion.button>
                )}
              </AnimatePresence>
            </motion.div>
          </main>
        </div>

        {/* Menus the editor floats over the email */}
        {editor && (
          <>
            <TextBubbleMenu />
            <BubbleMenu.LinkDefault />
            <BubbleMenu.ButtonDefault />
            <BubbleMenu.ImageDefault />
            <SlashCommand
              items={[...defaultSlashCommands, imageSlashCommand, ...variableItems]}
            />
          </>
        )}

        <input
          ref={fileInput}
          type="file"
          accept=".html,.htm,text/html"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (!file) return
            if (file.size > 2 * 1024 * 1024)
              return void toastError("That file is over 2 MB")
            setDialog({ importHtml: await file.text(), name: file.name })
          }}
        />
      </div>

      {/* ── Dialogs ── */}
      <ImportDialog
        open={typeof dialog === "object" && dialog !== null && "importHtml" in dialog}
        name={
          typeof dialog === "object" && dialog !== null && "importHtml" in dialog
            ? dialog.name
            : ""
        }
        onOpenChange={(o) => !o && setDialog(null)}
        onChoose={(as) => {
          if (!(
            typeof dialog === "object" &&
            dialog !== null &&
            "importHtml" in dialog
          ))
            return
          const html = dialog.importHtml
          setDialog(null)
          if (as === "code") {
            setCodeHtml(html)
            setKind("html")
            setView("code")
          } else if (editor) {
            setContent(editor, html, extensions, "import")
            setKind("visual")
            setView("write")
          }
          markDirty()
        }}
      />
      <ConfirmDialog
        open={dialog === "to-visual"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Edit this in the visual editor?"
        description="The editor rebuilds its blocks from your HTML. Layout it cannot express, like custom tables and classes, is simplified. Nothing is published until you publish."
        confirmLabel="Convert to blocks"
        doneLabel="Converted"
        destructive={false}
        onConfirm={async () => {
          convertToVisual()
          return true
        }}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Delete ${title || tpl.name}?`}
        description={`Any send naming ${tpl.name} or its id will start failing. Check your code first.`}
        confirmLabel="Delete template"
        doneLabel="Deleted"
        confirmWord={tpl.name}
        onConfirm={async () => {
          if (timer.current) clearTimeout(timer.current)
          dirty.current = false
          const result = await deleteTemplate(tpl.id)
          if (!result.ok) {
            toastFailure(result)
            return false
          }
          setTimeout(() => router.push(backHref), 600)
          return true
        }}
      />
      <TestEmailDialog
        open={dialog === "test"}
        onOpenChange={(o) => !o && setDialog(null)}
        templateId={tpl.id}
        defaultTo={userEmail}
        templateFrom={env.from}
        verified={verified}
        beforeSend={async () => {
          dirty.current = true
          return flush()
        }}
      />
      <LeaveDialog
        open={leaving !== null}
        onOpenChange={(o) => !o && setLeaving(null)}
        onSave={async () => {
          dirty.current = true
          const ok = await flush()
          if (ok && leaving) router.push(leaving)
          return ok
        }}
        onDiscard={() => {
          // Nothing left to ask about on the way out.
          dirty.current = false
          if (timer.current) clearTimeout(timer.current)
          const href = leaving
          setLeaving(null)
          if (href) router.push(href)
        }}
      />
      <TemplateDetailsDialog
        open={dialog === "details"}
        onOpenChange={(o) => !o && setDialog(null)}
        template={{ ...tpl, title: title || null }}
        folders={folders}
        variables={variables}
        onSaved={(p) => {
          setTitle(p.title ?? p.name)
          setTpl((t) => ({ ...t, name: p.name, title: p.title }))
        }}
      />
      <VariableDialog
        open={typeof dialog === "object" && dialog !== null && "variable" in dialog}
        onOpenChange={(o) => !o && setDialog(null)}
        editing={
          typeof dialog === "object" && dialog !== null && "variable" in dialog
            ? dialog.variable
            : null
        }
        taken={variables.map((v) => v.name)}
        onSave={(v, previous) => {
          setVariables((vs) => {
            if (previous) return vs.map((x) => (x.name === previous ? v : x))
            return vs.length >= MAX_VARIABLES ? vs : [...vs, v]
          })
          if (previous && previous !== v.name && editor)
            renameVariable(editor, previous, v.name)
          // Made from the Insert toolbar: it goes in where the caret was.
          if (
            !previous &&
            editor &&
            typeof dialog === "object" &&
            dialog !== null &&
            "insert" in dialog &&
            dialog.insert
          )
            editor.chain().focus().insertVariable(v.name).run()
          markDirty()
          setTimeout(() => setDialog(null), 500)
        }}
      />
    </EditorContext.Provider>
  )
}

/** The template's title, edited in place in the top bar. */
function TitleField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const input = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const start = () => {
    if (editing) return
    setDraft(value)
    setEditing(true)
  }
  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== value) onChange(next.slice(0, 200))
  }
  // ⚠ ANIMATED ON THE WAY IN AND OUT, STILL IN BETWEEN. Clicking widens the
  // name into a field of a fixed width and fades its background and ring in;
  // typing never moves it; finishing narrows it back to the name and fades
  // them out. The name keeps the same inset throughout, so it never shifts.
  const [editWidth, setEditWidth] = React.useState(288)
  const begin = () => {
    // 18rem, or 40% of a narrow screen.
    setEditWidth(Math.round(Math.min(288, window.innerWidth * 0.4)))
    start()
  }

  return (
    <Tooltip open={editing ? false : undefined}>
      <TooltipTrigger asChild>
        <motion.div
          initial={false}
          animate={{ width: editing ? editWidth : "auto" }}
          transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.7 }}
          role={editing ? undefined : "button"}
          tabIndex={editing ? undefined : 0}
          aria-label={editing ? undefined : `Rename ${value || "Untitled Template"}`}
          onClick={editing ? undefined : begin}
          onKeyDown={(e) => {
            if (!editing && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault()
              begin()
            }
          }}
          className={cn(
            "relative flex h-7 max-w-[min(40vw,18rem)] min-w-0 items-center overflow-hidden rounded-md px-2 text-sm font-medium outline-none",
            "transition-[background-color,box-shadow] duration-200 ease-(--ease-quad-out)",
            editing
              ? "bg-background shadow-[0_0_0_1px_var(--border),0_0_0_4px_color-mix(in_oklch,var(--ring)_14%,transparent)]"
              : "cursor-text hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {editing ? (
            <input
              ref={input}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit()
                if (e.key === "Escape") setEditing(false)
              }}
              maxLength={200}
              aria-label="Template name"
              className="w-full min-w-0 bg-transparent outline-none"
            />
          ) : (
            <span className="truncate whitespace-pre">
              {value || "Untitled Template"}
            </span>
          )}
        </motion.div>
      </TooltipTrigger>
      <TooltipContent>Rename</TooltipContent>
    </Tooltip>
  )
}

/**
 * Where the draft stands, beside the menu.
 *
 * ⚠ TWO VOCABULARIES. With auto-save on there is nothing to do, so it says
 * "Auto-save" in green and only interrupts to show a save in flight or a
 * failure. Off, "Unsaved changes" in red is a to-do, and hovering it says
 * how to do it; once saved it says "Saved", in green.
 *
 * ⚠ ONE BOX THAT GLIDES, NOT A SWAP. Swapping the whole thing pulled the old
 * text out of the layout at once, so the box - pinned to the right - snapped
 * to the new width and the words jumped sideways before anything faded: the
 * "cut" between "Auto-save" and "Saved". Here the box animates its width,
 * the icon only animates when it changes (the check both share stays put),
 * and the colour fades.
 */
function SaveIndicator({
  state,
  autosave,
  onRetry,
}: {
  state: SaveState
  autosave: boolean
  onRetry: () => void
}) {
  const view =
    state === "saving"
      ? { icon: "spin", label: "Saving…", tone: "text-muted-foreground" }
      : state === "error"
        ? { icon: "alert", label: "Not saved. Retry", tone: "text-destructive" }
        : autosave
          ? { icon: "check", label: "Auto-save", tone: "text-success" }
          : state === "dirty"
            ? { icon: "dot", label: "Unsaved changes", tone: "text-destructive" }
            : { icon: "check", label: "Saved", tone: "text-success" }
  const icon = {
    spin: <Loader2 className="size-3 animate-spin" />,
    alert: <AlertCircle className="size-3.5" />,
    check: <Check className="size-3.5" />,
    dot: <span className="block size-1.5 rounded-full bg-current" />,
  }[view.icon]
  const glide = { type: "spring", stiffness: 500, damping: 40, mass: 0.7 } as const

  const box = (
    <motion.div
      layout
      transition={glide}
      className={cn(
        "relative hidden h-6 items-center gap-1.5 overflow-hidden text-xs transition-colors duration-200 sm:flex",
        view.tone,
        state === "error" && "cursor-pointer hover:underline",
        !autosave && state === "dirty" && "cursor-default",
      )}
      onClick={state === "error" ? onRetry : undefined}
      role={state === "error" ? "button" : undefined}
      aria-live="polite"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={view.icon}
          layout="position"
          className="grid size-3.5 place-items-center"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={glide}
        >
          {icon}
        </motion.span>
      </AnimatePresence>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={view.label}
          layout="position"
          className="whitespace-nowrap"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={glide}
        >
          {view.label}
        </motion.span>
      </AnimatePresence>
    </motion.div>
  )

  // ⚠ ALWAYS IN THE TOOLTIP, OFF WHEN THERE IS NOTHING TO SAY. Wrapping
  // only the "Unsaved changes" state rebuilt the box on the way in and out of
  // it, so that one state appeared without animating.
  const hint = !autosave && state === "dirty"
  return (
    <Tooltip open={hint ? undefined : false}>
      <TooltipTrigger asChild>{box}</TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        Press <Kbd>⌘S</Kbd> to save
      </TooltipContent>
    </Tooltip>
  )
}

function RailButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "relative grid size-10 place-items-center rounded-xl text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-[18px]",
            active && "text-foreground",
          )}
        >
          {active && (
            <motion.span
              layoutId="rail-active"
              className="absolute inset-0 rounded-xl bg-accent"
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
            />
          )}
          <span className="relative">{children}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function CodeHint({ kind }: { kind: "visual" | "html" }) {
  return (
    <Swap
      id={kind}
      className="min-w-0 text-[11px] text-muted-foreground [&_span]:truncate"
    >
      {kind === "visual" ? (
        <span
          className="flex min-w-0 items-center gap-1.5"
          title="Typing here makes this an HTML template."
        >
          <FileCode2 className="size-3.5 shrink-0" />
          Generated by the editor. Typing here makes this an HTML template.
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          <FileCode2 className="size-3.5 shrink-0" />
          Your HTML is sent as written. Use {"{{{ name }}}"} for variables.
        </span>
      )}
    </Swap>
  )
}

/** The email as the HTML now stands, redrawn a beat after typing stops. */
function LivePreview({
  html,
  imagesFrom,
}: {
  html: string
  imagesFrom: string | null
}) {
  const [shown, setShown] = React.useState(html)
  React.useEffect(() => {
    const t = setTimeout(() => setShown(html), 250)
    return () => clearTimeout(t)
  }, [html])
  return (
    <div className="pt-4 pb-8">
      {shown.trim() ? (
        <EmailFrame
          html={shown}
          title="Preview"
          imagesFrom={imagesFrom}
          className="min-h-[70vh] rounded-lg border border-neutral-200"
        />
      ) : (
        <p className="py-24 text-center text-sm text-neutral-400">
          The preview appears as you write HTML.
        </p>
      )}
    </div>
  )
}

function StarterPicker({ onPick }: { onPick: (s: Starter) => void }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:text-neutral-700"
        >
          <LayoutTemplate className="size-4" />
          Pick a template
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
          Start from
        </p>
        {STARTERS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              setOpen(false)
              onPick(s)
            }}
            className="w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
          >
            <span className="block text-sm">{s.name}</span>
            <span className="block text-xs text-muted-foreground">{s.description}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function ImportDialog({
  open,
  name,
  onOpenChange,
  onChoose,
}: {
  open: boolean
  name: string
  onOpenChange: (open: boolean) => void
  onChoose: (as: "code" | "blocks") => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open {name || "this HTML"}</DialogTitle>
          <DialogDescription>
            Keep the HTML exactly as written and edit it as code, or convert it into
            blocks for the visual editor. Converting simplifies layout the editor cannot
            express.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <button
            type="button"
            onClick={() => onChoose("code")}
            className="flex items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-accent"
          >
            <Code2 className="mt-0.5 size-4 text-muted-foreground" />
            <span>
              <span className="block text-sm font-medium">Keep as HTML</span>
              <span className="block text-xs text-muted-foreground">
                Sent exactly as written. Edit in the Code view.
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => onChoose("blocks")}
            className="flex items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-accent"
          >
            <PenLine className="mt-0.5 size-4 text-muted-foreground" />
            <span>
              <span className="block text-sm font-medium">Convert to blocks</span>
              <span className="block text-xs text-muted-foreground">
                Edit visually, with the toolbar and inspector.
              </span>
            </span>
          </button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Everything a save writes, as one comparable string. */
function keyOf(l: {
  env: Envelope
  variables: DeclaredVariable[]
  kind: "visual" | "html"
  codeHtml: string
  title: string
  editor: Editor | null
}): string {
  return JSON.stringify({
    t: l.title.trim(),
    e: l.env,
    v: l.variables,
    k: l.kind,
    c: l.kind === "html" ? l.codeHtml : "",
    d: l.kind === "visual" ? (l.editor?.getJSON() ?? null) : null,
  })
}

/** `{{{ name }}}` or the older `{{ name }}`, balanced; the name is group 1 or 2. */
const PLACEHOLDER =
  /\{\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}\}|\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g

/** Every variable name the subject, the preview line, the body and its links use. */
function usedVariables(
  editor: Editor | null,
  env: Envelope,
  kind: "visual" | "html",
  html: string,
): string[] {
  const names = new Set<string>()
  for (const s of [env.subject, env.previewText])
    for (const m of s.matchAll(PLACEHOLDER)) names.add((m[1] ?? m[2])!)
  if (kind === "html") {
    for (const m of html.matchAll(PLACEHOLDER)) names.add((m[1] ?? m[2])!)
  } else if (editor) {
    editor.state.doc.descendants((node) => {
      if (node.type.name === "variable") names.add(String(node.attrs.name))
      if (node.isText)
        for (const m of (node.text ?? "").matchAll(PLACEHOLDER))
          names.add((m[1] ?? m[2])!)
      for (const mark of node.marks) {
        const href = mark.attrs.href
        if (typeof href === "string")
          for (const m of href.matchAll(PLACEHOLDER)) names.add((m[1] ?? m[2])!)
      }
      const href = node.attrs.href
      if (typeof href === "string")
        for (const m of href.matchAll(PLACEHOLDER)) names.add((m[1] ?? m[2])!)
    })
  }
  return [...names]
}

/** Renames every chip of one variable, after the variable itself was renamed. */
function renameVariable(editor: Editor, from: string, to: string) {
  const tr = editor.state.tr
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "variable" && node.attrs.name === from) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, name: to })
    }
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

/*
 * Pasted and imported HTML, made safe for the editor. A port of
 * @react-email/editor's own paste sanitizer (MIT), which `EmailEditor` uses
 * and does not export.
 */
const FORBIDDEN = [
  "script",
  "iframe",
  "object",
  "embed",
  "meta",
  "base",
  "link",
  "style",
]
const KEEP: Record<string, string[]> = {
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  table: ["border", "cellpadding", "cellspacing"],
  "*": ["id"],
}

function safeUrl(value: string, image: boolean): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are the point
  const v = value.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase()
  if (v.startsWith("javascript:") || v.startsWith("vbscript:")) return false
  if (v.startsWith("data:")) return image && v.startsWith("data:image/")
  return true
}

/**
 * `paste`: semantic HTML only, as the editor's own paste does. `import`: the
 * same, keeping inline styles so an uploaded email keeps its look where the
 * editor can hold it. `trusted`: our own starters.
 */
function sanitize(html: string, mode: "paste" | "import"): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  for (const tag of FORBIDDEN)
    for (const el of Array.from(doc.body.getElementsByTagName(tag))) el.remove()
  for (const el of Array.from(doc.body.querySelectorAll("[href], [src]"))) {
    for (const attr of ["href", "src"]) {
      const value = el.getAttribute(attr)
      if (value !== null && !safeUrl(value, el.tagName === "IMG"))
        el.removeAttribute(attr)
    }
  }
  // `{{{ name }}}` (or `{{ name }}`) written in the text becomes a chip; in an address it stays
  // as it is, because an attribute is where a link's variable belongs.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text)
  for (const node of texts) {
    const value = node.textContent ?? ""
    if (!PLACEHOLDER.test(value)) continue
    PLACEHOLDER.lastIndex = 0
    const parts = doc.createDocumentFragment()
    let at = 0
    for (const m of value.matchAll(PLACEHOLDER)) {
      parts.append(value.slice(at, m.index))
      const chip = doc.createElement("span")
      chip.setAttribute("data-variable", (m[1] ?? m[2])!)
      parts.append(chip)
      at = m.index + m[0].length
    }
    parts.append(value.slice(at))
    node.replaceWith(parts)
  }
  PLACEHOLDER.lastIndex = 0

  const fromEditor = /class="[^"]*node-/.test(html)
  if (!fromEditor) {
    for (const el of Array.from(doc.body.querySelectorAll("*"))) {
      const allowed = new Set([
        ...(KEEP[el.tagName.toLowerCase()] ?? []),
        ...(KEEP["*"] ?? []),
      ])
      if (mode === "import") allowed.add("style")
      for (const attr of Array.from(el.attributes)) {
        if (attr.name === "data-variable") continue
        if (attr.name.startsWith("on") || !allowed.has(attr.name))
          el.removeAttribute(attr.name)
      }
    }
  }
  return doc.body.innerHTML
}

function setContent(
  editor: Editor,
  html: string,
  extensions: Extensions,
  mode: "import" | "trusted",
) {
  const clean = mode === "trusted" ? html : sanitize(html, "import")
  editor.commands.setContent(generateJSON(clean, extensions))
  editor.commands.focus("end")
}

function pasteHandler(extensions: Extensions) {
  return (
    view: import("@tiptap/pm/view").EditorView,
    event: ClipboardEvent,
    slice: import("@tiptap/pm/model").Slice,
  ) => {
    if (slice.content.childCount === 1) return false
    const html = event.clipboardData?.getData("text/html")
    if (!html) return false
    event.preventDefault()
    const json = generateJSON(sanitize(html, "paste"), extensions)
    const node = view.state.schema.nodeFromJSON(json)
    view.dispatch(view.state.tr.replaceSelectionWith(node, false))
    return true
  }
}
