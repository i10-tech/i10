import { EmailNode } from "@react-email/editor/core"
import { InputRule, mergeAttributes, nodePasteRule } from "@tiptap/core"

/**
 * A variable in the visual editor: a chip on screen, `{{ name }}` in the email.
 *
 * ⚠ THE EMAIL CARRIES EXACTLY WHAT A HAND-WRITTEN TEMPLATE WOULD. The chip
 * exports as the plain `{{ name }}` text the publish step finds by pattern,
 * so a visual template and an HTML one fill their variables the same way at
 * send, and nothing about the send path knows chips exist.
 *
 * ⚠ AN ATOM. It is one unit for the caret and for deletion - half a variable
 * is a typo that would reach a customer's inbox as `{{ na`.
 *
 * ⚠ TYPING `{{ name }}` MAKES ONE, so people who know the syntax never need
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
    return `{{ ${String(node.attrs.name)} }}`
  },

  renderToReactEmail({ node }) {
    return <>{`{{ ${String(node.attrs?.name ?? "")} }}`}</>
  },

  addCommands() {
    return {
      insertVariable:
        (name: string) =>
        ({ chain }) =>
          chain()
            .insertContent([
              { type: this.name, attrs: { name } },
              { type: "text", text: " " },
            ])
            .run(),
    }
  },

  addPasteRules() {
    return [
      nodePasteRule({
        find: /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g,
        type: this.type,
        getAttributes: (match) => ({ name: match[1] }),
      }),
    ]
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}$/,
        handler: ({ state, range, match }) => {
          const name = match[1] ?? ""
          if (!VARIABLE_NAME.test(name)) return
          state.tr.replaceWith(range.from, range.to, this.type.create({ name }))
        },
      }),
    ]
  },
})
