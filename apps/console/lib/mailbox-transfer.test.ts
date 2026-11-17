import { describe, expect, it } from "bun:test"
import {
  archiveProblem,
  exportView,
  flowFailureTitle,
  IMPORT_SOURCES,
  importFailureWords,
  importView,
  isActive,
  MAX_ARCHIVE_BYTES,
  nextImportStep,
  nextPollDelay,
  sniffArchive,
  transferRefusal,
  transferSnapshot,
  uploadFailureWords,
  uploadLine,
  uploadPercent,
  type JobRead,
  type MailboxJob,
} from "./mailbox-transfer"

/** Built from its code, so this file does not contain the character it forbids. */
const EM_DASH = String.fromCharCode(0x2014)

const NOW = Date.parse("2026-11-17T12:00:00Z")

function job(fields: Partial<MailboxJob> = {}): MailboxJob {
  return {
    object: "mailbox_job",
    id: "job_1",
    mailbox_address: "alice@acme.dev",
    type: "import",
    status: "running",
    progress: {
      total_messages: 0,
      processed_messages: 0,
      total_folders: 0,
      processed_folders: 0,
    },
    created_at: "2026-11-17T10:00:00Z",
    ...fields,
  }
}

const withProgress = (processed: number, total = 0, folders = 0) => ({
  total_messages: total,
  processed_messages: processed,
  total_folders: 0,
  processed_folders: folders,
})

/** 512 bytes with `text` at `at`, as the first block of a file. */
function head(text: string, at = 0, length = 512): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set(new TextEncoder().encode(text), at)
  return bytes
}

describe("sniffArchive", () => {
  it("knows a zip, a gzip, a tar and an mbox by their first bytes", () => {
    expect(sniffArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("zip")
    expect(sniffArchive(new Uint8Array([0x1f, 0x8b, 8]))).toBe("gzip")
    expect(sniffArchive(head("ustar", 257))).toBe("tar")
    expect(sniffArchive(head("From alice@acme.dev Mon Nov 17 12:00:00 2026\n"))).toBe(
      "mbox",
    )
  })

  it("does not take a short block for a tar, as the API's reader does not", () => {
    expect(sniffArchive(head("ustar", 257, 300))).toBeNull()
  })

  it("refuses anything else", () => {
    expect(sniffArchive(head("%PDF-1.7"))).toBeNull()
    expect(sniffArchive(new Uint8Array(0))).toBeNull()
  })
})

describe("archiveProblem", () => {
  const mbox = head("From a@b.dev Mon\n")

  it("lets a valid file through whatever it is called", () => {
    expect(
      archiveProblem(
        { name: "takeout.zip", size: 2_000_000 },
        new Uint8Array([0x50, 0x4b, 3, 4]),
      ),
    ).toBeNull()
    // Thunderbird's folder files have no extension.
    expect(archiveProblem({ name: "Inbox", size: 4096 }, mbox)).toBeNull()
  })

  it("refuses an empty file", () => {
    expect(archiveProblem({ name: "a.mbox", size: 0 }, mbox)).toBe(
      "That file is empty.",
    )
  })

  it("refuses a file over the limit and says how big it was", () => {
    const problem = archiveProblem(
      { name: "big.zip", size: MAX_ARCHIVE_BYTES + 1 },
      mbox,
    )
    expect(problem).toContain("4.0 GB")
    expect(problem).toContain("Split it")
  })

  it("explains an Outlook data file instead of saying 'invalid'", () => {
    expect(
      archiveProblem({ name: "Archive.PST", size: 10_000 }, head("!BDN")),
    ).toContain("Outlook data file")
  })

  it("tells a lone message to be zipped", () => {
    expect(
      archiveProblem({ name: "note.eml", size: 900 }, head("Received: x")),
    ).toContain("single message")
  })

  it("names the kinds that do work for any other file", () => {
    expect(
      archiveProblem({ name: "photo.jpg", size: 9000 }, head("\xff\xd8")),
    ).toContain("zip, tar, tar.gz or mbox")
  })
})

describe("nextImportStep", () => {
  const reserved = (expiresInMs: number, uploaded = false) => ({
    uploaded,
    job: job({
      status: "awaiting_upload",
      upload: {
        url: "https://r2.example/obj",
        method: "PUT" as const,
        expires_at: new Date(NOW + expiresInMs).toISOString(),
      },
    }),
  })

  it("reserves when there is nothing yet", () => {
    expect(nextImportStep(undefined, NOW)).toBe("reserve")
  })

  it("sends the file again on a link that still has time", () => {
    expect(nextImportStep(reserved(3_600_000), NOW)).toBe("upload")
  })

  it("reserves anew when the link is gone or about to be", () => {
    expect(nextImportStep(reserved(-1000), NOW)).toBe("reserve")
    expect(nextImportStep(reserved(30_000), NOW)).toBe("reserve")
  })

  it("only starts when the file already arrived, even on an expired link", () => {
    expect(nextImportStep(reserved(-1000, true), NOW)).toBe("start")
  })

  it("reserves anew when the reservation carries no link", () => {
    expect(nextImportStep({ uploaded: false, job: job() }, NOW)).toBe("reserve")
  })
})

describe("nextPollDelay", () => {
  it("polls every three seconds while the tab is shown", () => {
    expect(nextPollDelay({ visible: true, failures: 0 })).toBe(3000)
  })

  it("asks nothing while the tab is hidden, however many reads failed", () => {
    expect(nextPollDelay({ visible: false, failures: 0 })).toBeNull()
    expect(nextPollDelay({ visible: false, failures: 5 })).toBeNull()
  })

  it("backs off after failures, doubling up to thirty seconds, and never gives up", () => {
    expect(nextPollDelay({ visible: true, failures: 1 })).toBe(6000)
    expect(nextPollDelay({ visible: true, failures: 2 })).toBe(12_000)
    expect(nextPollDelay({ visible: true, failures: 3 })).toBe(24_000)
    expect(nextPollDelay({ visible: true, failures: 4 })).toBe(30_000)
    expect(nextPollDelay({ visible: true, failures: 40 })).toBe(30_000)
  })
})

describe("isActive", () => {
  it("is true only while a job is queued or running", () => {
    expect(isActive(job({ status: "pending" }))).toBe(true)
    expect(isActive(job({ status: "running" }))).toBe(true)
    expect(isActive(job({ status: "awaiting_upload" }))).toBe(false)
    expect(isActive(job({ status: "completed" }))).toBe(false)
    expect(isActive(job({ status: "failed" }))).toBe(false)
    expect(isActive(null)).toBe(false)
  })
})

describe("transferSnapshot", () => {
  const found = (data: MailboxJob): JobRead => ({ ok: true, data })
  const missing = (statusCode: number): JobRead => ({
    ok: false,
    error: { statusCode },
  })

  it("carries both jobs, and treats 404 as never run", () => {
    expect(transferSnapshot(found(job({ type: "export" })), missing(404))).toEqual({
      state: "ok",
      export: job({ type: "export" }),
      import: null,
    })
    expect(transferSnapshot(missing(404), missing(404))).toEqual({
      state: "ok",
      export: null,
      import: null,
    })
  })

  it("hides the section on a 403 and says so on a 501", () => {
    expect(transferSnapshot(missing(403), missing(403)).state).toBe("forbidden")
    expect(transferSnapshot(missing(501), missing(404)).state).toBe("unavailable")
  })

  it("keeps the buttons but says it could not read, for any other failure", () => {
    expect(transferSnapshot(missing(500), missing(404)).state).toBe("unreadable")
  })
})

describe("exportView", () => {
  it("shows nothing before a first export", () => {
    expect(exportView(null)).toEqual({ kind: "none" })
  })

  it("shows the count and percent while it runs", () => {
    const view = exportView(
      job({ type: "export", status: "running", progress: withProgress(1200, 5000) }),
    )
    expect(view).toEqual({
      kind: "running",
      percent: 24,
      line: "1,200 of 5,000 messages",
    })
  })

  it("has no percent until the total is known", () => {
    expect(exportView(job({ type: "export", status: "pending" }))).toEqual({
      kind: "running",
      percent: null,
      line: "Starting",
    })
  })

  it("is ready with its expiry a week after it finished, when the link is there", () => {
    const view = exportView(
      job({
        type: "export",
        status: "completed",
        completed_at: "2026-11-10T12:00:00.000Z",
        download_url: "/mailboxes/a/export/download?token=t",
      }),
    )
    expect(view).toEqual({ kind: "ready", expiresAt: "2026-11-17T12:00:00.000Z" })
  })

  it("is expired when a finished export has no link", () => {
    expect(
      exportView(job({ type: "export", status: "completed", download_url: null })),
    ).toEqual({ kind: "expired" })
  })

  it("fails in plain words, and says what to do for a mail server fault", () => {
    const generic = exportView(job({ type: "export", status: "failed" }))
    const stalwart = exportView(
      job({ type: "export", status: "failed", error_code: "stalwart" }),
    )
    expect(generic).toEqual({
      kind: "failed",
      message: "The export did not finish. Try again.",
    })
    expect(stalwart.kind === "failed" && stalwart.message).toContain("mail server")
  })
})

describe("importView", () => {
  it("is unfinished when the file never arrived", () => {
    expect(importView(job({ status: "awaiting_upload" }))).toEqual({
      kind: "unfinished",
    })
  })

  it("shows messages and folders so far while it runs", () => {
    expect(
      importView(job({ status: "running", progress: withProgress(300, 0, 2) })),
    ).toEqual({
      kind: "running",
      percent: null,
      line: "300 messages so far",
      folders: "2 folders so far",
    })
    expect(
      importView(job({ status: "running", progress: withProgress(1, 0, 1) })),
    ).toMatchObject({ line: "1 message so far", folders: "1 folder so far" })
  })

  it("says what was imported, and carries the skipped note", () => {
    expect(
      importView(
        job({
          status: "completed",
          progress: withProgress(2400, 0, 5),
          error: "3 messages were skipped because the mail server would not take them.",
          error_code: "skipped_messages",
        }),
      ),
    ).toEqual({
      kind: "done",
      headline: "Imported 2,400 messages into 5 folders.",
      note: "3 messages were skipped because the mail server would not take them.",
    })
  })

  it("never shows a raw error on a completed import that is not a skip note", () => {
    const view = importView(
      job({
        status: "completed",
        progress: withProgress(1),
        error: "internal",
        error_code: "x",
      }),
    )
    expect(view).toMatchObject({ kind: "done", note: null })
  })
})

describe("importFailureWords", () => {
  const failed = (code: string, processed = 0, error: string | null = null) =>
    importFailureWords(
      job({
        status: "failed",
        error_code: code,
        error,
        progress: withProgress(processed),
      }),
    )

  it("tells a bad file to be chosen again", () => {
    expect(failed("archive_invalid").title).toBe("We could not read that file")
  })

  it("says how much was imported before it stopped", () => {
    expect(failed("over_quota", 1234).advice).toContain("1,234 messages were imported")
    expect(failed("over_quota", 0).advice).not.toContain("were imported before")
  })

  it("warns that importing the same file again can add messages twice, and never promises otherwise", () => {
    const advice = failed("stalwart", 10).advice
    expect(advice).toContain("a second time")
    expect(advice).not.toContain("not added twice")
  })

  it("keeps the worker's own sentence as a detail where it helps, and drops it where it does not", () => {
    expect(failed("message_too_large", 0, "Inbox/12.eml is over 50 MB").detail).toBe(
      "Inbox/12.eml is over 50 MB",
    )
    expect(failed("archive_invalid", 0, "that is not a zip").detail).toBeNull()
  })

  it("has a sentence for a code it does not know", () => {
    expect(failed("something_new").title).toBe("The import did not finish")
  })
})

describe("transferRefusal", () => {
  const refusal = (status: number, error = "", body?: Record<string, unknown>) => ({
    error,
    name: "x",
    status,
    body,
  })

  it("asks for the step-up in words when Clerk's hint comes back", () => {
    expect(transferRefusal(refusal(403, "", { clerk_error: {} }), "export")).toBe(
      "Confirm it is you, then try again.",
    )
  })

  it("names who may move a mailbox's mail on a 403", () => {
    expect(transferRefusal(refusal(403), "reserve")).toContain(
      "owner or a workspace admin",
    )
  })

  it("is specific about a start that found no file", () => {
    expect(transferRefusal(refusal(409), "start")).toBe(
      "The file did not finish uploading. Choose it again.",
    )
  })

  it("never shows a status code or a stack", () => {
    for (const status of [400, 401, 404, 409, 413, 422, 429, 500, 502, 503, 501]) {
      for (const step of ["export", "reserve", "start"] as const) {
        const words = transferRefusal(refusal(status), step)
        expect(words).not.toMatch(/\b[45]\d\d\b/)
        // ⚠ A LONE FULL STOP is what an empty API message used to become on a 409.
        expect(words.length).toBeGreaterThan(10)
        expect(words).toEndWith(".")
      }
    }
  })

  it("passes the API's own sentence through, with one full stop", () => {
    expect(transferRefusal(refusal(422, "The size must be positive"), "reserve")).toBe(
      "The size must be positive.",
    )
  })
})

describe("upload words and numbers", () => {
  it("says what each kind of failed send means and what to do", () => {
    expect(uploadFailureWords("aborted", 0)).toBe("The upload was cancelled.")
    expect(uploadFailureWords("network", 0)).toContain("connection dropped")
    expect(uploadFailureWords("refused", 403)).toContain("link has expired")
    expect(uploadFailureWords("refused", 500)).toContain("did not accept")
  })

  it("holds the bar below 100 until the last byte has gone", () => {
    expect(uploadPercent(0, 1000)).toBe(0)
    expect(uploadPercent(999, 1000)).toBe(99)
    expect(uploadPercent(1000, 1000)).toBe(100)
    expect(uploadPercent(5, 0)).toBe(0)
    expect(uploadPercent(2000, 1000)).toBe(100)
  })

  it("draws the line as bytes of bytes, never past the total", () => {
    expect(uploadLine(512 * 1024 * 1024, 1024 ** 3)).toBe("512.0 MB of 1.0 GB")
    expect(uploadLine(2048, 1024)).toBe("1.0 KB of 1.0 KB")
  })

  it("titles each failed step", () => {
    expect(flowFailureTitle("upload")).toBe("The upload did not finish")
    expect(flowFailureTitle("reserve")).toBe("Could not prepare the upload")
    expect(flowFailureTitle("start")).toBe("Could not start the import")
  })
})

describe("copy", () => {
  it("has no em dash anywhere in the import guidance", () => {
    for (const source of IMPORT_SOURCES) {
      expect(`${source.app} ${source.how}`).not.toContain(EM_DASH)
    }
  })

  it("covers the four apps, and is honest that Outlook's .pst cannot be read", () => {
    expect(IMPORT_SOURCES.map((source) => source.app)).toEqual([
      "Gmail",
      "Apple Mail",
      "Thunderbird",
      "Outlook",
    ])
    expect(IMPORT_SOURCES.at(-1)?.how).toContain("cannot be imported")
  })
})
