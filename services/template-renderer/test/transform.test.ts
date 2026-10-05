import { describe, expect, it } from "bun:test"
import {
  MAX_TRANSFORMATION_BYTES,
  prepareTransform,
  transformModules,
} from "../src/transform.js"

/**
 * The transformation chain in-process: sucrase, the CommonJS wrapper and its
 * refusing `require`. The isolate's own guarantees (no network, the 50ms CPU
 * limit) are workerd's and are checked against a running deployment; see the
 * README.
 */
function run(code: string, input: unknown) {
  const body = { code, input }
  const prepared = prepareTransform(body, JSON.stringify(body).length)
  if (!prepared.ok) return prepared
  const module = transformModules(prepared.code)["transformation.js"]!.replace(
    /export default ([\s\S]*);\s*$/,
    "return $1;",
  )
  // As the Worker does: a throw while the module loads (an import, a top-level
  // error) and a throw from the handler are both the function failing.
  try {
    const handler = new Function(module)() as unknown
    if (typeof handler !== "function")
      return { ok: false as const, error: "no function" }
    const webhook = structuredClone(input)
    const value = (handler as (w: unknown) => unknown)(webhook)
    return { ok: true as const, value: value === undefined ? webhook : value }
  } catch (error) {
    return { ok: false as const, error: String((error as Error).message) }
  }
}

const webhook = {
  payload: { id: "d1", type: "email.bounced", data: { email_id: "e1" } },
  method: "POST",
  url: "https://hooks.example.com/i10",
  headers: {},
}

describe("transformations", () => {
  it("runs a TypeScript default export and returns what it builds", () => {
    const r = run(
      `export default function handler(webhook: { payload: { type: string } }) {
         return { ...webhook, payload: { text: "got " + webhook.payload.type } }
       }`,
      webhook,
    )
    expect(r).toMatchObject({
      ok: true,
      value: { payload: { text: "got email.bounced" } },
    })
  })

  it("accepts a named `handler` export, and a function that mutates and returns nothing", () => {
    expect(
      run(`export function handler(w) { w.method = "PUT" }`, webhook),
    ).toMatchObject({ ok: true, value: { method: "PUT" } })
  })

  it("refuses every import by name", () => {
    const r = run(
      `import fs from "node:fs"\nexport default (w) => fs.readFileSync("/etc/passwd")`,
      webhook,
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toContain("`node:fs` is not available")
  })

  it("says what is wrong with code that does not compile", () => {
    const r = run(`export default function (w) { return w`, webhook)
    expect(r).toMatchObject({ ok: false, status: 422 })
    expect((r as { error: string }).error).toContain("does not compile")
  })

  it("refuses code over the size cap before compiling it", () => {
    const big = `export default (w) => w // ${"x".repeat(MAX_TRANSFORMATION_BYTES)}`
    expect(run(big, webhook)).toMatchObject({ ok: false, status: 422 })
  })

  it("refuses a request with no code or no input", () => {
    expect(prepareTransform({ input: webhook }, 10)).toMatchObject({
      ok: false,
      status: 400,
    })
    expect(prepareTransform({ code: "x" }, 10)).toMatchObject({
      ok: false,
      status: 400,
    })
  })
})
