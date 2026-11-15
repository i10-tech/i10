import { describe, expect, it } from "bun:test"
import { wrapKeys } from "../scripts/wrap-keys.js"
import { unlockEnv } from "../src/crypto/unlock.js"

const b64 = (fill: number) => Buffer.alloc(32, fill).toString("base64")
const W1 = `w1:${b64(1)}`
const W2 = `w2:${b64(2)}`
const SEAL = `s1:${b64(3)}`
const quiet = { warn: () => {} }

const refusal = (args: string[], input: string, ring = W1) =>
  wrapKeys(args, input, { KEY_WRAP_KEYS: ring }).then(
    () => "",
    (error: Error) => error.message,
  )

describe("wrap-keys", () => {
  it("prints a value that unlocks to the input, stdin newline and all", async () => {
    const wrapped = await wrapKeys(["SEAL_KEYS"], `${SEAL}\n`, { KEY_WRAP_KEYS: W1 })
    expect(wrapped.startsWith("wrap1.local.w1.")).toBe(true)
    const env = await unlockEnv(quiet, { KEY_WRAP_KEYS: W1, SEAL_KEYS: wrapped })
    expect(env.SEAL_KEYS).toBe(SEAL)
  })

  it("wraps the feedback key, which is not a keyring", async () => {
    const key = Buffer.alloc(32, 4).toString("hex")
    const wrapped = await wrapKeys(["FEEDBACK_ID_KEY"], key, { KEY_WRAP_KEYS: W1 })
    const env = await unlockEnv(quiet, { KEY_WRAP_KEYS: W1, FEEDBACK_ID_KEY: wrapped })
    expect(env.FEEDBACK_ID_KEY).toBe(key)
  })

  it("refuses an unknown name, empty stdin, an invalid value and wrapped input", async () => {
    const wrapped = await wrapKeys(["SEAL_KEYS"], SEAL, { KEY_WRAP_KEYS: W1 })
    expect(await refusal(["DATABASE_URL"], SEAL)).toContain("usage: wrap-keys")
    expect(await refusal([], SEAL)).toContain("usage: wrap-keys")
    expect(await refusal(["SEAL_KEYS"], " \n")).toContain("SEAL_KEYS: stdin is empty")
    expect(
      await refusal(["TOKEN_KEYS"], `t1:${Buffer.alloc(16).toString("base64")}`),
    ).toContain("TOKEN_KEYS: key t1 is not 32 bytes")
    expect(await refusal(["FEEDBACK_ID_KEY"], "short")).toContain(
      "FEEDBACK_ID_KEY: must be 32 bytes",
    )
    expect(await refusal(["SEAL_KEYS"], wrapped)).toContain(
      "already wrapped (use --rewrap)",
    )
    expect(await refusal(["SEAL_KEYS", "--rewrap"], SEAL)).toContain(
      "needs a wrapped input",
    )
  })

  it("--rewrap moves a value to the current wrap key", async () => {
    const old = await wrapKeys(["SEAL_KEYS"], SEAL, { KEY_WRAP_KEYS: W1 })
    const moved = await wrapKeys(["SEAL_KEYS", "--rewrap"], old, {
      KEY_WRAP_KEYS: `${W2},${W1}`,
    })
    const env = await unlockEnv(quiet, { KEY_WRAP_KEYS: W2, SEAL_KEYS: moved })
    expect(env.SEAL_KEYS).toBe(SEAL)
  })
})
