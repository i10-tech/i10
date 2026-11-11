/**
 * Splits an mbox into raw messages without interpreting any of them.
 *
 * A message starts at a line `From <sender> <weekday> <month> <day> <hh:mm>...`.
 * The time token is what keeps a body line such as "From the desk of ..." from
 * being taken for a separator. The separator line itself is dropped.
 */
const FROM_LINE = /^From \S+\s+\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}/

export function* splitMbox(raw: string): Generator<string> {
  let start = -1
  let pos = 0
  while (pos < raw.length) {
    let eol = raw.indexOf("\n", pos)
    if (eol === -1) eol = raw.length
    if (
      raw.startsWith("From ", pos) &&
      FROM_LINE.test(raw.slice(pos, Math.min(eol, pos + 200)))
    ) {
      if (start !== -1) {
        const message = raw.slice(start, pos)
        if (message.trim() !== "") yield message
      }
      start = eol + 1
    }
    pos = eol + 1
  }
  if (start !== -1 && start < raw.length) {
    const message = raw.slice(start)
    if (message.trim() !== "") yield message
  }
}
