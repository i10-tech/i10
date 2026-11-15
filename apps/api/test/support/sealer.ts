import { keyringFromEnv } from "../../src/crypto/keyring.js"
import { sealer, type Sealer } from "../../src/crypto/sealer.js"

/** A real sealer under a key built from code, for tests that store secrets. */
export const testSealer = (fill = 7): Sealer =>
  sealer(keyringFromEnv("SEAL_KEYS", `t1:${Buffer.alloc(32, fill).toString("base64")}`))

/** For unit tests whose fake rows hold made-up ciphertext: opens to itself. */
export const fakeSealer: Sealer = {
  currentKid: "fake",
  seal: (_context, plaintext) => `sealed:${plaintext}`,
  open: (_context, sealed) => sealed,
}
