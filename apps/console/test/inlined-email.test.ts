import { afterEach, describe, expect, it, mock } from "bun:test"
import { startInlining } from "../lib/inlined-email"

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

function deferred() {
  let resolve!: (v: string) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const cancels: (() => void)[] = []
const start = (...a: Parameters<typeof startInlining>) => {
  const c = startInlining(...a)
  cancels.push(c)
  return c
}
afterEach(() => {
  while (cancels.length) cancels.pop()!()
})

describe("startInlining", () => {
  it("publishes only the inlined email when it is ready in time", async () => {
    const seen: string[] = []
    start("raw", async () => "inlined", (h) => seen.push(h), 20)
    await tick()
    await new Promise((r) => setTimeout(r, 40))
    expect(seen).toEqual(["inlined"])
  })

  it("shows the plain email when slow, then swaps to the inlined one", async () => {
    const d = deferred()
    const seen: string[] = []
    start("raw", () => d.promise, (h) => seen.push(h), 10)
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toEqual(["raw"])
    d.resolve("inlined")
    await tick()
    expect(seen).toEqual(["raw", "inlined"])
  })

  it("ignores a stale result once cancelled, slow timer included", async () => {
    const d = deferred()
    const publish = mock((_: string) => {})
    const cancel = start("old", () => d.promise, publish, 10)
    cancel()
    d.resolve("old-inlined")
    await new Promise((r) => setTimeout(r, 30))
    expect(publish).not.toHaveBeenCalled()
  })

  it("a newer email wins when the older one finishes last", async () => {
    const a = deferred()
    const b = deferred()
    const seen: string[] = []
    const cancelA = start("a", () => a.promise, (h) => seen.push(h), 1000)
    cancelA()
    start("b", () => b.promise, (h) => seen.push(h), 1000)
    b.resolve("b-inlined")
    a.resolve("a-inlined")
    await tick()
    expect(seen).toEqual(["b-inlined"])
  })

  it("falls back to the plain email when inlining fails", async () => {
    const seen: string[] = []
    start("raw", () => Promise.reject(new Error("x")), (h) => seen.push(h), 1000)
    await tick()
    expect(seen).toEqual(["raw"])
  })
})
