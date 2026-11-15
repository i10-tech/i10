import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import { currentKey, keyringFromEnv, type Keyring } from "./keyring.js"

/**
 * Secrets we must read back (webhook signing secrets, DKIM private keys, DNS
 * and SIEM credentials), sealed before they reach a row.
 *
 *   v2.<kid>.<iv b64url>.<tag b64url>.<ciphertext b64url>    AES-256-GCM
 *
 * ⚠ ENCRYPTED, NOT HASHED, BECAUSE THE VALUE IS USED, NOT COMPARED. A stolen
 * database, backup or dump holds only ciphertext; the keys live in the
 * environment. Whoever controls the running server can open everything, and
 * no design changes that.
 *
 * ⚠ ONE AES KEY PER WORKSPACE, derived with HKDF from the master key `kid`
 * names, so a key that leaks from one workspace's derivation opens nothing of
 * another's.
 *
 * ⚠ THE COLUMN, THE WORKSPACE AND THE ROW ARE ASSOCIATED DATA. A ciphertext
 * copied to another row, column or workspace fails to open instead of being
 * used there - a DKIM key pasted onto somebody else's domain row signs nothing.
 */

/**
 * Every sealed column, and what its context binds as the row.
 *
 * ⚠ ADDING A SEALED COLUMN IS ADDING AN ENTRY HERE, and only here: the purpose
 * type comes from these keys, and the re-seal job walks this list, so a column
 * missing from it cannot be sealed and cannot be missed by a rotation.
 *
 * `row` is the column whose value is the context's `rowId`. It must never
 * change for the life of the row, which rules out names, slugs and addresses.
 */
export const SEALED_COLUMNS = {
  "core.webhook_endpoints.secret_ciphertext": {
    table: "core.webhook_endpoints",
    column: "secret_ciphertext",
    row: "id",
    shape: "text",
  },
  /**
   * The same secrets after a rotation replaced them: a jsonb list of
   * `{ ciphertext, scheme, expiresAt }`. Its own purpose, so a retired secret
   * cannot be copied back into `secret_ciphertext` and sign again.
   */
  "core.webhook_endpoints.retiring_secrets": {
    table: "core.webhook_endpoints",
    column: "retiring_secrets",
    row: "id",
    shape: "retiring",
  },
  "core.webhook_endpoints.aws_secret_ciphertext": {
    table: "core.webhook_endpoints",
    column: "aws_secret_ciphertext",
    row: "id",
    shape: "text",
  },
  "core.domains.dkim_private_key_sealed": {
    table: "core.domains",
    column: "dkim_private_key_sealed",
    row: "id",
    shape: "text",
  },
  /**
   * ⚠ BOUND TO THE PROVIDER, NOT THE ROW ID. `save` upserts on
   * (tenant, provider), so a reconnect keeps the old row's id while the value
   * is sealed before the database says which id that is. The provider slug is
   * the row's natural key and never changes.
   */
  "core.dns_connections.credential_sealed": {
    table: "core.dns_connections",
    column: "credential_sealed",
    row: "provider",
    shape: "text",
  },
  "identity.connections.secrets": {
    table: "identity.connections",
    column: "secrets",
    row: "id",
    shape: "text",
  },
  "identity.login_attempts.pkce_verifier": {
    table: "identity.login_attempts",
    column: "pkce_verifier",
    row: "id",
    shape: "text",
  },
  /** One row per workspace, keyed by the tenant id itself. */
  "identity.siem_exports.secret_ciphertext": {
    table: "identity.siem_exports",
    column: "secret_ciphertext",
    row: "tenant_id",
    shape: "text",
  },
} as const satisfies Record<
  string,
  {
    table: string
    column: string
    row: "id" | "provider" | "tenant_id"
    shape: "text" | "retiring"
  }
>

export type SealPurpose = keyof typeof SEALED_COLUMNS

/** What a sealed value is bound to. Every field is required on purpose. */
export interface SealContext {
  purpose: SealPurpose
  tenantId: string
  rowId: string
}

export interface Sealer {
  /** The kid `seal` writes under. */
  readonly currentKid: string
  seal(context: SealContext, plaintext: string): string
  open(context: SealContext, sealed: string): string
}

/** Never carries plaintext or key material; safe to log. */
export class SealError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SealError"
  }
}

const VERSION = "v2"
const IV_BYTES = 12

/** Which key a stored value is under, read from its header without opening it. */
export function sealedUnder(
  sealed: string,
): { version: "v1" } | { version: "v2"; kid: string } | null {
  const parts = sealed.split(".")
  if (parts[0] === "v1" && parts.length === 4) return { version: "v1" }
  if (parts[0] === VERSION && parts.length === 5 && parts[1]) {
    return { version: "v2", kid: parts[1] }
  }
  return null
}

function part(name: string, value: string): string {
  // ⚠ A SLASH WOULD LET TWO DIFFERENT CONTEXTS SPELL THE SAME AAD.
  if (!value || value.includes("/")) {
    throw new SealError(`a seal context needs a ${name} with no "/"`)
  }
  return value
}

const aad = ({ purpose, tenantId, rowId }: SealContext) =>
  Buffer.from(
    `i10/seal/${VERSION}/${purpose}/${part("tenantId", tenantId)}/${part("rowId", rowId)}`,
  )

const workspaceKey = (master: Buffer, tenantId: string) =>
  Buffer.from(
    hkdfSync(
      "sha256",
      master,
      Buffer.alloc(0),
      `i10/seal/${VERSION}/workspace-key/${part("tenantId", tenantId)}`,
      32,
    ),
  )

export function sealer(keys: Keyring, legacyKey?: string): Sealer {
  const legacy = legacyKey ? legacyV1Key(legacyKey) : null

  return {
    currentKid: keys.current,

    seal(context, plaintext) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(
        "aes-256-gcm",
        workspaceKey(currentKey(keys), context.tenantId),
        iv,
      )
      cipher.setAAD(aad(context))
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ])
      return [
        VERSION,
        keys.current,
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".")
    },

    open(context, sealed) {
      const under = sealedUnder(sealed)
      if (!under) throw new SealError("unrecognised sealed value")
      if (under.version === "v1") {
        if (!legacy) {
          throw new SealError(
            "this value is sealed in the v1 format and WEBHOOK_SECRET_KEY, the legacy key that opens it, is not configured",
          )
        }
        return openLegacyV1(legacy, sealed)
      }

      const master = keys.keys.get(under.kid)
      if (!master) {
        throw new SealError(
          `this value is sealed under key ${under.kid}, which is not in SEAL_KEYS`,
        )
      }
      const [, , iv, tag, ciphertext] = sealed.split(".") as [
        string,
        string,
        string,
        string,
        string,
      ]
      const decipher = createDecipheriv(
        "aes-256-gcm",
        workspaceKey(master, context.tenantId),
        Buffer.from(iv, "base64url"),
      )
      decipher.setAAD(aad(context))
      decipher.setAuthTag(Buffer.from(tag, "base64url"))
      try {
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8")
      } catch {
        // GCM cannot tell a changed byte from a different context; both are
        // a value that is not this row's.
        throw new SealError(
          `this value does not open as ${context.purpose} of this row: it was tampered with, or sealed for another row, column or workspace`,
        )
      }
    },
  }
}

/** `SEAL_KEYS`, with the legacy key if one is set. Null: sealing is off. */
export function sealerFromEnv(env: {
  SEAL_KEYS?: string | undefined
  WEBHOOK_SECRET_KEY?: string | undefined
}): Sealer | null {
  if (!env.SEAL_KEYS) return null
  return sealer(keyringFromEnv("SEAL_KEYS", env.SEAL_KEYS), env.WEBHOOK_SECRET_KEY)
}

// ── Legacy v1 ───────────────────────────────────────────────────────────────
//
// ⚠ LEGACY, READ ONLY, AND DELETED WITH `WEBHOOK_SECRET_KEY`. The old format
// had one key for everything, no key id and no associated data. It is opened
// here only until `scripts/reseal-secrets.ts` reports no v1 value left.

function legacyV1Key(key: string): Buffer {
  const bytes = /^[0-9a-fA-F]{64}$/.test(key)
    ? Buffer.from(key, "hex")
    : Buffer.from(key, "base64")
  if (bytes.length !== 32) {
    throw new SealError(`WEBHOOK_SECRET_KEY must be 32 bytes, hex or base64`)
  }
  return bytes
}

function openLegacyV1(key: Buffer, sealed: string): string {
  const [, iv, tag, ciphertext] = sealed.split(".") as [string, string, string, string]
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    throw new SealError("this v1 value does not open under WEBHOOK_SECRET_KEY")
  }
}
