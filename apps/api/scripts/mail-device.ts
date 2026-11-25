/**
 * Operator CLI for `authd.mail_devices` (#383).
 *
 * FOR THROWAWAY-ACCOUNT PROBES ON PRODUCTION ONLY until PR 4/5 ship the
 * user-facing enrollment and management routes. Never mint a device code for a
 * customer account through this script.
 *
 * Required environment variables:
 *   DATABASE_URL           Postgres connection string (application role `i10_api`)
 *   MAIL_DEVICE_CODE_KEYS  `<id>:<base64 >= 32 bytes>`, comma-separated
 *
 * Commands:
 *   bun scripts/mail-device.ts mint --email <addr> --platform <ios|ipados|macos> --name <n> [--model <m>] [--serial <s>]
 *   bun scripts/mail-device.ts list --email <addr>
 *   bun scripts/mail-device.ts revoke --id <uuid>
 *
 * `mint` writes ONLY the device code to stdout (metadata goes to stderr) and
 * never logs the code anywhere.
 */
import { createDb } from "../src/db/client.js"
import { MailDeviceError, parseMailDeviceCodeKeys } from "../src/mail-devices/code.js"
import {
  MAIL_DEVICE_PLATFORMS,
  accountByEmail,
  deviceTenantForOperator,
  list,
  mint,
  revoke,
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

const USAGE = `Usage:
  bun scripts/mail-device.ts mint --email <addr> --platform <ios|ipados|macos> --name <n> [--model <m>] [--serial <s>]
  bun scripts/mail-device.ts list --email <addr>
  bun scripts/mail-device.ts revoke --id <uuid>`

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

export function requireOperatorEnv(env: Record<string, string | undefined>) {
  const databaseUrl = env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.")
  }
  const rawKeys = env.MAIL_DEVICE_CODE_KEYS?.trim()
  if (!rawKeys) {
    throw new Error("MAIL_DEVICE_CODE_KEYS is required.")
  }
  const keys = parseMailDeviceCodeKeys(rawKeys)
  return { databaseUrl, keys }
}

async function main() {
  let command: MailDeviceCommand
  let config: ReturnType<typeof requireOperatorEnv>
  try {
    command = parseMailDeviceArgs(process.argv.slice(2))
    config = requireOperatorEnv(process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const { sql, db } = createDb(config.databaseUrl)
  try {
    if (command.action === "mint") {
      const account = await accountByEmail(db, command.email)
      if (!account) {
        console.error(`No authd.accounts row found for ${command.email}`)
        process.exit(1)
      }
      const { device, code } = await mint(db, config.keys, {
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
