import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "bun:test"
import { loadEnv } from "../src/env.js"
import {
  DEVICE_CODE_LEN,
  MailDeviceError,
  type MailDeviceErrorCode,
  formatDeviceCode,
  hasReservedPrefix,
  hashDeviceCode,
  matchesDeviceCode,
  mintCode,
  parseDeviceCode,
  parseMailDeviceCodeKeys,
} from "../src/mail-devices/code.js"
import { endFor, mintRefusal, type MintGateAccount } from "../src/mail-devices/store.js"
import { parseMailDeviceArgs, requireOperatorEnv } from "../scripts/mail-device.js"

/**
 * Mail device code format, keyed HMAC, key-ring parsing, Drizzle SQL pinning,
 * and operator CLI argument checks (#383).
 *
 * Every format and hash vector is loaded directly from Go's canonical fixture
 * `services/authd/internal/devicecode/testdata/vectors.json` so TypeScript and
 * Go stay byte-for-byte identical.
 */

interface VectorFile {
  label: string
  keys: string
  valid: {
    code: string
    id: string
    id_hex: string
    secret_hex: string
    kid: number
    hash_hex: string
  }[]
  invalid: {
    code: string
    why: string
    reserved: boolean
  }[]
}

const VECTORS_PATH = resolve(
  import.meta.dir,
  "../../../services/authd/internal/devicecode/testdata/vectors.json",
)
const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as VectorFile

describe("mail device code vectors (shared with Go authd)", () => {
  const ring = parseMailDeviceCodeKeys(vectors.keys)

  it("parses the shared key ring and picks the highest key id for minting", () => {
    expect(ring.currentKid).toBe(7)
    expect([...ring.keys.keys()].sort((a, b) => a - b)).toEqual([1, 7])
  })

  it("matches every valid Go vector byte for byte (format, parse, uuid, keyed hash)", () => {
    expect(vectors.valid.length).toBeGreaterThan(0)
    for (const v of vectors.valid) {
      expect(v.code.length).toBe(DEVICE_CODE_LEN)
      expect(hasReservedPrefix(v.code)).toBe(true)

      const parsed = parseDeviceCode(v.code)
      expect(parsed, v.code).not.toBeNull()
      expect(parsed!.id).toBe(v.id)
      expect(parsed!.idBytes.toString("hex")).toBe(v.id_hex)
      expect(parsed!.secret.toString("hex")).toBe(v.secret_hex)

      const formatted = formatDeviceCode(v.id, parsed!.secret)
      expect(formatted).toBe(v.code)

      const key = ring.keys.get(v.kid)
      expect(key).toBeDefined()
      const hash = hashDeviceCode(key!, parsed!.idBytes, parsed!.secret)
      expect(hash.toString("hex")).toBe(v.hash_hex)
      expect(matchesDeviceCode(key!, parsed!, Buffer.from(v.hash_hex, "hex"))).toBe(
        true,
      )

      // Flip one byte of hash -> constant-time compare refuses.
      const wrong = Buffer.from(v.hash_hex, "hex")
      wrong[0] = wrong[0]! ^ 0xff
      expect(matchesDeviceCode(key!, parsed!, wrong)).toBe(false)
    }
  })

  it("rejects every invalid Go vector and agrees on the reserved prefix", () => {
    expect(vectors.invalid.length).toBeGreaterThan(0)
    for (const v of vectors.invalid) {
      expect(parseDeviceCode(v.code), v.why).toBeNull()
      expect(hasReservedPrefix(v.code), v.why).toBe(v.reserved)
    }
  })

  it("mints fresh 83-char codes with the highest key id and verifiable hashes", () => {
    const id = "019abcde-0123-789a-8bcd-ef0123456789"
    const a = mintCode(ring, id)
    const b = mintCode(ring, id)
    expect(a.code.length).toBe(DEVICE_CODE_LEN)
    expect(a.codeKid).toBe(7)
    expect(a.codeHash.length).toBe(32)
    expect(a.code).not.toBe(b.code)

    const parsed = parseDeviceCode(a.code)
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe(id)
    expect(matchesDeviceCode(ring.keys.get(a.codeKid)!, parsed!, a.codeHash)).toBe(true)
  })
})

describe("MAIL_DEVICE_CODE_KEYS parsing and refusals", () => {
  it("refuses mintCode when the key ring is missing", () => {
    expect(() => mintCode(null, "019abcde-0123-789a-8bcd-ef0123456789")).toThrow(
      MailDeviceError,
    )
    try {
      mintCode(undefined, "019abcde-0123-789a-8bcd-ef0123456789")
    } catch (err) {
      expect(err).toBeInstanceOf(MailDeviceError)
      expect((err as MailDeviceError).code).toBe("keys_not_configured")
    }
  })

  it("rejects empty, malformed, duplicate, out-of-range kid, or short keys without echoing secrets", () => {
    const good32 = Buffer.alloc(32, 0x42).toString("base64")
    const short31 = Buffer.alloc(31, 0x42).toString("base64")
    const cases = [
      "",
      "   ",
      "not-an-entry",
      `-1:${good32}`,
      `256:${good32}`,
      `32768:${good32}`,
      `1:${short31}`,
      `1:not!base64!at!all`,
      `1:${good32},1:${good32}`,
    ]
    for (const raw of cases) {
      let thrown: unknown = null
      try {
        parseMailDeviceCodeKeys(raw)
      } catch (err) {
        thrown = err
      }
      expect(thrown, raw).toBeInstanceOf(Error)
      if (raw.includes(short31)) {
        expect((thrown as Error).message).not.toContain(short31)
      }
    }
  })

  it("accepts MAIL_DEVICE_CODE_KEYS through loadEnv when present and rejects malformed values", () => {
    const base: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
      REDIS_URL: "redis://localhost:6379",
      CLERK_WEBHOOK_SECRET: "whsec_test",
      CLERK_SECRET_KEY: "sk_test_abc",
      MAIL_DOMAINS: "i10.tech",
      SES_CONFIGURATION_SET: "i10-events",
    }
    const without = loadEnv(base)
    expect(without.MAIL_DEVICE_CODE_KEYS).toBeUndefined()

    const withValid = loadEnv({ ...base, MAIL_DEVICE_CODE_KEYS: vectors.keys })
    expect(withValid.MAIL_DEVICE_CODE_KEYS).toBe(vectors.keys)
    expect(parseMailDeviceCodeKeys(withValid.MAIL_DEVICE_CODE_KEYS!).currentKid).toBe(7)

    expect(() => loadEnv({ ...base, MAIL_DEVICE_CODE_KEYS: "1:short" })).toThrow(
      /MAIL_DEVICE_CODE_KEYS/,
    )
  })
})

describe("mintRefusal gate decision and endFor runtime guard", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111"
  const OTHER_TENANT = "22222222-2222-4222-8222-222222222222"
  const CONN = "33333333-3333-4333-8333-333333333333"

  const baseAccount = (over: Partial<MintGateAccount> = {}): MintGateAccount => ({
    clerk_user_id: "user_ada",
    email: "ada@acme.test",
    active: true,
    tenant_id: TENANT,
    credential_epoch: 42,
    suspended: false,
    payment_hold: false,
    deleting: false,
    banned: false,
    locked: false,
    domain_not_hosted: false,
    managed: false,
    managed_connection: null,
    connection_inactive: false,
    sso_required: false,
    sso_exempt: false,
    ...over,
  })

  const baseInput = { tenantId: TENANT, expectedEpoch: 42 }

  it("allows an eligible unmanaged, sso-exempt, managed-active, or null-tenant account", () => {
    expect(mintRefusal(baseAccount(), baseInput)).toBeNull()
    expect(
      mintRefusal(baseAccount({ sso_required: true, sso_exempt: true }), baseInput),
    ).toBeNull()
    expect(
      mintRefusal(
        baseAccount({
          managed: true,
          managed_connection: CONN,
          connection_inactive: false,
          sso_required: true,
        }),
        baseInput,
      ),
    ).toBeNull()
    expect(
      mintRefusal(baseAccount({ tenant_id: null, credential_epoch: "42" }), {
        tenantId: null,
        expectedEpoch: 42,
      }),
    ).toBeNull()
  })

  it("returns the matching MailDeviceError for every gate refusal", () => {
    const cases: [
      MailDeviceErrorCode,
      MintGateAccount | null | undefined,
      { tenantId: string | null; expectedEpoch: number },
    ][] = [
      ["account_not_found", undefined, baseInput],
      ["account_not_found", null, baseInput],
      ["tenant_mismatch", baseAccount(), { tenantId: OTHER_TENANT, expectedEpoch: 42 }],
      ["tenant_mismatch", baseAccount(), { tenantId: null, expectedEpoch: 42 }],
      ["tenant_mismatch", baseAccount({ tenant_id: null }), baseInput],
      ["account_inactive", baseAccount({ active: false }), baseInput],
      ["epoch_mismatch", baseAccount({ credential_epoch: 43 }), baseInput],
      ["mailbox_suspended", baseAccount({ suspended: true }), baseInput],
      ["mailbox_deleting", baseAccount({ deleting: true }), baseInput],
      ["payment_hold", baseAccount({ payment_hold: true }), baseInput],
      ["domain_not_hosted", baseAccount({ domain_not_hosted: true }), baseInput],
      ["account_banned", baseAccount({ banned: true }), baseInput],
      ["account_locked", baseAccount({ locked: true }), baseInput],
      ["sso_required", baseAccount({ sso_required: true }), baseInput],
      [
        "managed_no_connection",
        baseAccount({ managed: true, managed_connection: null }),
        baseInput,
      ],
      [
        "connection_inactive",
        baseAccount({
          managed: true,
          managed_connection: CONN,
          connection_inactive: true,
        }),
        baseInput,
      ],
    ]

    for (const [expectedCode, account, input] of cases) {
      const err = mintRefusal(account, input)
      expect(err, expectedCode).toBeInstanceOf(MailDeviceError)
      expect(err!.code, expectedCode).toBe(expectedCode)
    }
  })

  it("checks tenant_mismatch before revealing holds or epoch mismatch", () => {
    const err = mintRefusal(
      baseAccount({
        active: false,
        credential_epoch: 999,
        suspended: true,
        banned: true,
      }),
      { tenantId: OTHER_TENANT, expectedEpoch: 1 },
    )
    expect(err?.code).toBe("tenant_mismatch")
  })

  it("refuses endFor at runtime when tenantId is null and clerkUserIds is omitted", async () => {
    let called = false
    const fakeTx = {
      delete: () => {
        called = true
        throw new Error("should not reach delete")
      },
    }
    let err: unknown = null
    try {
      await endFor(
        fakeTx as never,
        { tenantId: null } as unknown as Parameters<typeof endFor>[1],
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("clerkUserIds")
    expect(called).toBe(false)
  })
})

describe("operator CLI scripts/mail-device.ts", () => {
  it("parses mint, list and revoke commands and rejects missing flags", () => {
    expect(
      parseMailDeviceArgs([
        "mint",
        "--email",
        "Ada@Acme.Test",
        "--platform",
        "ios",
        "--name",
        "Ada's iPhone",
        "--model",
        "iPhone16,1",
      ]),
    ).toEqual({
      action: "mint",
      email: "ada@acme.test",
      platform: "ios",
      name: "Ada's iPhone",
      model: "iPhone16,1",
      serial: null,
    })

    expect(parseMailDeviceArgs(["list", "--email", "ada@acme.test"])).toEqual({
      action: "list",
      email: "ada@acme.test",
    })

    expect(
      parseMailDeviceArgs(["revoke", "--id", "019abcde-0123-789a-8bcd-ef0123456789"]),
    ).toEqual({
      action: "revoke",
      id: "019abcde-0123-789a-8bcd-ef0123456789",
    })

    expect(() => parseMailDeviceArgs([])).toThrow(/Usage/)
    expect(() => parseMailDeviceArgs(["mint", "--email", "ada@acme.test"])).toThrow(
      /--platform/,
    )
    expect(() =>
      parseMailDeviceArgs([
        "mint",
        "--email",
        "ada@acme.test",
        "--platform",
        "android",
        "--name",
        "x",
      ]),
    ).toThrow(/--platform/)
    expect(() => parseMailDeviceArgs(["list"])).toThrow(/--email/)
    expect(() => parseMailDeviceArgs(["revoke"])).toThrow(/--id/)
  })

  it("refuses to run without DATABASE_URL or MAIL_DEVICE_CODE_KEYS", () => {
    expect(() => requireOperatorEnv({})).toThrow(/DATABASE_URL/)
    expect(() =>
      requireOperatorEnv({ DATABASE_URL: "postgres://u:p@localhost/db" }),
    ).toThrow(/MAIL_DEVICE_CODE_KEYS/)
    expect(() =>
      requireOperatorEnv({
        DATABASE_URL: "postgres://u:p@localhost/db",
        MAIL_DEVICE_CODE_KEYS: "bad",
      }),
    ).toThrow()
    const ok = requireOperatorEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MAIL_DEVICE_CODE_KEYS: vectors.keys,
    })
    expect(ok.keys.currentKid).toBe(7)
  })
})
