import { describe, expect, it } from "bun:test"
import { createDecipheriv, hkdfSync } from "node:crypto"
import { keyringFromEnv } from "../src/crypto/keyring.js"
import { sealer, sealedUnder, type SealContext } from "../src/crypto/sealer.js"

/**
 * Sealing the secrets we must read back. What matters is what does NOT open: a
 * value moved to another row, column or workspace, a changed byte, a key that
 * is gone.
 */
const key = (kid: string, fill: number) =>
  `${kid}:${Buffer.alloc(32, fill).toString("base64")}`
const ring = (value: string) => keyringFromEnv("SEAL_KEYS", value)
const box = sealer(ring(key("k1", 1)))

const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const OTHER_TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6072"
const ROW = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6073"
const at: SealContext = {
  purpose: "core.webhook_endpoints.secret_ciphertext",
  tenantId: TENANT,
  rowId: ROW,
}

describe("sealing", () => {
  it("round-trips, under the current key, in the v2 format", () => {
    const sealed = box.seal(at, "a secret")
    expect(box.open(at, sealed)).toBe("a secret")
    expect(sealed.startsWith("v2.k1.")).toBe(true)
    expect(sealedUnder(sealed)).toBe("k1")
  })

  it("does not carry the plaintext and is not deterministic", () => {
    const sealed = box.seal(at, "plaintext-marker")
    expect(sealed).not.toContain("plaintext-marker")
    expect(box.seal(at, "same")).not.toBe(box.seal(at, "same"))
  })

  it("does not open for another workspace, column or row", () => {
    const sealed = box.seal(at, "secret")
    for (const moved of [
      { ...at, tenantId: OTHER_TENANT },
      { ...at, purpose: "core.domains.dkim_private_key_sealed" as const },
      { ...at, rowId: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6074" },
    ]) {
      expect(() => box.open(moved, sealed)).toThrow(
        "sealed for another row, column or workspace",
      )
    }
  })

  it("refuses a tampered value", () => {
    const [v, kid, iv, tag, ct] = box.seal(at, "original").split(".")
    const flipped = [v, kid, iv, tag, `${ct!.slice(0, -2)}AA`].join(".")
    expect(() => box.open(at, flipped)).toThrow("tampered")
  })

  it("names an unknown key id, and never the plaintext", () => {
    const other = sealer(ring(key("k9", 9))).seal(at, "never-shown")
    let message = ""
    try {
      box.open(at, other)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("key k9, which is not in SEAL_KEYS")
    expect(message).not.toContain("never-shown")
  })

  it("opens a value sealed under an older key once a new key is put first", () => {
    const old = box.seal(at, "from before")
    const rotated = sealer(ring(`${key("k2", 2)},${key("k1", 1)}`))
    expect(rotated.open(at, old)).toBe("from before")
    expect(sealedUnder(rotated.seal(at, "new"))).toBe("k2")
  })

  /**
   * ⚠ THE DERIVATION IS PINNED FROM OUTSIDE THE MODULE. Changing it silently
   * would make every stored value unreadable, and it is what a recovery tool
   * written from the docs has to reproduce.
   */
  it("derives the AES key per workspace, as documented", () => {
    const [, , iv, tag, ct] = box.seal(at, "pinned").split(".")
    const openWith = (tenant: string) => {
      const aesKey = Buffer.from(
        hkdfSync(
          "sha256",
          Buffer.alloc(32, 1),
          Buffer.alloc(0),
          `i10/seal/v2/workspace-key/${tenant}`,
          32,
        ),
      )
      const d = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(iv!, "base64url"))
      d.setAAD(Buffer.from(`i10/seal/v2/${at.purpose}/${TENANT}/${ROW}`))
      d.setAuthTag(Buffer.from(tag!, "base64url"))
      return Buffer.concat([
        d.update(Buffer.from(ct!, "base64url")),
        d.final(),
      ]).toString()
    }
    expect(openWith(TENANT)).toBe("pinned")
    // The right AAD and another workspace's key: the keys really differ.
    expect(() => openWith(OTHER_TENANT)).toThrow()
  })

  it("refuses a context that could be spelled two ways", () => {
    expect(() => box.seal({ ...at, rowId: "a/b" }, "x")).toThrow('no "/"')
    expect(() => box.seal({ ...at, tenantId: "" }, "x")).toThrow()
  })
})
