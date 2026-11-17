import type { UploadFailure } from "@/lib/mailbox-transfer"

/**
 * Sends an import archive straight to storage, from the browser (U7).
 *
 * ⚠ THE REQUEST IS EXACTLY `PUT <url>` WITH ONE HEADER, `Content-Type`, AND NO
 * CREDENTIALS. The bucket's CORS rule allows only `PUT` from the console's
 * origin with that single header, and anything else (an `Authorization`, an
 * `x-amz-*`, a cookie) makes the browser's preflight fail before a byte moves.
 * The link is presigned for `host` alone (`presignPut`,
 * apps/api/src/content/object-store.ts), so the content type is not part of the
 * signature and any value passes; one fixed value keeps the request the same
 * whatever the file is called.
 *
 * ⚠ XMLHttpRequest AND NOT fetch, FOR THE PROGRESS. `fetch` has no upload
 * progress in any browser that ships today; the gigabytes this carries need a
 * bar that moves.
 */

export const UPLOAD_CONTENT_TYPE = "application/octet-stream"

/** Preview mode's links begin with this and are "sent" by a timer, not the network. */
export const PREVIEW_UPLOAD_PREFIX = "preview:"

export class UploadError extends Error {
  constructor(
    readonly kind: UploadFailure,
    /** Storage's HTTP status for `refused`, else 0. */
    readonly status = 0,
  ) {
    super(`upload ${kind}${status ? ` (${status})` : ""}`)
    this.name = "UploadError"
  }
}

export interface PutOptions {
  url: string
  file: Blob
  /** Bytes sent so far, out of the file's size. */
  onProgress: (sent: number, total: number) => void
  signal?: AbortSignal
  /** For tests, which have no XMLHttpRequest. */
  createRequest?: () => XMLHttpRequest
  /** For preview mode's timer-driven send. */
  wait?: (ms: number) => Promise<void>
}

export function putArchive(options: PutOptions): Promise<void> {
  if (options.url.startsWith(PREVIEW_UPLOAD_PREFIX)) return simulatePut(options)
  const { url, file, onProgress, signal } = options

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadError("aborted"))
    const request = options.createRequest?.() ?? new XMLHttpRequest()

    const onAbort = () => request.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    const settle = (finish: () => void) => {
      signal?.removeEventListener("abort", onAbort)
      finish()
    }

    request.open("PUT", url)
    request.setRequestHeader("Content-Type", UPLOAD_CONTENT_TYPE)
    // ⚠ NO TIMEOUT: a 4 GB file on a slow line takes hours, and the link itself
    // is what expires (six hours).
    request.timeout = 0

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total)
    }
    request.onload = () =>
      settle(() =>
        request.status >= 200 && request.status < 300
          ? resolve()
          : reject(new UploadError("refused", request.status)),
      )
    request.onerror = () => settle(() => reject(new UploadError("network")))
    request.ontimeout = () => settle(() => reject(new UploadError("network")))
    request.onabort = () => settle(() => reject(new UploadError("aborted")))

    request.send(file)
  })
}

/** Ten steps over about two seconds: enough to see the bar, never the network. */
async function simulatePut({
  file,
  onProgress,
  signal,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: PutOptions): Promise<void> {
  const total = file.size
  const steps = 10
  for (let step = 1; step <= steps; step++) {
    if (signal?.aborted) throw new UploadError("aborted")
    await wait(200)
    onProgress(Math.round((total * step) / steps), total)
  }
}
