/**
 * Operator CLI for `authd.mail_devices` (#383).
 *
 * FOR THROWAWAY-ACCOUNT PROBES ON PRODUCTION ONLY until PR 4/5 ship the
 * user-facing enrollment and management routes. Never mint a device code for a
 * customer account through this script.
 *
 * Required environment variables:
 *   DATABASE_URL           Postgres connection string (application role `i10_api`)
 *   MAIL_DEVICE_CODE_KEYS  `<id>:<base64 >= 32 bytes>`, comma-separated (`mint` only)
 *
 * Commands:
 *   bun scripts/mail-device.ts mint --email <addr> --platform <ios|ipados|macos> --name <n> [--model <m>] [--serial <s>]
 *   bun scripts/mail-device.ts list --email <addr>
 *   bun scripts/mail-device.ts revoke --id <uuid>
 *   bun scripts/mail-device.ts bind-key <device id> <certificate.pem>
 *   bun scripts/mail-device.ts unbind-key <device id>
 *   bun scripts/mail-device.ts acme-permit <device id>
 *
 * `mint` writes ONLY the device code to stdout, and `acme-permit` ONLY the
 * permit's nonce (metadata goes to stderr); neither is logged anywhere.
 *
 * `bind-key` and `unbind-key` (#383 PR 3) set or clear a Mac's certificate key
 * (SHA-256 of the leaf's SubjectPublicKeyInfo), claim the first use (bind only)
 * and delete the device's liveness rows, in one transaction, accounts first.
 * `acme-permit` opens the permit step-ca's ACME `AUTHORIZING` hook needs; the
 * nonce goes in the certificate's `OU`.
 */
import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { createDb } from "../src/db/client.js"
import { MailDeviceError, parseMailDeviceCodeKeys } from "../src/mail-devices/code.js"
import { createAcmePermit, sha256 } from "../src/mail-devices/permits.js"
import {
  MAIL_DEVICE_PLATFORMS,
  accountByEmail,
  bindKey,
  deviceTenantForOperator,
  list,
  mint,
  revoke,
  unbindKey,
  type MailDevicePlatform,
} from "../src/mail-devices/store.js"

export type MailDeviceCommand =
  | {
      action: "mint"
      email: string
      platform: MailDevicePlatform
      name: string
      model: string | null
      serial: string | null
    }
  | { action: "list"; email: string }
  | { action: "revoke"; id: string }
  | { action: "bind-key"; id: string; certificatePath: string }
  | { action: "unbind-key"; id: string }
  | { action: "acme-permit"; id: string }

const USAGE = `Usage:
  bun scripts/mail-device.ts mint --email <addr> --platform <ios|ipados|macos> --name <n> [--model <m>] [--serial <s>]
  bun scripts/mail-device.ts list --email <addr>
  bun scripts/mail-device.ts revoke --id <uuid>
  bun scripts/mail-device.ts bind-key <device id> <certificate.pem>
  bun scripts/mail-device.ts unbind-key <device id>
  bun scripts/mail-device.ts acme-permit <device id>`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Exactly `count` positional arguments, the first a device id. */
function positional(action: string, rest: readonly string[], names: readonly string[]) {
  if (
    rest.length !== names.length ||
    rest.some((arg) => !arg || arg.startsWith("--"))
  ) {
    throw new Error(`${action} takes ${names.map((n) => `<${n}>`).join(" ")}`)
  }
  if (!UUID.test(rest[0]!)) {
    throw new Error(`${action}: "${rest[0]}" is not a device id`)
  }
  return rest
}

/**
 * SHA-256 of the FIRST certificate's SubjectPublicKeyInfo DER in a PEM file:
 * the leaf, which is how a chain file is ordered.
 */
export function leafKeySha256(pem: string): Buffer {
  const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)
  if (!first) throw new Error("no PEM certificate found")
  const leaf = new X509Certificate(first[0])
  return sha256(leaf.publicKey.export({ type: "spki", format: "der" }))
}

function takeFlags(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`)
    }
    const key = token.slice(2)
    const value = argv[i + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`)
    }
    flags[key] = value
    i++
  }
  return flags
}

export function parseMailDeviceArgs(argv: readonly string[]): MailDeviceCommand {
  const [action, ...rest] = argv
  if (!action || action === "--help" || action === "-h") {
    throw new Error(USAGE)
  }
  if (action === "bind-key") {
    const [id, certificatePath] = positional(action, rest, [
      "device id",
      "certificate.pem",
    ])
    return { action, id: id!.toLowerCase(), certificatePath: certificatePath! }
  }
  if (action === "unbind-key" || action === "acme-permit") {
    const [id] = positional(action, rest, ["device id"])
    return { action, id: id!.toLowerCase() }
  }
  const flags = takeFlags(rest)

  if (action === "mint") {
    const email = flags.email?.trim().toLowerCase()
    const platform = flags.platform?.trim().toLowerCase()
    const name = flags.name?.trim()
    if (!email || !email.includes("@")) {
      throw new Error("mint requires --email <addr>")
    }
    if (!platform || !(MAIL_DEVICE_PLATFORMS as readonly string[]).includes(platform)) {
      throw new Error(`mint requires --platform <${MAIL_DEVICE_PLATFORMS.join("|")}>`)
    }
    if (!name) {
      throw new Error("mint requires --name <n>")
    }
    return {
      action: "mint",
      email,
      platform: platform as MailDevicePlatform,
      name,
      model: flags.model?.trim() || null,
      serial: flags.serial?.trim() || null,
    }
  }

  if (action === "list") {
    const email = flags.email?.trim().toLowerCase()
    if (!email || !email.includes("@")) {
      throw new Error("list requires --email <addr>")
    }
    return { action: "list", email }
  }

  if (action === "revoke") {
    const id = flags.id?.trim()
    if (!id) {
      throw new Error("revoke requires --id <uuid>")
    }
    return { action: "revoke", id }
  }

  throw new Error(`Unknown command "${action}".\n${USAGE}`)
}

/** The database url every command needs. */
export function requireDatabaseUrl(env: Record<string, string | undefined>): string {
  const databaseUrl = env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.")
  }
  return databaseUrl
}

/** `mint`'s environment: the database and the code key ring. */
export function requireOperatorEnv(env: Record<string, string | undefined>) {
  const databaseUrl = requireDatabaseUrl(env)
  const rawKeys = env.MAIL_DEVICE_CODE_KEYS?.trim()
  if (!rawKeys) {
    throw new Error("MAIL_DEVICE_CODE_KEYS is required.")
  }
  const keys = parseMailDeviceCodeKeys(rawKeys)
  return { databaseUrl, keys }
}

async function main() {
  let command: MailDeviceCommand
  let databaseUrl: string
  let keys: ReturnType<typeof requireOperatorEnv>["keys"] | null = null
  try {
    command = parseMailDeviceArgs(process.argv.slice(2))
    if (command.action === "mint") {
      ;({ databaseUrl, keys } = requireOperatorEnv(process.env))
    } else {
      databaseUrl = requireDatabaseUrl(process.env)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const { sql, db } = createDb(databaseUrl)
  try {
    if (command.action === "bind-key") {
      const keySha256 = leafKeySha256(readFileSync(command.certificatePath, "utf8"))
      await bindKey(db, { deviceId: command.id, keySha256 })
      console.log(`Bound key ${keySha256.toString("hex")} to mail device ${command.id}`)
      return
    }

    if (command.action === "unbind-key") {
      const had = await unbindKey(db, { deviceId: command.id })
      console.log(
        had
          ? `Cleared the key of mail device ${command.id}`
          : `Mail device ${command.id} had no key; its liveness rows are cleared`,
      )
      return
    }

    if (command.action === "acme-permit") {
      const permit = await createAcmePermit(db, { deviceId: command.id })
      console.error(
        `Opened ACME permit ${permit.permitId} for mail device ${command.id}, until ${permit.expiresAt.toISOString()}`,
      )
      // Print ONLY the nonce to stdout, once: it goes in the certificate's OU.
      process.stdout.write(`${permit.nonce}\n`)
      return
    }

    if (command.action === "mint") {
      const account = await accountByEmail(db, command.email)
      if (!account) {
        console.error(`No authd.accounts row found for ${command.email}`)
        process.exit(1)
      }
      const { device, code } = await mint(db, keys, {
        clerkUserId: account.clerkUserId,
        tenantId: account.tenantId,
        expectedEpoch: account.credentialEpoch,
        platform: command.platform,
        deviceName: command.name,
        model: command.model,
        serial: command.serial,
        createdBy: "operator:mail-device",
      })
      console.error(
        `Minted mail device ${device.id} for ${device.email} (${device.platform}, ${device.deviceName ?? "unnamed"})`,
      )
      // Print ONLY the code to stdout, never to logs.
      process.stdout.write(`${code}\n`)
      return
    }

    if (command.action === "list") {
      const account = await accountByEmail(db, command.email)
      if (!account) {
        console.error(`No authd.accounts row found for ${command.email}`)
        process.exit(1)
      }
      const devices = await list(db, {
        tenantId: account.tenantId,
        clerkUserId: account.clerkUserId,
      })
      console.log(
        JSON.stringify(
          devices.map((d) => ({
            id: d.id,
            email: d.email,
            platform: d.platform,
            deviceName: d.deviceName,
            model: d.model,
            serial: d.serial,
            createdBy: d.createdBy,
            createdAt: d.createdAt.toISOString(),
            firstUsedAt: d.firstUsedAt?.toISOString() ?? null,
            lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
          })),
          null,
          2,
        ),
      )
      return
    }

    if (command.action === "revoke") {
      const lookup = await deviceTenantForOperator(db, command.id)
      if (!lookup.exists) {
        console.error(`No mail device found with id ${command.id}`)
        process.exit(1)
      }
      const deleted = await revoke(db, {
        tenantId: lookup.tenantId,
        deviceId: command.id,
      })
      if (!deleted) {
        console.error(`Mail device ${command.id} was already revoked`)
        process.exit(1)
      }
      console.log(`Revoked mail device ${command.id}`)
    }
  } catch (error) {
    if (error instanceof MailDeviceError) {
      console.error(`Refused (${error.code}): ${error.message}`)
    } else {
      console.error(error instanceof Error ? error.message : String(error))
    }
    process.exit(1)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (import.meta.main) {
  await main()
}
