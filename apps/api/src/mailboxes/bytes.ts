/**
 * Byte plumbing for the mailbox archives (#385): a pull-based reader over a
 * stream, and a growable buffer with a ceiling.
 *
 * ⚠ BOTH EXIST SO THAT MEMORY IS BOUNDED BY ONE MESSAGE. A reader hands out the
 * chunk it holds and fetches the next only when asked, which is the backpressure
 * that lets a multi-gigabyte archive pass through a few megabytes; a builder
 * refuses to grow past its ceiling, which is what turns a hostile or corrupt
 * archive into a clear error and not an out-of-memory kill.
 */

export type ArchiveErrorCode =
  /** One message is over what Stalwart accepts. */
  | "message_too_large"
  /** The archive, or what it unpacks to, is over the cap. */
  | "archive_too_large"
  /** Not a zip, tar, tar.gz or mbox, or damaged. */
  | "archive_invalid"
  /** An i10 export that stops before its end marker. */
  | "archive_incomplete"

export class ArchiveError extends Error {
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ArchiveError"
  }
}

export const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** A stream over what a reader has not consumed yet, for piping onwards. */
export function streamOf(
  chunks: AsyncIterator<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await chunks.return?.(undefined)
    },
  })
}

export class ByteReader {
  private readonly reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array }>
    cancel(): Promise<void>
  }
  private buf: Uint8Array = new Uint8Array(0)
  private ended = false
  private total = 0

  /**
   * @param limit  the most this reader will read from the stream, checked as
   *               chunks arrive and not from any length the sender declared.
   */
  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly limit: number,
    private readonly overLimit: () => ArchiveError,
  ) {
    this.reader = stream.getReader()
  }

  private async fill(): Promise<boolean> {
    if (this.ended) return false
    const { value, done } = await this.reader.read()
    if (done || !value) {
      this.ended = true
      return false
    }
    this.total += value.byteLength
    if (this.total > this.limit) {
      await this.reader.cancel().catch(() => {})
      throw this.overLimit()
    }
    this.buf = value
    return true
  }

  /** Up to `n` bytes from the front, left in place. */
  async peek(n: number): Promise<Uint8Array> {
    while (this.buf.byteLength < n) {
      const held = this.buf
      this.buf = new Uint8Array(0)
      const more = await this.fill()
      this.buf = more ? concat([held, this.buf]) : held
      if (!more) break
    }
    return this.buf.subarray(0, n)
  }

  /** Exactly `n` bytes, or `null` at a clean end of the stream. */
  async readExact(n: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(n)
    let got = 0
    while (got < n) {
      if (this.buf.byteLength === 0 && !(await this.fill())) {
        if (got === 0) return null
        throw new ArchiveError(
          "archive_invalid",
          "the archive ends in the middle of an entry",
        )
      }
      const take = Math.min(n - got, this.buf.byteLength)
      out.set(this.buf.subarray(0, take), got)
      got += take
      this.buf = this.buf.subarray(take)
    }
    return out
  }

  /**
   * The next `n` bytes, in the pieces they arrive in.
   *
   * ⚠ THE PIECES ARE VIEWS INTO THE STREAM'S OWN CHUNKS. Copy what has to
   * outlive the next `await`.
   */
  async *take(n: number): AsyncGenerator<Uint8Array> {
    let left = n
    while (left > 0) {
      if (this.buf.byteLength === 0 && !(await this.fill())) {
        throw new ArchiveError(
          "archive_invalid",
          "the archive ends in the middle of an entry",
        )
      }
      const take = Math.min(left, this.buf.byteLength)
      const piece = this.buf.subarray(0, take)
      this.buf = this.buf.subarray(take)
      left -= take
      yield piece
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.take(n)) void _
  }

  /** Everything not yet consumed. */
  async *rest(): AsyncGenerator<Uint8Array> {
    while (true) {
      if (this.buf.byteLength === 0 && !(await this.fill())) return
      const piece = this.buf
      this.buf = new Uint8Array(0)
      yield piece
    }
  }
}

export class ByteBuilder {
  private bytes = new Uint8Array(0)
  length = 0

  constructor(
    private readonly max: number,
    private readonly overflow: () => Error,
  ) {}

  append(piece: Uint8Array): void {
    const need = this.length + piece.byteLength
    if (need > this.max) throw this.overflow()
    if (need > this.bytes.byteLength) {
      const grown = new Uint8Array(
        Math.min(this.max, Math.max(need, this.bytes.byteLength * 2)),
      )
      grown.set(this.bytes.subarray(0, this.length))
      this.bytes = grown
    }
    this.bytes.set(piece, this.length)
    this.length = need
  }

  view(): Uint8Array {
    return this.bytes.subarray(0, this.length)
  }

  /** A copy of what is held, and the builder empty again. */
  take(): Uint8Array {
    const out = this.bytes.slice(0, this.length)
    this.reset()
    return out
  }

  reset(): void {
    this.length = 0
    // A builder that once held a 50 MB message must not pin it for the rest of
    // a job made of small ones.
    if (this.bytes.byteLength > 4 * 1024 * 1024) this.bytes = new Uint8Array(0)
  }
}
