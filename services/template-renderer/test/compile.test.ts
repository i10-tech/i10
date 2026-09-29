import { describe, expect, it } from "bun:test"
import { createElement, type FunctionComponent } from "react"
import { render } from "react-email"
import { fill } from "@repo/templates"
import { compileTemplate, type Sandbox } from "../src/compile.js"
import { transpile } from "../src/sandbox.js"
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
})
