import { describe, expect, it, mock } from "bun:test"
import type { SendEmail } from "@repo/contracts"
import { marker, type StoredVersion, type TemplateLookup } from "@repo/templates"
import { acceptSend, type AcceptOps, type PreparedMessage } from "../src/send/accept.js"
import { unmetered, type Metering } from "../src/send/metering.js"

/**
 * A send that names a template (#160): filled from the stored version through
 * the `templates` port, before quota, all-or-nothing for a batch.
 */

const nonce = "abcdefghijkl"
const version: StoredVersion = {
  id: "ver-7",
  templateId: "tpl-1",
  number: 7,
  subject: "Hi {{name}}",
  html: `<p>${marker(nonce, 0)}</p>`,
  text: null,
  nonce,
  variables: [{ path: "name", preview: "" }],
}

function setup() {
  const versionIdFor = mock(async (ref: { id: string }) =>
    ref.id === "welcome" ? "ver-7" : null,
  )
  const lookup: TemplateLookup = {
    versionIdFor,
    version: async (id) => (id === "ver-7" ? version : null),
  }
  const persist = mock(async (input: { messages: PreparedMessage[] }) => ({
    status: "written" as const,
    ids: input.messages.map((_, i) => `msg-${i}`),
    refs: input.messages.map((_, i) => ({ id: `msg-${i}`, createdAt: new Date() })),
  }))
  const checkQuota = mock(unmetered.checkQuota)
  const deps = {
    persist,
    suppressedFor: async () => new Set<string>(),
    sendableFrom: async (_t: string, domains: string[]) => new Set(domains),
    enqueue: async () => {},
    templates: () => lookup,
    metering: { ...unmetered, checkQuota },
    log: { warn: mock(), error: mock() },
  } as AcceptOps & { metering: Metering; log: { warn: () => void; error: () => void } }
  return { deps, persist, checkQuota, versionIdFor }
}

const send = (over: Partial<SendEmail> = {}): SendEmail => ({
  from: "hi@acme.test",
  to: "user@example.com",
  template: { id: "welcome", variables: { name: "Ada & Bo" } },
  ...over,
})

const run = (deps: ReturnType<typeof setup>["deps"], payloads: SendEmail[]) =>
  acceptSend(
    {
      tenantId: "t1",
      apiKeyId: "k1",
      payloads,
      endpoint: payloads.length > 1 ? "batch" : "single",
    },
    deps,
  )

describe("sending a template", () => {
  it("writes the filled email and the version it came from", async () => {
    const { deps, persist } = setup()
    expect(await run(deps, [send()])).toEqual({ status: "accepted", ids: ["msg-0"] })
    const written = persist.mock.calls[0]![0].messages[0]!
    expect(written.payload.html).toBe("<p>Ada &amp; Bo</p>")
    expect(written.payload.subject).toBe("Hi Ada & Bo")
    expect(written.templateVersionId).toBe("ver-7")
    expect("template" in written.payload).toBe(false)
  })

  it("refuses a template that is not there as not_found, before quota", async () => {
    const { deps, persist, checkQuota } = setup()
    const outcome = await run(deps, [send({ template: { id: "nope" } })])
    expect(outcome).toMatchObject({ status: "invalid_template", name: "not_found" })
    expect(checkQuota).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it("refuses missing variables as a validation error", async () => {
    const { deps } = setup()
    const outcome = await run(deps, [send({ template: { id: "welcome" } })])
    expect(outcome).toMatchObject({
      status: "invalid_template",
      name: "validation_error",
    })
  })

  it("refuses a whole batch for one bad element, and looks a template up once", async () => {
    const { deps, persist, versionIdFor } = setup()
    const outcome = await run(deps, [
      send(),
      send(),
      send({ template: { id: "welcome" } }),
    ])
    expect(outcome).toMatchObject({ status: "invalid_template" })
    expect(persist).not.toHaveBeenCalled()
    expect(versionIdFor).toHaveBeenCalledTimes(1)
  })

  it("passes a raw send through untouched", async () => {
    const { deps, persist } = setup()
    await run(deps, [
      { from: "hi@acme.test", to: "u@example.com", subject: "s", html: "<b>x</b>" },
    ])
    const written = persist.mock.calls[0]![0].messages[0]!
    expect(written.payload.html).toBe("<b>x</b>")
    expect(written.templateVersionId).toBeNull()
  })

  describe("the template's sender (Resend's template defaults)", () => {
    function withSender(sendable: string[] = ["acme.test"]) {
      const base = setup()
      const lookup: TemplateLookup = {
        versionIdFor: async (ref) => (ref.id === "welcome" ? "ver-7" : null),
        version: async () => ({
          ...version,
          from: "Acme <hi@acme.test>",
          replyTo: ["help@acme.test"],
        }),
      }
      base.deps.templates = () => lookup
      base.deps.sendableFrom = async (_t, domains) =>
        new Set(domains.filter((d) => sendable.includes(d)))
      return base
    }
    const noFrom: SendEmail = { ...send() }
    delete noFrom.from

    it("fills in a send that names none", async () => {
      const { deps, persist } = withSender()
      expect(await run(deps, [noFrom])).toEqual({ status: "accepted", ids: ["msg-0"] })
      const written = persist.mock.calls[0]![0].messages[0]!
      expect(written.payload.from).toBe("Acme <hi@acme.test>")
      expect(written.payload.reply_to).toEqual(["help@acme.test"])
    })

    it("is checked against the key's scope and the verified domains like any sender", async () => {
      const scoped = withSender()
      const refused = await acceptSend(
        {
          tenantId: "t1",
          apiKeyId: "k1",
          scopes: ["domain:other.test"],
          payloads: [noFrom],
          endpoint: "single",
        },
        scoped.deps,
      )
      expect(refused).toMatchObject({ status: "forbidden" })

      const unverified = withSender([])
      expect(await run(unverified.deps, [noFrom])).toMatchObject({
        status: "unverified_domain",
      })
      expect(unverified.persist).not.toHaveBeenCalled()
    })

    it("loses to the request's own", async () => {
      const { deps, persist } = withSender()
      await run(deps, [send({ from: "b@acme.test", reply_to: "c@acme.test" })])
      const written = persist.mock.calls[0]![0].messages[0]!
      expect(written.payload.from).toBe("b@acme.test")
      expect(written.payload.reply_to).toBe("c@acme.test")
    })

    it("refuses a template send with no sender anywhere", async () => {
      const { deps } = setup()
      expect(await run(deps, [noFrom])).toMatchObject({
        status: "invalid_template",
        name: "validation_error",
      })
    })
  })
})
