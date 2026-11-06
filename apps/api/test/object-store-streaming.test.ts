import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { S3Client } from "bun"
import { r2Store } from "../src/content/object-store.js"

/**
 * `r2Store`'s streaming methods through Bun's real S3 client, against a stub S3
 * on localhost that speaks just enough of the protocol (single PUT, multipart,
 * ranged GET, HEAD, DELETE). It proves the writer really goes multipart and the
 * reader really streams; it does not prove R2 agrees, which only R2 can.
 */

const objects = new Map<string, Uint8Array>()
const uploads = new Map<string, Map<number, Uint8Array>>()
const seen = { parts: 0, singlePuts: 0 }
let server: ReturnType<typeof Bun.serve>

const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ""))
      const q = url.searchParams

      if (request.method === "POST" && q.has("uploads")) {
        const id = crypto.randomUUID()
        uploads.set(id, new Map())
        return new Response(
          `<InitiateMultipartUploadResult><Bucket>bucket</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        )
      }
      if (request.method === "PUT" && q.has("partNumber")) {
        seen.parts++
        uploads
          .get(q.get("uploadId")!)!
          .set(Number(q.get("partNumber")), new Uint8Array(await request.arrayBuffer()))
        return new Response(null, { headers: { etag: `"p${q.get("partNumber")}"` } })
      }
      if (request.method === "POST" && q.has("uploadId")) {
        const parts = uploads.get(q.get("uploadId")!)!
        objects.set(
          key,
          join([...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)),
        )
        return new Response(
          `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"x"</ETag></CompleteMultipartUploadResult>`,
        )
      }
      if (request.method === "PUT") {
        seen.singlePuts++
        objects.set(key, new Uint8Array(await request.arrayBuffer()))
        return new Response(null, { headers: { etag: '"x"' } })
      }
      const found = objects.get(key)
      if (request.method === "DELETE") {
        objects.delete(key)
        return new Response(null, { status: 204 })
      }
      if (!found) {
        return new Response(
          "<Error><Code>NoSuchKey</Code><Message>no</Message></Error>",
          { status: 404 },
        )
      }
      const headers = { "content-length": String(found.byteLength), etag: '"x"' }
      if (request.method === "HEAD") return new Response(null, { headers })
      return new Response(found, { headers })
    },
  })
})

afterAll(() => server.stop(true))

const store = () =>
  r2Store(
    new S3Client({
      endpoint: `http://127.0.0.1:${server.port}`,
      bucket: "bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
      region: "auto",
    }),
  )

describe("r2Store, streaming", () => {
  it("writes a large object as a multipart upload, in the pieces it is given", async () => {
    const s = store()
    const writer = s.open("big/archive", "application/gzip")
    const piece = new Uint8Array(1024 * 1024).fill(7)
    for (let i = 0; i < 20; i++) await writer.write(piece)
    // Nothing is readable under the key before the upload is completed.
    expect(await s.size("big/archive")).toBeNull()
    await writer.end()

    expect(seen.parts).toBeGreaterThan(1)
    expect(await s.size("big/archive")).toBe(20 * 1024 * 1024)
  })

  it("reads an object back as a stream", async () => {
    const s = store()
    const stream = s.read("big/archive")
    expect(stream).toBeInstanceOf(ReadableStream)
    let total = 0
    let chunks = 0
    for await (const chunk of stream) {
      total += chunk.byteLength
      chunks++
    }
    expect(total).toBe(20 * 1024 * 1024)
    expect(chunks).toBeGreaterThan(1)
  })

  it("says an object is missing with null, and deletes idempotently", async () => {
    const s = store()
    expect(await s.size("nothing/here")).toBeNull()
    await s.delete("big/archive")
    await s.delete("big/archive")
    expect(await s.size("big/archive")).toBeNull()
  })

  it("presigns a write-only URL for one key that expires", () => {
    const url = new URL(store().presignPut("tenant/imports/job-1", 900))
    expect(url.pathname).toContain("tenant/imports/job-1")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900")
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy()
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host")
  })
})
