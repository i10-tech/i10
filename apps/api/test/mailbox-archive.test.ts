import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zipSync } from "fflate"
import {
  LIMITS,
  manifestEntry,
  messagePaths,
  metaEntry,
  readArchive,
  type ArchiveLimits,
  type ImportItem,
  type ImportMessage,
} from "../src/mailboxes/archive.js"
import { ArchiveError, ByteReader } from "../src/mailboxes/bytes.js"
import { splitMbox } from "../src/mailboxes/mbox.js"
import { tarFiles, tarStream, type TarEntry } from "../src/mailboxes/tar.js"

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

/** A stream that hands `bytes` out in pieces of `size`, to find boundary bugs. */
function pieces(bytes: Uint8Array, size = 1000) {
  let at = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.byteLength) return controller.close()
      controller.enqueue(bytes.slice(at, at + size))
      at += size
    },
  })
}

async function* iterate(bytes: Uint8Array, size: number) {
  for (let at = 0; at < bytes.byteLength; at += size) yield bytes.slice(at, at + size)
}

const drain = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer())

async function* from<T>(items: T[]) {
  yield* items
}

const reader = (bytes: Uint8Array, size = 1000) =>
  new ByteReader(
    pieces(bytes, size),
    Infinity,
    () => new ArchiveError("archive_too_large", "x"),
  )

async function messagesOf(
  source: ReadableStream<Uint8Array>,
  limits: ArchiveLimits = LIMITS,
): Promise<{ messages: ImportMessage[]; items: ImportItem[] }> {
  const items: ImportItem[] = []
  for await (const item of readArchive(source, limits)) items.push(item)
  return {
    items,
    messages: items.flatMap((i) => (i.type === "message" ? [i.message] : [])),
  }
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof ArchiveError ? error.code : String(error)),
  )

const tarOf = (entries: TarEntry[]) => drain(tarStream(from(entries)))

const mail = (subject: string, body = "hello") =>
  enc(
    `From: a@x.test\r\nSubject: ${subject}\r\nDate: Fri, 01 May 2026 12:00:00 +0000\r\n\r\n${body}\r\n`,
  )

describe("tar, written and read", () => {
  it("round-trips entries, long non-ASCII names included, in any chunking", async () => {
    const longName = `Folder ${"é".repeat(120)}/0000001.eml`
    const entries: TarEntry[] = [
      { path: "a.eml", size: 3, body: enc("abc") },
      { path: longName, size: 700, body: enc("x".repeat(700)) },
      { path: "empty.eml", size: 0, body: new Uint8Array(0) },
    ]
    const archive = await tarOf(entries)
    expect(archive.byteLength % 512).toBe(0)

    for (const size of [1, 100, 511, 512, 513, 4096]) {
      const seen: [string, number][] = []
      for await (const file of tarFiles(reader(archive, size))) {
        let n = 0
        for await (const piece of file.body) n += piece.byteLength
        seen.push([file.path, n])
      }
      expect(seen).toEqual([
        ["a.eml", 3],
        [longName, 700],
        ["empty.eml", 0],
      ])
    }
  })

  it("skips what the caller did not read", async () => {
    const archive = await tarOf([
      { path: "one", size: 2000, body: enc("1".repeat(2000)) },
      { path: "two", size: 5, body: enc("hello") },
    ])
    const paths: string[] = []
    for await (const file of tarFiles(reader(archive, 300))) paths.push(file.path)
    expect(paths).toEqual(["one", "two"])
  })

  it("writes what the system tar reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "i10-tar-"))
    try {
      const file = join(dir, "x.tar")
      await writeFile(
        file,
        await tarOf([
          { path: "Inbox/0000001.eml", size: 5, body: enc("hello") },
          // Over the 100 bytes a plain header holds, so it travels as a pax record.
          { path: `Sent Items/${"long-".repeat(30)}.eml`, size: 3, body: enc("abc") },
        ]),
      )
      const listing = await new Response(
        Bun.spawn(["tar", "-tf", file], { stdout: "pipe", stderr: "pipe" }).stdout,
      ).text()
      expect(listing.trim().split("\n")).toEqual([
        "Inbox/0000001.eml",
        `Sent Items/${"long-".repeat(30)}.eml`,
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("has no entry limit: 70,000 files is past what a zip stream can count", async () => {
    const entries = Array.from({ length: 70_000 }, (_, i) => ({
      path: `f/${i}`,
      size: 1,
      body: new Uint8Array([97]),
    }))
    let count = 0
    for await (const file of tarFiles(reader(await tarOf(entries), 64 * 1024))) {
      count++
      for await (const piece of file.body) void piece
    }
    expect(count).toBe(70_000)
  })

  it("refuses a body that is not the declared size, before it can shift the archive", async () => {
    const longer = tarOf([{ path: "a", size: 2, body: enc("abc") }])
    const shorter = tarOf([{ path: "a", size: 5, body: enc("abc") }])
    expect(
      await longer.then(
        () => "ok",
        (e: Error) => e.message,
      ),
    ).toContain("more than the 2")
    expect(
      await shorter.then(
        () => "ok",
        (e: Error) => e.message,
      ),
    ).toContain("3 bytes written of 5")
  })
})

describe("the mbox splitter", () => {
  const mbox = enc(
    "From a@x.test Fri May  1 12:00:00 2026\n" +
      "Subject: one\n\nhello\n>From the start\n>>From deeper\n\n" +
      "From b@x.test Sat May  2 12:00:00 2026\n" +
      "Subject: two\n\nbye\n\n" +
      "From c@x.test Sun May  3 12:00:00 2026\n" +
      "Subject: three\n\nno trailing newline",
  )

  const split = async (bytes: Uint8Array, size: number, max = 1024 * 1024) => {
    const out: string[] = []
    for await (const m of splitMbox(iterate(bytes, size), max)) out.push(dec(m))
    return out
  }

  it("splits at separators, unquotes mboxrd, strips the blank line, makes CRLF", async () => {
    const expected = [
      "Subject: one\r\n\r\nhello\r\nFrom the start\r\n>From deeper\r\n",
      "Subject: two\r\n\r\nbye\r\n",
      "Subject: three\r\n\r\nno trailing newline",
    ]
    // One byte at a time is the worst case for a line that straddles chunks.
    for (const size of [1, 3, 7, 64, 100_000]) {
      expect(await split(mbox, size)).toEqual(expected)
    }
  })

  it("leaves the bytes of a message alone", async () => {
    const eightBit = new Uint8Array([
      ...enc("From x@x.test Fri May  1 12:00:00 2026\r\nSubject: caf"),
      0xe9,
      ...enc("\r\n\r\nbody "),
      0xff,
      0x00,
      0xfe,
      ...enc("\r\n"),
    ])
    const [message] = [] as Uint8Array[]
    void message
    const out: Uint8Array[] = []
    for await (const m of splitMbox(iterate(eightBit, 5), 1024)) out.push(m)
    expect(out).toHaveLength(1)
    expect([...out[0]!]).toEqual([
      ...enc("Subject: caf"),
      0xe9,
      ...enc("\r\n\r\nbody "),
      0xff,
      0x00,
      0xfe,
      ...enc("\r\n"),
    ])
  })

  it("fails a message over the cap, whatever the chunking", async () => {
    const big = enc(`From a@x.test x\nSubject: big\n\n${"x".repeat(5000)}\n`)
    for (const size of [10, 100_000]) {
      expect(await code(split(big, size, 1000))).toBe("message_too_large")
    }
  })
})

interface Sample {
  folder: string[]
  role: string | null
  keywords: Record<string, boolean>
  at: string | null
  content: Uint8Array
}

describe("reading an archive", () => {
  /** What the export writes, for the messages given. */
  async function exported(messages: Sample[], manifest = true) {
    const entries: TarEntry[] = []
    messages.forEach((m, i) => {
      const paths = messagePaths(m.folder, i + 1)
      entries.push(
        metaEntry(paths.meta, {
          folder: m.folder,
          role: m.role,
          keywords: m.keywords,
          received_at: m.at,
        }),
      )
      entries.push({ path: paths.eml, size: m.content.byteLength, body: m.content })
    })
    if (manifest) {
      entries.push(
        manifestEntry({
          version: 1,
          exported_at: "2026-11-06T00:00:00Z",
          mailbox: "a@x.test",
          total_messages: messages.length,
          folders: [
            ...new Map(
              messages.map((m) => [
                m.folder.join("/"),
                { path: m.folder, role: m.role, total: 1 },
              ]),
            ).values(),
            { path: ["Empty"], role: null, total: 0 },
          ],
        }),
      )
    }
    return tarOf(entries)
  }

  const sample: Sample[] = [
    {
      folder: ["Inbox"],
      role: "inbox",
      keywords: { $seen: true },
      at: "2026-05-01T12:00:00Z",
      content: mail("one"),
    },
    {
      folder: ["Work", "2026"],
      role: null,
      keywords: { $flagged: true, $seen: false },
      at: "2026-05-02T09:30:00Z",
      content: mail("two"),
    },
  ]

  it("reads an i10 export back: folders, roles, flags, dates, bytes", async () => {
    const archive = await exported(sample)
    const gz = Bun.gzipSync(archive)
    for (const source of [archive, gz]) {
      const { messages, items } = await messagesOf(pieces(source, 777))
      expect(messages.map((m) => [m.folder, m.role, m.keywords, m.receivedAt])).toEqual(
        [
          [["Inbox"], "inbox", { $seen: true }, "2026-05-01T12:00:00Z"],
          [
            ["Work", "2026"],
            null,
            { $flagged: true, $seen: false },
            "2026-05-02T09:30:00Z",
          ],
        ],
      )
      expect(dec(messages[1]!.content)).toBe(dec(sample[1]!.content))
      const manifest = items.find((i) => i.type === "manifest")
      expect(
        manifest?.type === "manifest" && manifest.manifest.folders.map((f) => f.path),
      ).toContainEqual(["Empty"])
    }
  })

  it("calls a truncated export incomplete, not a short import", async () => {
    const full = await exported(sample)
    // Cut between entries, before export.json: reads cleanly, and says so.
    expect(await code(messagesOf(pieces(full.slice(0, 512 * 8))))).toBe(
      "archive_incomplete",
    )
    // Cut in the middle of an entry.
    expect(await code(messagesOf(pieces(full.slice(0, 512 * 8 + 100))))).toBe(
      "archive_invalid",
    )

    const noManifest = await exported(sample, false)
    expect(await code(messagesOf(pieces(noManifest)))).toBe("archive_incomplete")

    const entries: TarEntry[] = [
      manifestEntry({
        version: 1,
        exported_at: "",
        mailbox: "a@x.test",
        total_messages: 5,
        folders: [],
      }),
    ]
    expect(await code(messagesOf(pieces(await tarOf(entries))))).toBe(
      "archive_incomplete",
    )
  })

  it("reads a Google Takeout zip of mbox files, and a folder of emls", async () => {
    const takeout = zipSync({
      "Takeout/Mail/Inbox.mbox": enc(
        "From a@x.test x\nSubject: one\nDate: Fri, 01 May 2026 12:00:00 +0000\n\nhi\n\nFrom b@x.test x\nSubject: two\n\nyo\n",
      ),
      "Takeout/Mail/Sent.mbox": enc("From c@x.test x\nSubject: three\n\nsent\n"),
      "Takeout/archive_browser.html": enc("<html>"),
      "__MACOSX/._junk": enc("junk"),
    })
    const { messages } = await messagesOf(pieces(takeout, 100))
    expect(messages.map((m) => [m.folder, dec(m.content).split("\r\n")[0]])).toEqual([
      [["Inbox"], "Subject: one"],
      [["Inbox"], "Subject: two"],
      [["Sent"], "Subject: three"],
    ])
    expect(messages[0]!.receivedAt).toBe("2026-05-01T12:00:00.000Z")
    expect(messages[0]!.keywords).toEqual({ $seen: true })

    const emls = zipSync({
      "Archive/Old/a.eml": mail("a"),
      "Archive/Old/b.eml": mail("b"),
      "c.eml": mail("c"),
    })
    const read = await messagesOf(pieces(emls, 50))
    expect(read.messages.map((m) => m.folder)).toEqual([
      ["Archive", "Old"],
      ["Archive", "Old"],
      [],
    ])
  })

  it("reads a tar.gz of mbox files and a bare mbox", async () => {
    const tgz = Bun.gzipSync(
      await tarOf([
        {
          path: "Mail/Inbox.mbox",
          size: 40,
          body: enc("From a@x.test x\nSubject: one\n\nhi\n".padEnd(40, "\n")),
        },
      ]),
    )
    expect((await messagesOf(pieces(tgz))).messages.map((m) => m.folder)).toEqual([
      ["Inbox"],
    ])

    const bare = await messagesOf(pieces(enc("From a@x.test x\nSubject: s\n\nb\n")))
    expect(bare.messages.map((m) => m.folder)).toEqual([["INBOX"]])
  })

  it("rejects what is not an archive", async () => {
    expect(await code(messagesOf(pieces(enc("just some text, not mail"))))).toBe(
      "archive_invalid",
    )
    expect(
      await code(messagesOf(pieces(zipSync({ "a.eml": mail("a") }).slice(0, 60)))),
    ).toBe("archive_invalid")
  })

  it("fails a message over the cap by name, in an eml, an mbox and an i10 export", async () => {
    const limits = { ...LIMITS, maxMessageBytes: 2000 }
    const big = enc(`Subject: big\r\n\r\n${"x".repeat(5000)}\r\n`)

    const eml = await messagesOf(
      pieces(zipSync({ "Big/huge.eml": big })),
      limits,
    ).catch((e: ArchiveError) => e)
    expect(eml).toBeInstanceOf(ArchiveError)
    expect((eml as ArchiveError).code).toBe("message_too_large")
    expect((eml as ArchiveError).message).toContain("Big/huge.eml")

    const mboxZip = zipSync({
      "Mail/Inbox.mbox": enc(`From a@x.test x\nSubject: big\n\n${"x".repeat(5000)}\n`),
    })
    expect(await code(messagesOf(pieces(mboxZip), limits))).toBe("message_too_large")

    const tar = await exported([{ ...sample[0]!, content: big }])
    expect(await code(messagesOf(pieces(tar), limits))).toBe("message_too_large")
  })

  it("fails an archive over the cap on the bytes that arrive, and a bomb on what it unpacks to", async () => {
    const archive = await exported(sample)
    expect(
      await code(messagesOf(pieces(archive), { ...LIMITS, maxArchiveBytes: 1000 })),
    ).toBe("archive_too_large")

    // A few kilobytes of gzip that unpack to megabytes.
    const bomb = Bun.gzipSync(
      await tarOf([
        {
          path: "Mail/Inbox.mbox",
          size: 4 * 1024 * 1024,
          body: new Uint8Array(4 * 1024 * 1024),
        },
      ]),
    )
    expect(bomb.byteLength).toBeLessThan(10_000)
    expect(
      await code(
        messagesOf(pieces(bomb), { ...LIMITS, maxUnpackedBytes: 1024 * 1024 }),
      ),
    ).toBe("archive_too_large")
  })
})
