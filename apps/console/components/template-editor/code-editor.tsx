"use client"

import * as React from "react"
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete"
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands"
import { html } from "@codemirror/lang-html"
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view"
import { classHighlighter } from "@lezer/highlight"

/**
 * The HTML editor of the Code view: CodeMirror 6, with HTML highlighting,
 * completion of tags and attributes, matching brackets and closing tags,
 * line numbers and an undo history.
 *
 * ⚠ IT OWNS ITS DOCUMENT WHILE SOMEBODY TYPES. The value prop only replaces
 * the text when it differs from what is already there - a parent re-render
 * with the same string must never reset the cursor or the undo stack.
 *
 * ⚠ COLOURS COME FROM CLASSES (`tok-*`), styled in editor.css for both
 * themes, rather than a JavaScript theme that would need rebuilding when the
 * console's theme changes.
 */
export function CodeEditor({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  const host = React.useRef<HTMLDivElement>(null)
  const view = React.useRef<EditorView | null>(null)
  const changed = React.useEffectEvent((next: string) => onChange(next))

  React.useEffect(() => {
    if (!host.current) return
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          html({ autoCloseTags: true, selfClosingTags: true }),
          syntaxHighlighting(classHighlighter),
          EditorView.lineWrapping,
          placeholder("Start writing your email template…"),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed(update.state.doc.toString())
          }),
          EditorView.contentAttributes.of({
            "aria-label": "HTML",
            spellcheck: "false",
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
    // Created once; later values are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={host} className={className} />
}
