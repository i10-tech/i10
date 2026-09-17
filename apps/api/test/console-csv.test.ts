import { describe, expect, it } from "bun:test"
import { parseContactCsv } from "../src/console/marketing.js"

/**
 * The contact importer.
 *
 * ⚠ THIS IS THE ONE PIECE OF THE CONSOLE THAT PARSES SOMEBODY ELSE'S FILE, AND
 * ALMOST EVERY WAY IT CAN BE WRONG IS SILENT. A naive comma split turns
 * `"Smith, Jane"` into two broken rows and reports success. A missed byte order
 * mark makes the email column invisible for a file that looks completely normal
 * in every editor. A duplicate address inside one file makes Postgres refuse
 * the whole chunk rather than skip a row. Each of those has a test below
 * because none of them would produce an error anybody could see.
 */

describe("parseContactCsv", () => {
  it("reads the simple case", () => {
    const { rows, invalid } = parseContactCsv(
      "email,first name,last name\nbob@acme.com,Bob,Smith\n",
    )

    expect(invalid).toBe(0)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      email: "bob@acme.com",
      firstName: "Bob",
      lastName: "Smith",
    })
  })

  /**
   * ⚠ THE SINGLE MOST COMMON THING IN A CONTACTS EXPORT. Splitting on commas
   * turns this one person into two rows, both malformed, and the import
   * reports "2 contacts added".
   */
  it("keeps a quoted field containing a comma in one piece", () => {
    const { rows } = parseContactCsv(
      'email,name\njane@acme.com,"Smith, Jane"\n',
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.properties).toEqual({ name: "Smith, Jane" })
  })

  it("reads an escaped quote", () => {
    const { rows } = parseContactCsv('email,note\nbob@acme.com,"say ""hi"""\n')
    expect(rows[0]?.properties).toEqual({ note: 'say "hi"' })
  })

  /**
   * ⚠ EXCEL WRITES UTF-8 WITH A BYTE ORDER MARK. Left in, the first header
   * becomes "\uFEFFemail", the email column is never found, and the import
   * rejects a file that is visibly correct in every editor somebody would open
   * it in.
   */
  it("strips a byte order mark", () => {
    const { rows } = parseContactCsv("﻿email\nbob@acme.com\n")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.email).toBe("bob@acme.com")
  })

  it("reads CRLF line endings", () => {
    const { rows } = parseContactCsv("email\r\nbob@acme.com\r\njane@acme.com\r\n")
    expect(rows.map((r) => r.email)).toEqual(["bob@acme.com", "jane@acme.com"])
  })

  /**
   * ⚠ EVERY TOOL SPELLS THE COLUMN DIFFERENTLY. Mailchimp writes "Email
   * Address", HubSpot writes "Email", a hand-made sheet writes "e-mail".
   * Accepting only one makes the feature useless for the exact case it exists
   * for, which is moving off somebody else's product.
   */
  it.each([["email"], ["Email Address"], ["E-Mail"], ["MAIL"]])(
    "finds the address under the header %p",
    (header) => {
      const { rows } = parseContactCsv(`${header}\nbob@acme.com\n`)
      expect(rows).toHaveLength(1)
    },
  )

  /**
   * ⚠ NO EMAIL COLUMN MEANS THE FILE IS NOT A CONTACT LIST. Guessing "it is
   * probably the first column" is how somebody imports a list of first names as
   * addresses and cannot work out why nothing sends.
   */
  it("refuses a file with no recognisable email column", () => {
    const { rows, invalid } = parseContactCsv("name,company\nBob,Acme\nJane,Globex\n")
    expect(rows).toHaveLength(0)
    expect(invalid).toBe(2)
  })

  /**
   * ⚠ POSTGRES REFUSES AN INSERT WHOSE OWN VALUES LIST HITS THE SAME UNIQUE KEY
   * TWICE — "ON CONFLICT DO UPDATE command cannot affect row a second time". A
   * file containing one address twice would therefore fail the WHOLE chunk of
   * five hundred rather than skip one, so the dedupe has to happen here.
   */
  it("drops a duplicate address within the same file", () => {
    const { rows } = parseContactCsv(
      "email\nbob@acme.com\nBOB@ACME.COM\njane@acme.com\n",
    )
    expect(rows.map((r) => r.email)).toEqual(["bob@acme.com", "jane@acme.com"])
  })

  it("lowercases addresses, because the unique index is on the stored value", () => {
    const { rows } = parseContactCsv("email\n  Bob@Acme.COM \n")
    expect(rows[0]?.email).toBe("bob@acme.com")
  })

  it("counts rows it could not use rather than dropping them silently", () => {
    const { rows, invalid } = parseContactCsv(
      "email\nbob@acme.com\nnot-an-address\n\nno spaces here@acme.com\n",
    )
    expect(rows).toHaveLength(1)
    // The blank line is skipped rather than counted; the two malformed ones are.
    expect(invalid).toBe(2)
  })

  /**
   * ⚠ EVERY UNRECOGNISED COLUMN BECOMES A MERGE FIELD. That is what makes a
   * templated broadcast work without anybody declaring a schema first — and it
   * is why an import is worth doing at all rather than just pasting addresses.
   */
  it("turns unknown columns into merge fields", () => {
    const { rows } = parseContactCsv(
      "email,plan,seats\nbob@acme.com,pro,4\n",
    )
    expect(rows[0]?.properties).toEqual({ plan: "pro", seats: "4" })
  })

  it("leaves properties null when there are no extra columns", () => {
    const { rows } = parseContactCsv("email,first name\nbob@acme.com,Bob\n")
    expect(rows[0]?.properties).toBeNull()
  })

  it("handles an empty file and a header-only file", () => {
    expect(parseContactCsv("").rows).toHaveLength(0)
    expect(parseContactCsv("email\n").rows).toHaveLength(0)
  })

  it("reads a final row with no trailing newline", () => {
    const { rows } = parseContactCsv("email\nbob@acme.com")
    expect(rows).toHaveLength(1)
  })

  /**
   * ⚠ A COLUMN HEADING IS A PROPERTY NAME, AND IT ARRIVES FROM SOMEBODY ELSE'S
   * EXPORT. `POST /contact-properties` has always refused anything the merge-tag
   * syntax cannot address; the import did not, so a spreadsheet with an
   * `Order Total` column produced a property that is stored, displayed, and
   * unreferenceable from any template — a field that silently does nothing.
   */
  it("drops column headings that cannot be merge-tag names", () => {
    const { rows } = parseContactCsv(
      [
        "email,plan,Order Total,price(gbp),a_very_long_" + "x".repeat(60) + ",tier_2",
        "bob@acme.com,pro,199,12.50,nope,gold",
      ].join("\n"),
    )

    expect(rows[0]?.properties).toEqual({ plan: "pro", tier_2: "gold" })
  })

  /**
   * ⚠ AND A BAD COLUMN DOES NOT COST THE ROW. The contact and their address are
   * the point of an import; refusing ten thousand people over a "Notes
   * (internal)" column would be a far worse answer than dropping the column.
   */
  it("still imports the contact when every extra column is unusable", () => {
    const { rows, invalid } = parseContactCsv(
      ["email,Order Total", "bob@acme.com,199"].join("\n"),
    )

    expect(invalid).toBe(0)
    expect(rows).toEqual([
      { email: "bob@acme.com", firstName: null, lastName: null, properties: null },
    ])
  })
})
