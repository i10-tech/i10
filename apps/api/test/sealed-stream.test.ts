import { describe, expect, it } from "bun:test"
import {
  CHUNK_BYTES,
  openStream,
  plainLength,
  sealedLength,
  sealStream,
} from "../src/mailboxes/sealed-stream.js"

/** The sealed export stream (mailboxes/sealed-stream.ts). */
const KEY = Buffer.alloc(32, 9)
const IDS = { tenantId: crypto.randomUUID(), jobId: crypto.randomUUID() }
const HEADER = 12
const SEALED_CHUNK = CHUNK_BYTES + 16

/** Feeds `bytes` in pieces of the given sizes, cycling. */
function source(bytes: Uint8Array, sizes = [bytes.byteLength || 1]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let i = 0
      for (let at = 0; at < bytes.byteLength; i++) {
        const n = sizes[i % sizes.length]!
        controller.enqueue(bytes.slice(at, at + n))
        at += n
      }
      controller.close()
    },
  })
}

const collect = async (stream: ReadableStream<Uint8Array>) =>
  Buffer.from(await new Response(stream).arrayBuffer())

const seal = (bytes: Uint8Array, sizes?: number[], ids = IDS) =>
  collect(source(bytes, sizes).pipeThrough(sealStream(KEY, ids)))

const open = (sealed: Uint8Array, ids = IDS, sizes?: number[]) =>
  collect(source(sealed, sizes).pipeThrough(openStream(KEY, ids)))

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "",
    (error: Error) => error.message,
  )

const random = (n: number) => {
  const bytes = new Uint8Array(n)
  for (let at = 0; at < n; at += 65_536)
    crypto.getRandomValues(bytes.subarray(at, Math.min(n, at + 65_536)))
  return bytes
}

describe("sealStream and openStream", () => {
  it("round trip every edge of the chunk size, with the length computable both ways", async () => {
    for (const n of [
      0,
      1,
      CHUNK_BYTES - 1,
      CHUNK_BYTES,
      CHUNK_BYTES + 1,
      3 * CHUNK_BYTES,
    ]) {
      const plain = random(n)
      const sealed = await seal(plain)
      expect(sealed.byteLength).toBe(sealedLength(n))
      expect(plainLength(sealed.byteLength)).toBe(n)
      expect((await open(sealed)).equals(Buffer.from(plain))).toBe(true)
    }
  })

  it("round trips megabytes fed in odd pieces, read back in other odd pieces", async () => {
    const plain = random(5 * 1024 * 1024 + 333)
    const sealed = await seal(plain, [1, 7_919, 65_537, 100_003])
    expect(Buffer.from(sealed).includes(Buffer.from(plain.subarray(0, 64)))).toBe(false)
    expect(
      (await open(sealed, IDS, [13, 70_001, 4_096])).equals(Buffer.from(plain)),
    ).toBe(true)
  })

  it("fails when cut at a chunk boundary, mid-chunk, or down to its header", async () => {
    const sealed = await seal(random(3 * CHUNK_BYTES + 10))
    for (const cut of [
      HEADER + 2 * SEALED_CHUNK,
      HEADER + SEALED_CHUNK + 100,
      sealed.byteLength - 1,
      HEADER,
      5,
    ]) {
      expect(await failure(open(sealed.subarray(0, cut)))).toMatch(
        /does not open|truncated/,
      )
    }
  })

  it("fails when two chunks are swapped, or a chunk is repeated", async () => {
    const sealed = await seal(random(3 * CHUNK_BYTES))
    const chunk = (i: number) =>
      sealed.subarray(HEADER + i * SEALED_CHUNK, HEADER + (i + 1) * SEALED_CHUNK)
    const header = sealed.subarray(0, HEADER)
    const swapped = Buffer.concat([header, chunk(1), chunk(0), chunk(2)])
    const repeated = Buffer.concat([header, chunk(0), chunk(0), chunk(1), chunk(2)])
    expect(await failure(open(swapped))).toContain("does not open at chunk 0")
    expect(await failure(open(repeated))).toContain("does not open at chunk 1")
  })

  it("fails on a flipped bit, and for another workspace or another job", async () => {
    const sealed = await seal(random(CHUNK_BYTES + 5))
    const flipped = Buffer.from(sealed)
    flipped[HEADER + 40] = flipped[HEADER + 40]! ^ 1
    expect(await failure(open(flipped))).toContain("does not open")
    expect(
      await failure(open(sealed, { ...IDS, tenantId: crypto.randomUUID() })),
    ).toContain("does not open")
    expect(
      await failure(open(sealed, { ...IDS, jobId: crypto.randomUUID() })),
    ).toContain("does not open")
  })

  it("refuses what is not a sealed archive, and a length no archive has", async () => {
    expect(await failure(open(new Uint8Array(100)))).toContain("not a sealed archive")
    expect(plainLength(HEADER + 15)).toBeNull()
    expect(plainLength(HEADER + SEALED_CHUNK + 3)).toBeNull()
  })

  it("emits as it goes: sealed chunks come out before the input ends", async () => {
    const transform = sealStream(KEY, IDS)
    const writer = transform.writable.getWriter()
    const reader = transform.readable.getReader()
    let out = 0
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        out += value.byteLength
      }
    })()
    for (let i = 0; i < 10; i++) await writer.write(random(CHUNK_BYTES))
    // Ten chunks in, the stream still open: nine are out, the tenth is held
    // back until it is known whether it is the last.
    await Bun.sleep(0)
    expect(out).toBe(HEADER + 9 * SEALED_CHUNK)
    await writer.close()
    await reading
    expect(out).toBe(sealedLength(10 * CHUNK_BYTES))
  })
})
