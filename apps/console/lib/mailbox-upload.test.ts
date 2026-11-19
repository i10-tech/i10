import { describe, expect, it } from "bun:test"
import {
  putArchive,
  PREVIEW_UPLOAD_PREFIX,
  UPLOAD_CONTENT_TYPE,
  UploadError,
} from "./mailbox-upload"

/** An XMLHttpRequest that records what was asked of it and lets a test finish it. */
class FakeRequest {
  method = ""
  url = ""
  headers: Record<string, string> = {}
  withCredentials = false
  timeout = -1
  sent: unknown = undefined
  aborted = false
  status = 0
  upload: { onprogress: ((event: unknown) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: unknown) {
    this.sent = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
}

const asRequest = (fake: FakeRequest) => (() => fake) as unknown as () => XMLHttpRequest

describe("putArchive", () => {
  const file = new Blob(["From a@b.dev\n"])
  const url = "https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=abc"

  it("sends exactly PUT <url> with Content-Type and nothing else, and no credentials", () => {
    const fake = new FakeRequest()
    void putArchive({ url, file, onProgress: () => {}, createRequest: asRequest(fake) })

    expect(fake.method).toBe("PUT")
    expect(fake.url).toBe(url)
    // ⚠ THE BUCKET'S CORS RULE ALLOWS THIS ONE HEADER. Any other, or a cookie, fails the preflight.
    expect(fake.headers).toEqual({ "Content-Type": UPLOAD_CONTENT_TYPE })
    expect(fake.withCredentials).toBe(false)
    expect(fake.sent).toBe(file)
    // No timeout: a gigabyte on a slow line takes hours.
    expect(fake.timeout).toBe(0)
  })

  it("reports progress only when the browser knows the length", () => {
    const fake = new FakeRequest()
    const seen: [number, number][] = []
    void putArchive({
      url,
      file,
      onProgress: (sent, total) => seen.push([sent, total]),
      createRequest: asRequest(fake),
    })
    fake.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 })
    fake.upload.onprogress?.({ lengthComputable: false, loaded: 7, total: 0 })
    expect(seen).toEqual([[5, 10]])
  })

  it("resolves on a 2xx", async () => {
    const fake = new FakeRequest()
    const sent = putArchive({
      url,
      file,
      onProgress: () => {},
      createRequest: asRequest(fake),
    })
    fake.status = 200
    fake.onload?.()
    await expect(sent).resolves.toBeUndefined()
  })

  it("rejects a refusal with storage's status", async () => {
    const fake = new FakeRequest()
    const sent = putArchive({
      url,
      file,
      onProgress: () => {},
      createRequest: asRequest(fake),
    })
    fake.status = 403
    fake.onload?.()
    const error = await sent.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UploadError)
    expect(error).toMatchObject({ kind: "refused", status: 403 })
  })

  it("rejects a dropped connection as a network failure", async () => {
    const fake = new FakeRequest()
    const sent = putArchive({
      url,
      file,
      onProgress: () => {},
      createRequest: asRequest(fake),
    })
    fake.onerror?.()
    await expect(sent).rejects.toMatchObject({ kind: "network" })
  })

  it("aborts the request when the signal fires, and says it was cancelled", async () => {
    const fake = new FakeRequest()
    const controller = new AbortController()
    const sent = putArchive({
      url,
      file,
      onProgress: () => {},
      signal: controller.signal,
      createRequest: asRequest(fake),
    })
    controller.abort()
    expect(fake.aborted).toBe(true)
    await expect(sent).rejects.toMatchObject({ kind: "aborted" })
  })

  it("does not open a request for a signal that is already aborted", async () => {
    const fake = new FakeRequest()
    const controller = new AbortController()
    controller.abort()
    const sent = putArchive({
      url,
      file,
      onProgress: () => {},
      signal: controller.signal,
      createRequest: asRequest(fake),
    })
    await expect(sent).rejects.toMatchObject({ kind: "aborted" })
    expect(fake.method).toBe("")
  })

  it("sends nothing over the network for a preview link, and still moves the bar", async () => {
    const seen: number[] = []
    await putArchive({
      url: `${PREVIEW_UPLOAD_PREFIX}upload/1000`,
      file: new Blob([new Uint8Array(1000)]),
      onProgress: (sent) => seen.push(sent),
      wait: async () => {},
    })
    expect(seen).toHaveLength(10)
    expect(seen.at(-1)).toBe(1000)
  })
})
