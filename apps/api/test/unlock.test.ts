import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  unlockEnv,
  WRAPPABLE,
  wrapValue,
  type Wrappable,
} from "../src/crypto/unlock.js"

const b64 = (fill: number) => Buffer.alloc(32, fill).toString("base64")
const W1 = `w1:${b64(1)}`
const W2 = `w2:${b64(2)}`

const PLAIN: Record<Wrappable, string> = {
  SEAL_KEYS: `s1:${b64(3)}`,
  TOKEN_KEYS: `t1:${b64(4)}`,
  CONTENT_KEYS: `c2:${b64(5)},c1:${b64(6)}`,
  OBJECT_KEYS: `o1:${b64(8)}`,
  FEEDBACK_ID_KEY: Buffer.alloc(32, 7).toString("hex"),
}

const quiet = { warn: () => {} }
const wrap = (name: Wrappable, ring = W1) =>
  wrapValue(name, PLAIN[name], { KEY_WRAP_KEYS: ring })

/** The message `unlockEnv` rejects with. */
async function refusal(source: NodeJS.ProcessEnv): Promise<string> {
  return unlockEnv(quiet, source).then(
    () => "",
    (error: Error) => error.message,
  )
}

describe("unlockEnv", () => {
  it("passes plain values through and leaves absent ones absent", async () => {
    const source = { SEAL_KEYS: PLAIN.SEAL_KEYS, OTHER: "x" }
    const env = await unlockEnv(quiet, source)
    expect(env).toEqual(source)
    expect("TOKEN_KEYS" in env).toBe(false)
  })

  it("unwraps each variable to its plain value", async () => {
    const source: NodeJS.ProcessEnv = { KEY_WRAP_KEYS: W1 }
    for (const name of WRAPPABLE) source[name] = await wrap(name)
    const env = await unlockEnv(quiet, source)
    for (const name of WRAPPABLE) expect(env[name]).toBe(PLAIN[name])
  })

  it("does not unwrap a value wrapped for another variable", async () => {
    const wrapped = await wrap("SEAL_KEYS")
    const message = await refusal({ KEY_WRAP_KEYS: W1, TOKEN_KEYS: wrapped })
    expect(message).toContain("TOKEN_KEYS: does not unwrap")
    expect(message).not.toContain(wrapped)
  })

  it("refuses a tampered value", async () => {
    const parts = (await wrap("SEAL_KEYS")).split(".")
    const ciphertext = parts.pop()!
    // The first character: a last one can carry only padding bits.
    const flipped = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1)
    const message = await refusal({
      KEY_WRAP_KEYS: W1,
      SEAL_KEYS: [...parts, flipped].join("."),
    })
    expect(message).toContain("SEAL_KEYS: does not unwrap")
  })

  it("names the variable and the cause, never the value or a key", async () => {
    const wrapped = await wrap("SEAL_KEYS", W2)
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ KEY_WRAP_KEYS: W1, SEAL_KEYS: wrapped }, "SEAL_KEYS: is wrapped under key w2"],
      [{ SEAL_KEYS: wrapped }, "SEAL_KEYS: KEY_WRAP_KEYS is not set"],
      [
        { KEY_WRAP_KEYS: W1, SEAL_KEYS: "wrap1.kms.arn-and-blob" },
        "SEAL_KEYS: is wrapped by an unknown provider",
      ],
    ]
    for (const [source, expected] of cases) {
      const message = await refusal(source)
      expect(message).toContain(expected)
      for (const secret of [wrapped, b64(1), b64(2), PLAIN.SEAL_KEYS]) {
        expect(message).not.toContain(secret)
      }
    }
  })

  it("opens values under an older wrap key, and wraps under the first", async () => {
    const old = await wrap("SEAL_KEYS", W1)
    const ring = `${W2},${W1}`
    expect(
      (await unlockEnv(quiet, { KEY_WRAP_KEYS: ring, SEAL_KEYS: old })).SEAL_KEYS,
    ).toBe(PLAIN.SEAL_KEYS)

    const fresh = await wrap("SEAL_KEYS", ring)
    expect(
      (await unlockEnv(quiet, { KEY_WRAP_KEYS: W2, SEAL_KEYS: fresh })).SEAL_KEYS,
    ).toBe(PLAIN.SEAL_KEYS)
    expect(await refusal({ KEY_WRAP_KEYS: W1, SEAL_KEYS: fresh })).toContain("key w2")
  })

  describe("process.env", () => {
    const saved = {
      SEAL_KEYS: process.env.SEAL_KEYS,
      KEY_WRAP_KEYS: process.env.KEY_WRAP_KEYS,
    }
    afterEach(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })

    it("is read but never changed", async () => {
      const wrapped = await wrap("SEAL_KEYS")
      process.env.KEY_WRAP_KEYS = W1
      process.env.SEAL_KEYS = wrapped
      const env = await unlockEnv(quiet)
      expect(env.SEAL_KEYS).toBe(PLAIN.SEAL_KEYS)
      expect(process.env.SEAL_KEYS).toBe(wrapped)
    })
  })

  describe("in production", () => {
    async function warnings(source: NodeJS.ProcessEnv) {
      const seen: string[] = []
      await unlockEnv({ warn: (message) => seen.push(message) }, source)
      return seen
    }

    it("warns once, naming only the plain variables", async () => {
      const seen = await warnings({
        NODE_ENV: "production",
        KEY_WRAP_KEYS: W1,
        SEAL_KEYS: PLAIN.SEAL_KEYS,
        FEEDBACK_ID_KEY: PLAIN.FEEDBACK_ID_KEY,
        TOKEN_KEYS: await wrap("TOKEN_KEYS"),
      })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toContain("SEAL_KEYS, FEEDBACK_ID_KEY")
      expect(seen[0]).not.toContain("TOKEN_KEYS")
      expect(seen[0]).not.toContain(PLAIN.SEAL_KEYS)
      expect(seen[0]).not.toContain(PLAIN.FEEDBACK_ID_KEY)
    })

    it("stays quiet when every key is wrapped, and outside production", async () => {
      const wrapped = { KEY_WRAP_KEYS: W1, SEAL_KEYS: await wrap("SEAL_KEYS") }
      expect(await warnings({ NODE_ENV: "production", ...wrapped })).toEqual([])
      expect(
        await warnings({ NODE_ENV: "development", SEAL_KEYS: PLAIN.SEAL_KEYS }),
      ).toEqual([])
    })
  })
})

describe("docs/decisions/encryption.md", () => {
  it("names every variable that may be wrapped", () => {
    const doc = readFileSync(
      `${import.meta.dir}/../../../docs/decisions/encryption.md`,
      "utf8",
    )
    const start = doc.indexOf("## Wrapped keys")
    expect(start).toBeGreaterThan(0)
    const section = doc.slice(start)
    for (const name of WRAPPABLE) expect(section).toContain(`\`${name}\``)
  })
})
