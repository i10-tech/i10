import { describe, expect, it } from "bun:test"
import { asId } from "../src/routes/console/http.js"

/**
 * A filter id from a query string reaches a uuid column; anything that is not
 * a uuid must be dropped here rather than fail the statement with a cast error.
 */
describe("asId", () => {
  it("keeps a uuid and drops everything else", () => {
    const id = "0190a3e4-5b6c-7d8e-9f00-112233445566"
    expect(asId(id)).toBe(id)
    expect(asId(undefined)).toBeUndefined()
    expect(asId("")).toBeUndefined()
    expect(asId("nonsense")).toBeUndefined()
    expect(asId(`${id}' or 1=1`)).toBeUndefined()
  })
})
