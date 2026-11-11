/**
 * RFC 4180 CSV as a row generator: quoted fields may hold commas, quotes ("")
 * and newlines, rows end at CRLF or LF, a leading BOM is ignored. A stray quote
 * in an unquoted field is kept as text, and an unterminated quoted field ends at
 * end of input instead of throwing.
 */
export function* parseCsv(input: string): Generator<string[]> {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  let row: string[] = []
  let field = ""
  let quoted = false
  let touched = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"' && field === "") {
      quoted = true
      touched = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
      touched = true
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      if (touched || field !== "") {
        row.push(field)
        yield row
      }
      row = []
      field = ""
      touched = false
    } else {
      field += ch
      touched = true
    }
  }
  if (touched || field !== "") {
    row.push(field)
    yield row
  }
}

/** Rows keyed by the header row; rows shorter than the header read as "". */
export function* parseCsvRecords(input: string): Generator<Record<string, string>> {
  let header: string[] | undefined
  for (const row of parseCsv(input)) {
    if (header === undefined) {
      header = row.map((h) => h.trim().toLowerCase())
      continue
    }
    const record: Record<string, string> = {}
    header.forEach((name, i) => {
      record[name] = row[i] ?? ""
    })
    yield record
  }
}
