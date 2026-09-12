import { describe, expect, it } from "bun:test"
import { buildMobileConfig, profileFilename } from "../src/autoconfig/apple-profile.js"
import { createApp } from "../src/app.js"

const account = {
  email: "mohamed@i10.tech",
  imapHost: "mail.i10.tech",
  imapPort: 993,
  smtpHost: "mail.i10.tech",
  smtpPort: 465,
  organization: "i10",
}

/** `<key>Foo</key>\n<string>bar</string>` → "bar". */
function plistValueOf(xml: string, key: string): string | null {
  const m = new RegExp(
    `<key>${key}</key>\\s*<(string|integer)>([^<]*)</\\1>|<key>${key}</key>\\s*<(true|false)/>`,
  ).exec(xml)
  return m ? (m[2] ?? m[3] ?? null) : null
}

describe("the Apple configuration profile", () => {
  const xml = buildMobileConfig(account)

  it("is a plist Apple will parse", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"')
    expect(xml).toContain('<plist version="1.0">')
    expect(xml.trimEnd().endsWith("</plist>")).toBe(true)
  })

  it("describes an IMAP account on the implicit-TLS ports", () => {
    expect(plistValueOf(xml, "EmailAccountType")).toBe("EmailTypeIMAP")
    expect(plistValueOf(xml, "IncomingMailServerHostName")).toBe("mail.i10.tech")
    expect(plistValueOf(xml, "IncomingMailServerPortNumber")).toBe("993")
    expect(plistValueOf(xml, "OutgoingMailServerPortNumber")).toBe("465")
  })

  // ⚠ The failure this prevents is reported by the client as "cannot connect
  // using SSL", which reads as a certificate problem and is not one: 993 and
  // 465 are implicit TLS, so a profile saying UseSSL false makes Apple wait in
  // the clear for a STARTTLS banner that never arrives.
  it("marks both servers as SSL", () => {
    expect(xml).toMatch(/<key>IncomingMailServerUseSSL<\/key>\s*<true\/>/)
    expect(xml).toMatch(/<key>OutgoingMailServerUseSSL<\/key>\s*<true\/>/)
  })

  it("uses the address as the username on both servers", () => {
    expect(plistValueOf(xml, "IncomingMailServerUsername")).toBe("mohamed@i10.tech")
    expect(plistValueOf(xml, "OutgoingMailServerUsername")).toBe("mohamed@i10.tech")
    expect(xml).toMatch(/<key>OutgoingPasswordSameAsIncoming<\/key>\s*<true\/>/)
  })

  // ⚠ THE ONE THAT MATTERS. A password here would be a live mailbox credential
  // in a file that lands in ~/Downloads and gets forwarded.
  it("carries no password of any kind", () => {
    expect(xml).not.toMatch(/<key>[^<]*Password[^<]*<\/key>\s*<string>/)
  })

  it("leaves the profile removable", () => {
    expect(xml).toMatch(/<key>PayloadRemovalDisallowed<\/key>\s*<false\/>/)
  })

  // ⚠ Reinstalling must REPLACE the account, not add a second copy of the
  // mailbox beside it. iOS decides that by identifier and UUID.
  it("gives one address the same identity every time", () => {
    const again = buildMobileConfig({ ...account, displayName: "Something else" })
    expect(plistValueOf(again, "PayloadUUID")).toBe(plistValueOf(xml, "PayloadUUID"))
    expect(plistValueOf(again, "PayloadIdentifier")).toBe(
      plistValueOf(xml, "PayloadIdentifier"),
    )
  })

  it("gives two addresses different identities", () => {
    const other = buildMobileConfig({ ...account, email: "someone@i10.tech" })
    expect(plistValueOf(other, "PayloadUUID")).not.toBe(
      plistValueOf(xml, "PayloadUUID"),
    )
  })

  it("emits UUIDs in the shape Apple accepts", () => {
    expect(plistValueOf(xml, "PayloadUUID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  // The address is caller-supplied and goes into element content. Unescaped, an
  // `&` alone makes the document malformed and Apple rejects it silently.
  it("escapes the address into the XML", () => {
    const odd = buildMobileConfig({ ...account, email: "a&b<c@i10.tech" })
    expect(odd).toContain("a&amp;b&lt;c@i10.tech")
    expect(odd).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;|quot;)/)
  })
})

describe("the download filename", () => {
  it("is derived from the address", () => {
    expect(profileFilename("mohamed@i10.tech")).toBe(
      "i10-mohamed-i10-tech.mobileconfig",
    )
  })

  // ⚠ It goes straight into a Content-Disposition header. A CR or LF would end
  // that header and let the caller write the next one.
  it.each([
    ['a"@i10.tech', "contains a quote"],
    ["a\r\nX-Evil: 1@i10.tech", "contains a newline"],
    ["a b@i10.tech", "contains a space"],
  ])("strips %s (%s)", (email) => {
    expect(profileFilename(email)).toMatch(/^i10-[a-z0-9-]+\.mobileconfig$/)
  })
})

describe("GET /autoconfig/apple.mobileconfig", () => {
  const app = createApp({
    autoconfig: {
      hostedDomains: ["i10.tech"],
      mailHost: "mail.i10.tech",
      imapPort: 993,
      smtpPort: 465,
      organization: "i10",
    },
  })

  it("serves the profile with the type that makes it installable", async () => {
    const res = await app.request(
      "/autoconfig/apple.mobileconfig?email=mohamed@i10.tech",
    )
    expect(res.status).toBe(200)
    // ⚠ Served as text/xml, Safari on iOS shows the source instead of offering
    // to install it, and no amount of tapping helps.
    expect(res.headers.get("content-type")).toBe("application/x-apple-aspen-config")
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="i10-mohamed-i10-tech.mobileconfig"',
    )
    expect(await res.text()).toContain("com.apple.mail.managed")
  })

  it("normalises the address before using it", async () => {
    const res = await app.request(
      "/autoconfig/apple.mobileconfig?email=%20Mohamed@I10.Tech%20",
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<string>mohamed@i10.tech</string>")
  })

  it("refuses a domain we do not host", async () => {
    const res = await app.request("/autoconfig/apple.mobileconfig?email=a@gmail.com")
    expect(res.status).toBe(404)
    expect((await res.json()) as object).toMatchObject({
      message: "i10 does not host mail for gmail.com.",
    })
  })

  it.each([
    ["nothing", ""],
    ["no domain", "?email=mohamed"],
    ["no local part", "?email=@i10.tech"],
    ["a bare domain", "?email=i10.tech"],
  ])("rejects %s", async (_label, query) => {
    const res = await app.request(`/autoconfig/apple.mobileconfig${query}`)
    expect(res.status).toBe(400)
  })

  // Same policy as requireApiKey: unconfigured must not degrade into something
  // that looks like a routing mistake.
  it("answers 503 when it is not configured", async () => {
    const res = await createApp().request(
      "/autoconfig/apple.mobileconfig?email=mohamed@i10.tech",
    )
    expect(res.status).toBe(503)
  })

  // The document is a customer-facing contract compiled into five SDKs.
  // Provisioning a mailbox is not part of it.
  it("stays out of the OpenAPI document", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(doc.paths)).not.toContain("/autoconfig/apple.mobileconfig")
  })
})
