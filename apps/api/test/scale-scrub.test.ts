import { describe, expect, it } from "bun:test"
import {
  columnKey,
  formatArray,
  kindFor,
  leaks,
  parseArray,
  scrub,
  type ColumnKinds,
} from "../scripts/scale/scrub.js"

/** One attribute-stats call as pg_dump 18 writes it. */
const attr = (rel: string, att: string, extra: [string, string, string][]) =>
  [
    "SELECT * FROM pg_catalog.pg_restore_attribute_stats(",
    "\t'version', '180006'::integer,",
    "\t'schemaname', 'core',",
    `\t'relname', '${rel}',`,
    `\t'attname', '${att}',`,
    "\t'inherited', 'f'::boolean,",
    "\t'null_frac', '0'::real,",
    "\t'avg_width', '19'::integer,",
    ...extra.map(
      ([k, v, t], i) =>
        `\t'${k}', '${v.replace(/'/g, "''")}'::${t}${i === extra.length - 1 ? "" : ","}`,
    ),
    ");",
  ].join("\n")

const TENANT_A = "0190a1b2-0000-7000-8000-000000000001"
const TENANT_B = "0190a1b2-0000-7000-8000-000000000002"

const DUMP = [
  "\\restrict abc",
  "SET statement_timeout = 0;",
  attr("accounts", "email", [
    ["n_distinct", "-1", "real"],
    ["histogram_bounds", `{amira@acme.com,"o'brien@globex.io",zoë@example.de}`, "text"],
    ["correlation", "0.1", "real"],
  ]),
  attr("messages", "tenant_id", [
    ["most_common_vals", `{${TENANT_A},${TENANT_B}}`, "text"],
    ["most_common_freqs", "{0.25,0.01}", "real[]"],
  ]),
  attr("api_keys", "tenant_id", [
    ["most_common_vals", `{${TENANT_B}}`, "text"],
    ["most_common_freqs", "{0.5}", "real[]"],
  ]),
  attr("messages", "attempts", [
    ["most_common_vals", "{1,0,5}", "text"],
    ["most_common_freqs", "{0.9,0.05,0.01}", "real[]"],
  ]),
  attr("messages", "headers", [
    ["most_common_vals", `{"{\\"X\\": 1}"}`, "text"],
    ["most_common_freqs", "{0.2}", "real[]"],
  ]),
  attr("messages", "to_addresses", [
    ["most_common_elems", "{bob@x.test,eve@y.test}", "text"],
    ["most_common_elem_freqs", "{0.1,0.1,0.1,0.1,1}", "real[]"],
  ]),
  "\\unrestrict abc",
].join("\n")

const KINDS: ColumnKinds = new Map([
  [columnKey("core", "accounts", "email"), { kind: "text", array: false }],
  [columnKey("core", "messages", "tenant_id"), { kind: "uuid", array: false }],
  [columnKey("core", "api_keys", "tenant_id"), { kind: "uuid", array: false }],
  [columnKey("core", "messages", "attempts"), { kind: "keep", array: false }],
  [columnKey("core", "messages", "headers"), { kind: "drop", array: false }],
  [columnKey("core", "messages", "to_addresses"), { kind: "text", array: true }],
])

/** The value of `key` in the call for `rel.att` of a scrubbed dump. */
function valueOf(
  sql: string,
  rel: string,
  att: string,
  key: string,
): string | undefined {
  const at = sql.indexOf(`'relname', '${rel}',\n\t'attname', '${att}'`)
  const end = sql.indexOf(");", at)
  const m = new RegExp(`'${key}', '((?:[^']|'')*)'`).exec(sql.slice(at, end))
  return m?.[1]!.replace(/''/g, "'")
}

describe("array literals", () => {
  it("round-trip quoting, NULL and empty strings", () => {
    const items = [
      "plain",
      "with space",
      'a"quote',
      "back\\slash",
      "",
      "NULL",
      null,
      "{brace}",
      "o'brien",
    ]
    expect(parseArray(formatArray(items))).toEqual(items)
  })
})

describe("scrub", () => {
  const result = scrub(DUMP, KINDS)

  it("replaces every text and uuid value and leaves none behind", () => {
    for (const original of [
      "amira@acme.com",
      "o'brien@globex.io",
      "zoë@example.de",
      TENANT_A,
      TENANT_B,
      "bob@x.test",
      "eve@y.test",
    ]) {
      expect(result.sql).not.toContain(original)
    }
    expect(leaks(result, KINDS)).toEqual([])
  })

  it("keeps counts, order and byte widths of a histogram", () => {
    const before = parseArray(`{amira@acme.com,"o'brien@globex.io",zoë@example.de}`)
    const after = parseArray(
      valueOf(result.sql, "accounts", "email", "histogram_bounds")!,
    )
    expect(after).toHaveLength(before.length)
    expect(
      [...after].sort((a, b) => Buffer.compare(Buffer.from(a!), Buffer.from(b!))),
    ).toEqual(after)
    expect(after.map((v) => Buffer.byteLength(v!))).toEqual(
      before.map((v) => Buffer.byteLength(v!)),
    )
  })

  it("maps one original to one value everywhere, so join estimates survive", () => {
    const messages = parseArray(
      valueOf(result.sql, "messages", "tenant_id", "most_common_vals")!,
    )
    const keys = parseArray(
      valueOf(result.sql, "api_keys", "tenant_id", "most_common_vals")!,
    )
    expect(keys[0]).toBe(messages[1])
    expect(result.mapping.uuid.get(TENANT_B)).toBe(keys[0] ?? undefined)
  })

  it("keeps frequencies and the planner's other numbers untouched", () => {
    expect(valueOf(result.sql, "messages", "tenant_id", "most_common_freqs")).toBe(
      "{0.25,0.01}",
    )
    expect(valueOf(result.sql, "accounts", "email", "correlation")).toBe("0.1")
    expect(valueOf(result.sql, "messages", "attempts", "most_common_vals")).toBe(
      "{1,0,5}",
    )
  })

  it("drops the value lists it cannot generate, with their frequencies", () => {
    expect(
      valueOf(result.sql, "messages", "headers", "most_common_vals"),
    ).toBeUndefined()
    expect(
      valueOf(result.sql, "messages", "headers", "most_common_freqs"),
    ).toBeUndefined()
    expect(valueOf(result.sql, "messages", "headers", "avg_width")).toBe("19")
    expect(result.dropped).toEqual(["core.messages.headers"])
  })

  it("scrubs array elements and keeps the element frequencies", () => {
    expect(
      parseArray(valueOf(result.sql, "messages", "to_addresses", "most_common_elems")!),
    ).toHaveLength(2)
    expect(
      valueOf(result.sql, "messages", "to_addresses", "most_common_elem_freqs"),
    ).toBe("{0.1,0.1,0.1,0.1,1}")
  })

  it("passes everything that is not an attribute-stats call through", () => {
    expect(result.sql.startsWith("\\restrict abc\nSET statement_timeout = 0;")).toBe(
      true,
    )
  })

  it("a leak is reported", () => {
    const leaky = {
      ...result,
      sql: result.sql.replace(result.mapping.text.get("bob@x.test")!, "bob@x.test"),
    }
    expect(leaks(leaky, KINDS)).toContain("bob@x.test")
  })
})

describe("kindFor", () => {
  it("keeps numbers, times, booleans and enums; generates text and uuid; drops the rest", () => {
    expect(kindFor("N", "int4", null, null).kind).toBe("keep")
    expect(kindFor("D", "timestamptz", null, null).kind).toBe("keep")
    expect(kindFor("E", "message_status", null, null).kind).toBe("keep")
    expect(kindFor("S", "text", null, null).kind).toBe("text")
    expect(kindFor("U", "uuid", null, null).kind).toBe("uuid")
    expect(kindFor("U", "jsonb", null, null).kind).toBe("drop")
    expect(kindFor("I", "inet", null, null).kind).toBe("drop")
    expect(kindFor("A", "_text", "S", "text")).toEqual({ kind: "text", array: true })
  })
})
