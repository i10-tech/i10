import { createHmac, randomBytes } from "node:crypto"
import { z } from "zod"
import type { Database } from "../db/client.js"
import type { MailDeviceCodeKeys } from "../mail-devices/code.js"
import type { DeviceCaBundle } from "../mail-devices/cms.js"
import {
  attestEnrollment,
  finishEnrollment,
  peekEnrollment,
} from "../mail-devices/enrollments.js"
import type { MailDeviceEnrolledNotifier } from "../mail-devices/notice.js"
import type { HookLog } from "./listener.js"

/**
 * Internal `/enrolld/*` handlers served on the `:3443` listener (#383 PR 4,
 * docs/research/mail-device-binding.md section 12 + Review 1 rules).
 *
 * Authoritative contract with `cmd/enrolld`:
 *   - `POST /enrolld/peek`   `{"token": string}` -> 200 `{"live": boolean}`
 *   - `POST /enrolld/attest` `{token, udid, serial, product, version, deviceName, model, appleSignerSha256}`
 *                            -> 200 `{"outcome":"scep","serial":string,"challenge":string}`
 *                            or 200 `{"outcome":"refused","reason":string}`
 *   - `POST /enrolld/finish` `{"certDer":"<base64>","udid":string|null}`
 *                            -> 200 `{"outcome":"sealed","profile":"<base64>"}`
 *                            or 200 `{"outcome":"refused","reason":string}`
 *
 * ⚠ NEVER LOGS a token, a challenge, the inner plist, a device code, or a raw
 * serial. Any logged serial identifier is HMAC-SHA256 under a random
 * per-process key (Review 1 smaller rules).
 */

export const ENROLLD_CALLS = ["peek", "attest", "finish"] as const
export type EnrolldCall = (typeof ENROLLD_CALLS)[number]

export interface EnrolldHandlerResult {
  /** Safe fixed log fields (never secrets or raw serials). */
  outcome: string
  /** Optional safe log metadata (product, keyed serial hash). */
  logFields?: Record<string, unknown>
  /** Exact JSON response body written with HTTP 200. */
  body: Record<string, unknown>
}

export type EnrolldHandler = (
  body: unknown,
  now: Date,
  deadline: Date,
) => Promise<EnrolldHandlerResult>

export type EnrolldHandlers = Readonly<Record<EnrolldCall, EnrolldHandler>>

const STD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const SHA256_HEX = /^[0-9a-fA-F]{64}$/
const SERIAL = /^[\x21-\x7e]{1,64}$/
// Phase 2 attributes are claims any Apple-activated key can sign. They are
// stored, shown on the console and put in the notice email's subject, so no
// control character (CR/LF header injection, #189) gets past here.
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/
const NO_CONTROL = /^\P{Cc}*$/u

/** A required printable-ASCII claim, trimmed. */
const asciiClaim = (max: number) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1).max(max).regex(PRINTABLE_ASCII))

/**
 * An optional free-text claim (a device name can be any language), trimmed and
 * cut to `max` characters rather than refused: a long name is the person's own
 * choice, and refusing it would leave their enrollment open with no reason
 * shown. enrolld already caps every value at 512 bytes.
 */
const textClaim = (max: number) =>
  z
    .string()
    .regex(NO_CONTROL)
    .nullish()
    .transform((v) => {
      const cut = Array.from(v?.trim() ?? "")
        .slice(0, max)
        .join("")
        .trimEnd()
      return cut ? cut : null
    })

const peekBody = z.object({
  token: z.string().min(1).max(255),
})

const attestBody = z.object({
  token: z.string().min(1).max(255),
  udid: asciiClaim(128),
  serial: z.string().regex(SERIAL),
  product: asciiClaim(64),
  version: asciiClaim(64),
  deviceName: textClaim(128),
  model: textClaim(128),
  appleSignerSha256: z
    .string()
    .regex(SHA256_HEX)
    .transform((hex) => Buffer.from(hex.toLowerCase(), "hex")),
})

const finishBody = z.object({
  certDer: z
    .string()
    .min(1)
    .max(32 * 1024)
    .regex(STD_BASE64)
    .transform((b64) => Buffer.from(b64, "base64")),
  udid: z
    .string()
    .max(128)
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null)),
})

/** Per-process random key for logging serial hashes without storing/printing raw serials. */
const SERIAL_LOG_KEY = randomBytes(32)

/** Keyed digest of a serial safe for logs (Review 1: never a plain prefix). */
export function keyedSerialDigest(serial: string): string {
  return createHmac("sha256", SERIAL_LOG_KEY).update(serial).digest("hex").slice(0, 16)
}

export interface CreateEnrolldHandlersDeps {
  db: Pick<Database, "transaction">
  keys: MailDeviceCodeKeys | null | undefined
  deviceCaBundle: () => DeviceCaBundle | null
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  organization: string
  acmeDirectoryUrl?: string
  notifyEnrolled?: MailDeviceEnrolledNotifier
  log: HookLog
}

export function createEnrolldHandlers(
  deps: CreateEnrolldHandlersDeps,
): EnrolldHandlers {
  return {
    peek: async (raw, _now, deadline) => {
      const parsed = peekBody.safeParse(raw)
      if (!parsed.success) {
        return { outcome: "bad_body", body: { live: false } }
      }
      const { live } = await peekEnrollment(deps.db, parsed.data.token, deadline)
      return { outcome: live ? "live" : "not_live", body: { live } }
    },

    attest: async (raw, _now, deadline) => {
      const parsed = attestBody.safeParse(raw)
      if (!parsed.success) {
        return {
          outcome: "bad_body",
          body: { outcome: "refused", reason: "bad_body" },
        }
      }
      const data = parsed.data
      const result = await attestEnrollment(deps.db, data, deadline)
      const logFields = {
        product: data.product,
        serialHash: keyedSerialDigest(data.serial),
      }
      if (result.outcome === "refused") {
        return {
          outcome: `refused_${result.reason}`,
          logFields,
          body: { outcome: "refused", reason: result.reason },
        }
      }
      return {
        outcome: "scep",
        logFields,
        body: {
          outcome: "scep",
          serial: result.serial,
          challenge: result.challenge,
        },
      }
    },

    finish: async (raw, now, deadline) => {
      const parsed = finishBody.safeParse(raw)
      if (!parsed.success) {
        return {
          outcome: "bad_body",
          body: { outcome: "refused", reason: "bad_body" },
        }
      }
      const result = await finishEnrollment(
        deps.db,
        {
          keys: deps.keys,
          deviceCaBundle: deps.deviceCaBundle,
          imapHost: deps.imapHost,
          imapPort: deps.imapPort,
          smtpHost: deps.smtpHost,
          smtpPort: deps.smtpPort,
          organization: deps.organization,
          acmeDirectoryUrl: deps.acmeDirectoryUrl,
          now: () => now,
        },
        parsed.data,
        deadline,
      )
      if (result.outcome === "refused") {
        return {
          outcome: `refused_${result.reason}`,
          body: { outcome: "refused", reason: result.reason },
        }
      }

      // The post-seal notice email goes out after the transaction committed, and
      // the device's answer never waits for it: the listener ends a call after
      // HANDLER_TIMEOUT_MS, and a slow mail path must not turn a sealed enrollment
      // into a 503. A send
      // failure never undoes the seal; it logs safe fields only.
      if (!result.replayed && result.notice && deps.notifyEnrolled) {
        const notify = deps.notifyEnrolled
        const notice = result.notice
        void Promise.resolve()
          .then(() => notify(notice))
          .catch((error: unknown) => {
            deps.log.error(
              {
                hook: "enrolld/finish",
                outcome: "notice_failed",
                errorName: error instanceof Error ? error.name : "unknown",
              },
              "failed to send mail device enrolled notice",
            )
          })
      }

      return {
        outcome: result.replayed ? "sealed_replay" : "sealed",
        body: {
          outcome: "sealed",
          profile: result.profile.toString("base64"),
        },
      }
    },
  }
}
