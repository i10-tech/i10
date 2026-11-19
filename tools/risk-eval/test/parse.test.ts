import { describe, expect, it } from "bun:test"
import { parseCsv, parseCsvRecords } from "../src/csv.js"
import { detectLanguage } from "../src/lang.js"
import { splitMbox } from "../src/mbox.js"
import { decodeHeader, parseMessage } from "../src/mime.js"
import { domainOf, htmlToText } from "../src/text.js"

const b64 = (s: string) => btoa(s)

describe("parseMessage", () => {
  it("reads a multipart/alternative mail: encoded subject, quoted-printable text, html kept", () => {
    const raw = [
      'From: "Bank Support" <support@Bank-Secure.example>',
      `Subject: =?UTF-8?B?${b64("Verify your account")}?=`,
      "Date: Mon, 03 Jan 2022 10:00:00 +0000",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Please verify at once, caf=C3=A9 customers=",
      " and friends.",
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Please <b>verify</b></p>",
      "--b1--",
      "",
    ].join("\r\n")
    const m = parseMessage(raw)
    expect(m.subject).toBe("Verify your account")
    expect(m.text).toContain("café customers and friends.")
    expect(m.html).toContain("<b>verify</b>")
    expect(m.fromDomain).toBe("bank-secure.example")
    expect(m.year).toBe(2022)
    expect(m.hasAttachments).toBe(false)
  })

  it("falls back to the html as text when there is no plain part, and flags attachments", () => {
    const raw = [
      "Subject: Invoice",
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      "Content-Type: text/html",
      "",
      "<div>Pay <a href='http://x.example'>now</a></div><script>evil()</script>",
      "--m",
      "Content-Type: application/pdf; name=inv.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      b64("%PDF-1.4"),
      "--m--",
    ].join("\n")
    const m = parseMessage(raw)
    expect(m.text).toBe("Pay now")
    expect(m.hasAttachments).toBe(true)
  })

  it("decodes a base64 body in a non-UTF-8 charset and tolerates an unknown charset", () => {
    const latin = Buffer.from("caf\xe9", "latin1").toString("base64")
    const known = parseMessage(
      `Content-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: base64\n\n${latin}\n`,
    )
    expect(known.text).toBe("café")
    const unknown = parseMessage(
      `Content-Type: text/plain; charset=x-no-such-set\n\nplain ascii body\n`,
    )
    expect(unknown.text).toBe("plain ascii body")
  })

  it("is bounded: a deeply nested multipart does not recurse without limit", () => {
    let raw = "Content-Type: text/plain\n\ninnermost"
    for (let i = 0; i < 30; i++) {
      raw = `Content-Type: multipart/mixed; boundary="b${i}"\n\n--b${i}\n${raw}\n--b${i}--\n`
    }
    expect(parseMessage(raw).text).toBe("")
  })

  it("never throws on garbage", () => {
    expect(() =>
      parseMessage(`${String.fromCharCode(0, 1)} not a mail at all`),
    ).not.toThrow()
    expect(parseMessage("").text).toBe("")
  })
})

describe("decodeHeader", () => {
  it("joins adjacent encoded words and decodes Q encoding", () => {
    expect(decodeHeader("=?UTF-8?Q?caf=C3=A9_?= =?UTF-8?Q?au_lait?=")).toBe(
      "café au lait",
    )
  })
})

describe("splitMbox", () => {
  const mbox = [
    "From a@b.example Mon Jan  3 10:00:00 2022 +0000",
    "Subject: first",
    "",
    "From the desk of the manager, this line is body text.",
    "",
    "From c@d.example Tue Jan  4 11:00:00 2022 +0000",
    "Subject: second",
    "",
    "body two",
    "",
  ].join("\n")

  it("splits on separator lines only, not on body lines that start with From", () => {
    const messages = [...splitMbox(mbox)]
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain("From the desk of the manager")
    expect(messages[1]).toContain("Subject: second")
  })

  it("yields nothing for text with no separator", () => {
    expect([...splitMbox("just some text\n")]).toHaveLength(0)
  })
})

describe("parseCsv", () => {
  it("handles quoted commas, doubled quotes, embedded newlines, CRLF and a BOM", () => {
    const rows = [
      ...parseCsv(
        `${String.fromCharCode(0xfeff)}id,text\r\n1,"a, ""b""\nline2"\r\n2,plain\n`,
      ),
    ]
    expect(rows).toEqual([
      ["id", "text"],
      ["1", 'a, "b"\nline2'],
      ["2", "plain"],
    ])
  })

  it("keeps an empty last field and survives an unterminated quote", () => {
    expect([...parseCsv("a,b,\n")]).toEqual([["a", "b", ""]])
    expect([...parseCsv('a,"never closed')]).toEqual([["a", "never closed"]])
  })

  it("keys records by the lower-cased header and pads short rows", () => {
    const records = [...parseCsvRecords("ID,Text\n1\n")]
    expect(records).toEqual([{ id: "1", text: "" }])
  })
})

describe("detectLanguage", () => {
  it("names a language by its script", () => {
    expect(detectLanguage("مرحبا بك في خدمتنا الرجاء تأكيد حسابك الآن")).toBe("ar")
    expect(
      detectLanguage(
        "お客様のアカウントを確認してください。ご利用ありがとうございます",
      ),
    ).toBe("ja")
    expect(detectLanguage("请确认您的账户信息以继续使用我们的服务")).toBe("zh")
    expect(
      detectLanguage("계정을 확인하려면 아래 링크를 클릭하십시오 감사합니다"),
    ).toBe("ko")
    expect(detectLanguage("Пожалуйста подтвердите ваш аккаунт немедленно")).toBe("ru")
  })

  it("votes by stopwords for Latin script and says und when unsure", () => {
    expect(
      detectLanguage(
        "Please confirm that you have received the email from our team and your account",
      ),
    ).toBe("en")
    expect(
      detectLanguage(
        "Por favor confirme que usted ha recibido el correo para la cuenta con los datos",
      ),
    ).toBe("es")
    expect(
      detectLanguage("Yang ini untuk anda dan kami tidak akan dengan pada di ke dari"),
    ).toBe("id")
    expect(detectLanguage("ok")).toBe("und")
    expect(detectLanguage("qwxz vbnm plkj hgfd")).toBe("und")
  })
})

describe("text helpers", () => {
  it("strips html without interpreting it", () => {
    expect(htmlToText("<style>x{}</style><p>a &amp; b</p>c&#33;")).toBe("a & b\nc!")
  })

  it("extracts a sender domain", () => {
    expect(domainOf('"X" <User@Example.COM>')).toBe("example.com")
    expect(domainOf("nobody")).toBeUndefined()
  })
})
