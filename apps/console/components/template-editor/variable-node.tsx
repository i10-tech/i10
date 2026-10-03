import { EmailNode } from "@react-email/editor/core"
import { InputRule, mergeAttributes, nodePasteRule } from "@tiptap/core"
import { Selection } from "@tiptap/pm/state"

/**
 * A variable in the visual editor: a chip on screen, `{{{ name }}}` in the email.
 *
 * ⚠ THE EMAIL CARRIES EXACTLY WHAT A HAND-WRITTEN TEMPLATE WOULD. The chip
 * exports as the plain `{{{ name }}}` text the publish step finds by pattern,
 * so a visual template and an HTML one fill their variables the same way at
 * send, and nothing about the send path knows chips exist.
 *
 * ⚠ AN ATOM. It is one unit for the caret and for deletion - half a variable
 * is a typo that would reach a customer's inbox as `{{{ na`.
 *
 * ⚠ TYPING `{{{ name }}}` MAKES ONE, so people who know the syntax never need
 * the menu, and text pasted from an HTML template becomes chips as it is
 * retyped.
 */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    variable: {
      insertVariable: (name: string) => ReturnType
    }
  }
}

export const Variable = EmailNode.create({
  name: "variable",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-variable") ?? "",
        renderHTML: (attributes: { name: string }) => ({
          "data-variable": attributes.name,
        }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "span[data-variable]" }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "i10-variable",
        contenteditable: "false",
        spellcheck: "false",
      }),
      String(node.attrs.name),
    ]
  },

  renderText({ node }) {
    return `{{{ ${String(node.attrs.name)} }}}`
  },

  renderToReactEmail({ node }) {
    return <>{`{{{ ${String(node.attrs?.name ?? "")} }}}`}</>
  },

  addCommands() {
    return {
      // ⚠ SPACED LIKE A WORD: a space before it when it lands against one,
      // and after it unless a space is already there - so "Hi|there" and
      // "Hi| there" both read "Hi {{{name}}} there".
      insertVariable:
        (name: string) =>
        ({ chain, state }) => {
          const { from, to, $from } = state.selection
          const inText = $from.parent.isTextblock
          const before = inText
            ? state.doc.textBetween(Math.max($from.start(), from - 1), from)
            : ""
          const after = inText
            ? state.doc.textBetween(to, Math.min($from.end(), to + 1))
            : ""
          return chain()
            .insertContent([
              ...(before && !/\s/.test(before) ? [{ type: "text", text: " " }] : []),
              { type: this.name, attrs: { name } },
              ...(/\s/.test(after) ? [] : [{ type: "text", text: " " }]),
            ])
            .run()
        },
    }
  },

  // ⚠ AN ARROW THAT CANNOT GO ANYWHERE DOES NOTHING. Beside a chip at the very
  // end (or start) of the email, the browser's own caret movement had nowhere
  // to land: it lurched toward the chip's far side and snapped back. Here the
  // key moves to the next place a caret can stand, or stays put if there is
  // none - and anywhere else, ProseMirror handles it as usual.
  addKeyboardShortcuts() {
    const step = (direction: 1 | -1) => () => {
      const { state, view } = this.editor
      const { selection } = state
      if (!selection.empty) return false
      const $at = selection.$from
      const beside = direction > 0 ? $at.nodeAfter : $at.nodeBefore
      const atEdge =
        direction > 0
          ? $at.parentOffset === $at.parent.content.size
          : $at.parentOffset === 0
      const chipNear =
        (direction > 0 ? $at.nodeBefore : $at.nodeAfter)?.type.name === this.name
      if (beside || !atEdge || !chipNear) return false
      const outside = direction > 0 ? $at.after() : $at.before()
      const next = Selection.findFrom(state.doc.resolve(outside), direction, true)
      if (next) view.dispatch(state.tr.setSelection(next).scrollIntoView())
      return true
    }
    return { ArrowRight: step(1), ArrowLeft: step(-1) }
  },

  addPasteRules() {
    return [
      nodePasteRule({
        // Either spelling, balanced: old two-brace text pastes in as chips too.
        find: /\{\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}\}|\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g,
        type: this.type,
        getAttributes: (match) => ({ name: match[1] ?? match[2] }),
      }),
    ]
  },

  addInputRules() {
    return [
      new InputRule({
        // ⚠ THREE BRACES ONLY: a two-brace rule would fire at `{{name}}`, one
        // keystroke before the third `}`, and strand the first `{` in the text.
        find: /\{\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}\}$/,
        handler: ({ state, range, match }) => {
          const name = match[1] ?? ""
          if (!VARIABLE_NAME.test(name)) return
          state.tr.replaceWith(range.from, range.to, this.type.create({ name }))
        },
      }),
    ]
  },
})
