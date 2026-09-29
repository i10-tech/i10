import { describe, expect, it } from "bun:test"
import {
  marker,
  resolveTemplateSend,
  type StoredVersion,
  type TemplateLookup,
} from "../src/index.js"

const nonce = "abcdefghijkl"
const v1: StoredVersion = {
  id: "ver-1",
  templateId: "tpl-1",
  number: 1,
  subject: "Welcome, {{name}}",
  html: `<p>${marker(nonce, 0)}</p>`,
  text: marker(nonce, 0),
  nonce,
  variables: [{ path: "name", preview: "Ada" }],
}

/** An in-memory lookup: the shape an edge cache in front of the API provides. */
const lookup: TemplateLookup = {
  async versionIdFor(ref) {
    if (ref.id !== "tpl-1" && ref.id !== "welcome") return null
    return ref.version === undefined || ref.version === 1 ? "ver-1" : null
  },
  async version(id) {
    return id === "ver-1" ? v1 : null
  },
}

describe("sending a template", () => {
  it("fills the live version, by id or by name", async () => {
    for (const id of ["tpl-1", "welcome"]) {
      const result = await resolveTemplateSend(
        { template: { id }, variables: { name: "<Bo>" } },
        lookup,
      )
      expect(result).toEqual({
        ok: true,
        versionId: "ver-1",
        html: "<p>&lt;Bo&gt;</p>",
        text: "<Bo>",
        subject: "Welcome, <Bo>",
      })
    }
  })

  it("lets the request's subject win, taken literally", async () => {
    const result = await resolveTemplateSend(
      { template: { id: "tpl-1" }, variables: { name: "a" }, subject: "Hi {{name}}" },
      lookup,
    )
    expect(result.ok && result.subject).toBe("Hi {{name}}")
  })

  it("names a missing version", async () => {
    const result = await resolveTemplateSend(
      { template: { id: "tpl-1", version: 9 } },
      lookup,
    )
    expect(result).toMatchObject({ ok: false, error: "not_found" })
  })

  it("names missing variables", async () => {
    const result = await resolveTemplateSend({ template: { id: "tpl-1" } }, lookup)
    expect(result).toMatchObject({ ok: false, error: "invalid" })
    if (!result.ok) expect(result.message).toContain("missing `name`")
  })
})
