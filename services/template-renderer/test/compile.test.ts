import { describe, expect, it } from "bun:test"
import { createElement, type FunctionComponent } from "react"
import { render } from "react-email"
import { fill } from "@repo/templates"
import { compileTemplate, type Sandbox } from "../src/compile.js"
import { prepare } from "../src/request.js"
import { sandboxModules, transpile } from "../src/sandbox.js"
import { answer, resolve } from "../src/runtime/entry.js"

/**
 * The renderer's whole chain - sucrase, the runtime's allowlist and harness,
 * the gate - in-process. What this cannot show is the isolate itself (no
 * network, the CPU limit); those are workerd's, and are checked against the
 * deployed Worker. See the README.
 */

function inProcess(source: string): { sandbox: Sandbox; exports: unknown } {
  const compiled = transpile(source)
  if (!compiled.ok) throw new Error(compiled.error)
  const module = { exports: {} as unknown }
  // Tests only: the Worker evaluates this as a module inside the sandbox.
  new Function("module", "exports", "require", compiled.code)(
    module,
    module.exports,
    resolve,
  )
  const exports = module.exports as Parameters<typeof answer>[0]
  return {
    exports,
    sandbox: {
      async ask(question) {
        try {
          return { ok: true, value: await answer(exports, question as never) }
        } catch (error) {
          return { ok: false, error: String(error) }
        }
      },
    },
  }
}

/**
 * A file set through the real `template.js` the Worker hands the sandbox: its
 * import and export lines swapped for a parameter and a return, and nothing
 * else about it changed.
 */
function inProcessFiles(entry: string, files: Record<string, string>) {
  const prepared = prepare({ entry, files })
  if (!prepared.ok) {
    throw new Error(
      "problems" in prepared ? prepared.problems.join("\n") : prepared.error,
    )
  }
  const module = sandboxModules({ ...prepared, runtime: "" })
    ["template.js"]!.replace('import { resolve } from "./runtime.js";', "")
    .replace(/export default (load\([^)]*\));\s*$/, "return $1;")
  const exports = new Function("resolve", module)(resolve) as Parameters<
    typeof answer
  >[0]
  return {
    exports,
    sandbox: {
      async ask(question: unknown) {
        try {
          return { ok: true, value: await answer(exports, question as never) }
        } catch (error) {
          return { ok: false, error: String(error) }
        }
      },
    } satisfies Sandbox,
  }
}

let seed = 0
const random = (n: number) =>
  Uint8Array.from({ length: n }, () => (seed = (seed * 31 + 7) % 251))

const fixture = await Bun.file(
  new URL("./fixtures/welcome.tsx", import.meta.url),
).text()

describe("compiling an uploaded template", () => {
  it("produces a skeleton that fills to exactly what React Email renders", async () => {
    const { sandbox, exports } = inProcess(fixture)
    const result = await compileTemplate(sandbox, random)
    if (!result.ok) throw new Error(result.problems.join("\n"))

    const values = {
      name: "Zoë & <co>",
      url: "https://x.test/?a=1&b=2",
      team: { name: 'Q"R' },
    }
    const filled = fill({ ...result.skeleton, subject: null }, values)
    if (!filled.ok) throw new Error("fill failed")

    const Component = (exports as { default: FunctionComponent<typeof values> }).default
    const element = createElement(Component, values)
    expect(filled.filled.html).toBe(await render(element))
    expect(filled.filled.text).toBe(await render(element, { plainText: true }))
  })

  it("refuses an import outside the allowlist", () => {
    expect(() => inProcess('import x from "lodash"\nexport default () => x')).toThrow(
      "cannot be imported",
    )
  })

  it("refuses logic over a variable, with the reason", async () => {
    const { sandbox } = inProcess(`
      import { Text } from "react-email"
      export default function T({ plan }: { plan: string }) {
        return <Text>{plan === "" ? "Free" : "Pro"}</Text>
      }
      T.PreviewProps = { plan: "pro" }
    `)
    const result = await compileTemplate(sandbox, random)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems[0]).toContain("used as a condition")
  })

  it("reports a template that does not compile", () => {
    const result = transpile("export default function (")
    expect(result.ok).toBe(false)
  })

  it("reports a file that does not compile by its path", () => {
    const prepared = prepare({
      entry: "a.tsx",
      files: { "a.tsx": 'import "./b"', "b.tsx": "export const = 1" },
    })
    expect(prepared.ok).toBe(false)
    if (!prepared.ok && "problems" in prepared) {
      expect(prepared.problems[0]).toStartWith("`b.tsx` does not compile")
    }
  })
})

describe("compiling a template made of several files", () => {
  const layout = `
    import { Body, Container, Html, Text } from "react-email"
    import type { ReactNode } from "react"
    import { footer } from "./footer"
    export function Layout({ children }: { children: ReactNode }) {
      return <Html><Body><Container>{children}<Text>{footer}</Text></Container></Body></Html>
    }
  `
  const files = {
    "components/layout.tsx": layout,
    "components/footer.ts": 'export const footer = "Sent by Acme"',
    "auth/welcome.tsx": `
      import { Text } from "react-email"
      import { Layout } from "../components/layout"
      export const subject = "Welcome, {{ name }}"
      export default function Welcome({ name }: { name: string }) {
        return <Layout><Text>Hi {name}</Text></Layout>
      }
      Welcome.PreviewProps = { name: "Ada" }
    `,
    "auth/reset.tsx": `
      import { Text } from "react-email"
      import { Layout } from "../components/layout.js"
      export default function Reset({ url }: { url: string }) {
        return <Layout><Text>{url}</Text></Layout>
      }
      Reset.PreviewProps = { url: "https://x.test" }
    `,
  }

  it("resolves a shared layout, and fills to exactly what React Email renders", async () => {
    const { sandbox, exports } = inProcessFiles("auth/welcome.tsx", files)
    const result = await compileTemplate(sandbox, random)
    if (!result.ok) throw new Error(result.problems.join("\n"))
    expect(result.subject).toBe("Welcome, {{ name }}")

    const filled = fill({ ...result.skeleton, subject: null }, { name: "<Bo>" })
    if (!filled.ok) throw new Error("fill failed")
    const Component = (exports as { default: FunctionComponent<{ name: string }> })
      .default
    expect(filled.filled.html).toBe(
      await render(createElement(Component, { name: "<Bo>" })),
    )
    expect(filled.filled.html).toContain("Sent by Acme")
  })

  it("keeps only the entry's closure, so a sibling template is not part of it", () => {
    const prepared = prepare({ entry: "auth/reset.tsx", files })
    expect(prepared.ok && Object.keys(prepared.files).sort()).toEqual([
      "auth/reset.tsx",
      "components/footer.ts",
      "components/layout.tsx",
    ])
  })

  it("has no subject when the file exports none", async () => {
    const { sandbox } = inProcessFiles("auth/reset.tsx", files)
    const result = await compileTemplate(sandbox, random)
    expect(result.ok && result.subject).toBeNull()
  })

  it("refuses an import that is not among the files, naming both", () => {
    expect(
      prepare({ entry: "a.tsx", files: { "a.tsx": 'import x from "./gone"' } }),
    ).toEqual({
      ok: false,
      status: 422,
      problems: ["`./gone`, imported by `a.tsx`, is not in the files."],
    })
  })

  it("refuses a relative require the scan did not see, rather than resolving it", () => {
    // Thrown while the module loads; in the Worker that is a failed load, which
    // reaches the uploader as "The template failed while rendering: …".
    expect(() =>
      inProcessFiles("a.tsx", {
        "a.tsx": `
          const name = "./b"
          const b = require(name)
          export default function A() { return b }
          A.PreviewProps = {}
        `,
        "b.tsx": "export default 1",
      }),
    ).toThrow("`./b`, imported by `a.tsx`, is not one of the template's files.")
  })

  it("refuses an exported subject that is not a string", async () => {
    const { sandbox } = inProcessFiles("a.tsx", {
      "a.tsx": `
        export const subject = 42
        export default function A() { return null }
        A.PreviewProps = {}
      `,
    })
    const result = await compileTemplate(sandbox, random)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems[0]).toContain("exported `subject`")
  })
})
