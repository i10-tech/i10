import * as React from "react"
import * as JsxRuntime from "react/jsx-runtime"
import * as ReactEmail from "react-email"

/**
 * What a template's sandbox can import, and the one thing it is asked to do.
 *
 * ⚠ THIS IS BUNDLED INTO `dist/runtime.js` AND HANDED TO EVERY SANDBOX AS A
 * MODULE. It runs inside the isolate with the customer's code - nothing here is
 * trusted by the parent. The parent treats every byte that comes back as data
 * and decides for itself; see `verifyRenders` in @repo/templates.
 *
 * ⚠ THE IMPORTS ARE AN ALLOWLIST BECAUSE THERE IS NOTHING ELSE TO IMPORT. The
 * isolate has no network and no filesystem, so a template may use React and
 * React Email - pinned here, recorded on every version - and nothing more. A
 * template that needs another package gets a clear refusal at upload rather
 * than a module-not-found from inside a sandbox.
 */

type Module = Record<string, unknown>

/** CommonJS interop for code sucrase compiled: `__esModule`, and a `default`. */
function esm(namespace: object, fallbackDefault: unknown = namespace): Module {
  const out: Module = { ...namespace, __esModule: true }
  if (!("default" in out)) out.default = fallbackDefault
  return out
}

const REACT = esm(React, (React as Module).default ?? React)
const JSX = esm(JsxRuntime)
const EMAIL = esm(ReactEmail)

export function resolve(specifier: string): Module {
  switch (specifier) {
    case "react":
      return REACT
    case "react/jsx-runtime":
    case "react/jsx-dev-runtime":
      return JSX
    case "react-email":
    case "@react-email/components":
      return EMAIL
  }
  // `@react-email/button` and friends: every component is exported by
  // `react-email` under its own name, so the aggregate satisfies each.
  if (specifier.startsWith("@react-email/")) return EMAIL
  throw new Error(
    `\`${specifier}\` cannot be imported. A template may import react, react-email ` +
      "and @react-email/* - nothing else is available where templates are rendered.",
  )
}

type Exports = { default?: unknown } | ((...args: never[]) => unknown)

function componentOf(exports: Exports): React.FunctionComponent<Module> {
  const candidate =
    typeof exports === "function" ? exports : (exports as { default?: unknown }).default
  if (typeof candidate !== "function") {
    throw new Error("The template must `export default` a React component.")
  }
  return candidate as React.FunctionComponent<Module>
}

export type Request =
  { op: "preview" } | { op: "render"; sets: Module[]; probe: Module }

/**
 * The two questions the parent asks.
 *
 *   preview  the template's `PreviewProps`, which say what its variables are,
 *            and its exported `subject`, if it has one
 *   render   one render per prop set, HTML and plain text, and which top-level
 *            props the component read when called with `probe`
 *
 * ⚠ THE PROBE CALLS THE COMPONENT DIRECTLY, NOT THROUGH `createElement`, because
 * createElement copies props into a fresh object and a Proxy around the
 * original would see nothing. It is what catches a template that reads a prop
 * `PreviewProps` never declared - which would otherwise render as nothing,
 * once, and be frozen that way.
 */
export async function answer(exports: Exports, request: Request): Promise<unknown> {
  const Component = componentOf(exports)
  if (request.op === "preview") {
    const preview = (Component as { PreviewProps?: unknown }).PreviewProps
    // `export const subject = "…"`, which lets a template's file carry its
    // subject line (#234). Anything but a string is reported as it is, and
    // the parent refuses it.
    const subject =
      typeof exports === "object" && "subject" in exports
        ? (exports as { subject?: unknown }).subject
        : undefined
    return {
      preview: preview === undefined ? null : preview,
      subject: subject === undefined ? null : subject,
    }
  }

  const renders = []
  for (const props of request.sets) {
    const element = React.createElement(Component, props)
    renders.push({
      html: await ReactEmail.render(element),
      text: await ReactEmail.render(element, { plainText: true }),
    })
  }

  const accessed = new Set<string>()
  const probe = new Proxy(request.probe, {
    get(target, key, receiver) {
      if (typeof key === "string") accessed.add(key)
      return Reflect.get(target, key, receiver) as unknown
    },
  })
  try {
    await ReactEmail.render(React.createElement(() => Component(probe)))
  } catch {
    // The probe only watches reads; the real renders above already succeeded.
  }

  return { renders, accessed: [...accessed] }
}
