/**
 * Reading somebody else's contacts export.
 *
 * ⚠ THIS IS A PARSER FOR FILES WE DID NOT WRITE, SO IT IS FORGIVING IN EXACTLY
 * THE WAYS REAL EXPORTS ARE MALFORMED — a byte-order mark from Excel, CRLF line
 * endings, a quoted field containing a comma or a newline, the same address
 * twice, and four different spellings of the email column. Every one of those
 * is a file somebody will actually upload, and refusing it means telling a
 * customer their contacts are wrong when the truth is that Mailchimp writes
 * "Email Address" and HubSpot writes "Email".
 *
 * ⚠ AND IT IS PURE, WHICH IS WHY IT IS ITS OWN MODULE. It takes a string and
 * returns rows; it touches no database and no clock, so the whole of its
 * behaviour is pinned by tests that run in milliseconds.
 */

/**
 * A CSV reader for contact imports.
 *
 * ⚠ IT PARSES RFC 4180 QUOTING RATHER THAN SPLITTING ON COMMAS, because the
 * single most common thing in a contacts export is `"Smith, Jane"`. A naive
 * split turns that one person into two broken rows and the import reports
 * success.
 *
 * ⚠ AND IT IS DELIBERATELY NOT A CSV LIBRARY. The API has no CSV dependency and
 * adding one to read a five-column file is a supply-chain surface for fifty
 * lines of code. What it does NOT handle is a stream — the whole file is in
 * memory, which is why the route caps the upload size rather than letting
 * somebody post a gigabyte.
 */
export function parseContactCsv(input: string): {
  rows: {
    email: string
    firstName: string | null
    lastName: string | null
    properties: Record<string, unknown> | null
  }[]
  invalid: number
} {
  const records = parseCsv(input)
  if (records.length === 0) return { rows: [], invalid: 0 }

  const header = (records[0] ?? []).map((h) => h.trim().toLowerCase())

  // ⚠ SEVERAL SPELLINGS PER COLUMN, BECAUSE EVERY TOOL EXPORTS A DIFFERENT ONE.
  // Mailchimp writes "Email Address", HubSpot writes "Email", a hand-made sheet
  // writes "e-mail". Accepting only one would make the feature useless for the
  // exact case it exists for — moving off somebody else's product.
  const emailIdx = findColumn(header, ["email", "email address", "e-mail", "mail"])
  const firstIdx = findColumn(header, ["first name", "firstname", "first", "given name"])
  const lastIdx = findColumn(header, [
    "last name",
    "lastname",
    "last",
    "surname",
    "family name",
  ])

  // ⚠ NO EMAIL COLUMN MEANS THE FILE IS NOT A CONTACT LIST. Guessing "it is
  // probably the first column" is how somebody imports a list of first names as
  // addresses and cannot work out why nothing sends.
  if (emailIdx === -1) return { rows: [], invalid: Math.max(records.length - 1, 0) }

  const rows: ReturnType<typeof parseContactCsv>["rows"] = []
  let invalid = 0
  const seen = new Set<string>()

  for (let i = 1; i < records.length; i++) {
    const record = records[i]
    if (!record || record.every((c) => c.trim() === "")) continue

    const email = (record[emailIdx] ?? "").trim().toLowerCase()
    if (!isEmailish(email)) {
      invalid++
      continue
    }

    /*
     * ⚠ DEDUPED WITHIN THE FILE ITSELF, AND `onConflictDoUpdate` CANNOT DO IT
     * FOR US. Postgres refuses a single INSERT whose own VALUES list hits the
     * same unique key twice — "ON CONFLICT DO UPDATE command cannot affect row a
     * second time" — so a file containing one address twice would fail the whole
     * chunk rather than skip a row. Duplicates inside a CSV are common enough
     * that this is a correctness requirement, not a nicety.
     */
    if (seen.has(email)) continue
    seen.add(email)

    /*
     * Every column that is not one of the three known ones becomes a merge
     * field, which is what makes templated broadcasts work without a schema.
     *
     * ⚠ THE COLUMN NAME HAS TO SURVIVE `PROPERTY_KEY`, THE SAME RULE
     * `POST /contact-properties` ENFORCES. It is the shape the merge-tag syntax
     * can address, so a column called `Order Total` or `price(£)` produces a
     * property that is stored, shown in the contact drawer, and can never be
     * referenced from a template — a field that silently does nothing, created
     * by the one path that did not check. Importing is also where it is most
     * likely to happen, because the names come from somebody else's export.
     *
     * ⚠ AND AN UNUSABLE COLUMN IS SKIPPED RATHER THAN FAILING THE ROW. The
     * contact and their address are the point of the import; refusing ten
     * thousand people because a spreadsheet has a "Notes (internal)" column
     * would be a worse answer than dropping the column.
     */
    const extra: Record<string, unknown> = {}
    for (let c = 0; c < header.length; c++) {
      if (c === emailIdx || c === firstIdx || c === lastIdx) continue
      const key = header[c]
      const value = record[c]
      if (!key || !PROPERTY_KEY.test(key)) continue
      if (value !== undefined && value !== "") extra[key] = value
    }

    rows.push({
      email,
      firstName: firstIdx >= 0 ? record[firstIdx]?.trim() || null : null,
      lastName: lastIdx >= 0 ? record[lastIdx]?.trim() || null : null,
      properties: Object.keys(extra).length ? extra : null,
    })
  }

  return { rows, invalid }
}

/**
 * What a contact property may be called.
 *
 * ⚠ ONE DEFINITION, EXPORTED, BECAUSE THE RULE HAS TWO ENFORCEMENT POINTS.
 * `POST /contact-properties` declares a property by hand and a CSV import
 * invents one from a column heading; a copy of this pattern in each is a copy
 * that drifts, and the drift shows up as merge tags that resolve for properties
 * created one way and not the other.
 */
export const PROPERTY_KEY = /^[A-Za-z0-9_]{1,50}$/

function findColumn(header: string[], names: string[]): number {
  for (const name of names) {
    const idx = header.indexOf(name)
    if (idx !== -1) return idx
  }
  return -1
}

/**
 * ⚠ NOT A VALIDATOR — A FILTER. The only fully correct check for an address is
 * delivering to it, and every regex that claims otherwise rejects somebody's
 * real address. This rejects what is definitely not an address (no `@`, no dot
 * after it, whitespace) and lets the rest through to be suppressed by a bounce
 * if it is wrong, which is the mechanism that already exists.
 */
function isEmailish(value: string): boolean {
  if (!value || value.length > 254) return false
  if (/\s/.test(value)) return false
  const at = value.lastIndexOf("@")
  if (at <= 0 || at === value.length - 1) return false
  const domain = value.slice(at + 1)
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".")
}

/** RFC 4180: quoted fields, `""` as an escaped quote, CRLF or LF line endings. */
function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false

  // ⚠ THE BOM IS STRIPPED. Excel writes UTF-8 with a byte order mark, so the
  // first header becomes " email" and the email column is never found —
  // for a file that looks completely normal in every editor.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (ch === "\r") {
      // Swallowed; the \n that follows ends the row. A lone \r (classic Mac)
      // ends it here.
      if (text[i + 1] !== "\n") {
        row.push(field)
        rows.push(row)
        row = []
        field = ""
      }
    } else {
      field += ch
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}
