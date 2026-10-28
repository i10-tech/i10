import { createHash } from "node:crypto"
import { SignatureV4 } from "@smithy/signature-v4"
import { z } from "zod"
import { Sha256 } from "../webhooks/sqs.js"
import type { OidcFetch } from "./oidc-fetch.js"
import type { StoredEvent } from "./ports.js"

/**
 * The SIEM export (#345, sso.md 2.21): the workspace's identity audit log,
 * written hourly as newline-delimited JSON to the customer's own
 * S3-compatible bucket.
 *
 * ⚠ THE CUSTOMER'S BUCKET AND THE CUSTOMER'S KEY, SO EVERY CHOICE HERE ASSUMES
 * NEITHER IS FRIENDLY. The endpoint is https only and goes through the webhook
 * egress guard on write AND on every request (`guardedFetch`: resolved, every
 * address vetted public, connection pinned, no redirects, a deadline); the key
 * is sealed and never returned; an error we report carries the HTTP status and
 * S3's error code and never the response body or the request.
 *
 * ⚠ AT-LEAST-ONCE, IN ORDER, NEVER SKIPPING. The cursor is the last event id in
 * the bucket and moves only after the PUT answered 2xx, so a crash between the
 * PUT and the cursor repeats a window (the object key names its ids, so the
 * repeat overwrites the same object) and a failed PUT repeats it too.
 *
 * ⚠ PATH-STYLE ADDRESSING (`<endpoint>/<bucket>/<key>`), because it is the one
 * form every S3-compatible store accepts at a custom endpoint, and the bucket
 * name never has to be a DNS label. Signed with SigV4 by the same AWS signer
 * the SQS webhook destination uses (`@smithy/signature-v4`, already a
 * dependency) - nothing new.
 */

export const SIEM_BATCH = 5_000
/** Objects written in one run; a backlog drains over the next runs. */
export const SIEM_MAX_OBJECTS_PER_RUN = 20
export const SIEM_EVERY_MS = 60 * 60_000
/** A failed run is tried again sooner than the hour. */
export const SIEM_RETRY_MS = 15 * 60_000
/** A claim holds the row this long, so a dead run is retried, not lost. */
export const SIEM_LEASE_MS = 10 * 60_000

// ── Settings ────────────────────────────────────────────────────────────────

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const REGION = /^[a-z0-9-]{2,32}$/
const PREFIX_SEGMENT = /^[A-Za-z0-9._=-]{1,100}$/
const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/

/** A prefix is `a/b/c`: no leading, trailing or doubled slash, no `.` or `..` segment. */
const prefixOk = (value: string) =>
  value === "" ||
  (value.length <= 200 &&
    value
      .split("/")
      .every((seg) => PREFIX_SEGMENT.test(seg) && seg !== "." && seg !== ".."))

export const siemSettingsSchema = z
  .object({
    endpoint: z
      .string()
      .max(300)
      .refine((v) => {
        try {
          const u = new URL(v)
          return (
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            (u.pathname === "/" || u.pathname === "") &&
            !u.search &&
            !u.hash
          )
        } catch {
          return false
        }
      }, "endpoint must be an https URL with no path, credentials or query."),
    bucket: z.string().regex(BUCKET, "bucket is not a valid bucket name."),
    region: z.string().regex(REGION, "region is not valid."),
    prefix: z.string().refine(prefixOk, "prefix is not valid.").default(""),
    accessKeyId: z
      .string()
      .regex(ACCESS_KEY_ID, "accessKeyId is not an access key id."),
    /** Required on the first save; on a later one, absent keeps the stored key. */
    secretAccessKey: z
      .string()
      .min(16)
      .max(256)
      .regex(/^\S+$/, "secretAccessKey is not a secret access key.")
      .optional(),
    enabled: z.boolean().default(true),
  })
  .strict()

export type SiemSettings = z.infer<typeof siemSettingsSchema>

/** What is stored for a workspace. The secret is not in it. */
export interface SiemRow {
  tenantId: string
  endpoint: string
  bucket: string
  region: string
  prefix: string
  accessKeyId: string
  secretHint: string
  enabled: boolean
  lastEventId: string | null
  lastExportAt: Date | null
  lastError: string | null
  lastErrorAt: Date | null
  nextRunAt: Date
}

/** The console's view: the secret is a hint, never the value. */
export function presentSiem(row: SiemRow) {
  return {
    endpoint: row.endpoint,
    bucket: row.bucket,
    region: row.region,
    prefix: row.prefix,
    accessKeyId: row.accessKeyId,
    secretAccessKey: `••••${row.secretHint}`,
    enabled: row.enabled,
    lastExportAt: row.lastExportAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
  }
}

export interface SiemStore {
  get(tenantId: string): Promise<SiemRow | null>
  /** The settings with the secret opened: only the exporter asks. */
  withSecret(tenantId: string): Promise<(SiemRow & { secretAccessKey: string }) | null>
  put(
    tenantId: string,
    settings: SiemSettings & { secretAccessKey: string },
    by: string,
  ): Promise<SiemRow>
  /** Only the non-secret fields; the stored secret stays. */
  update(
    tenantId: string,
    settings: Omit<SiemSettings, "secretAccessKey">,
    by: string,
  ): Promise<SiemRow | null>
  remove(tenantId: string): Promise<boolean>
  /** Events after the cursor in id order. */
  eventsAfter(
    tenantId: string,
    after: string | null,
    limit: number,
  ): Promise<StoredEvent[]>
  /**
   * Takes the run: true when the row is enabled and due, moving it `leaseMs`
   * forward in the same statement.
   */
  claim(tenantId: string, leaseMs: number): Promise<SiemRow | null>
  /** An object was written: the cursor moves, the last export is now, any error clears. */
  progressed(tenantId: string, lastEventId: string): Promise<void>
  /** The run ended well: the next one is due in `ms`. */
  rescheduled(tenantId: string, ms: number): Promise<void>
  failed(tenantId: string, error: string, retryMs: number): Promise<void>
  due(after: string | null, limit: number): Promise<string[]>
}

// ── The object ──────────────────────────────────────────────────────────────

/** `<prefix>/i10-identity/<yyyy>/<mm>/<dd>/<from-id>-<to-id>.jsonl`, by the last event's day. */
export function objectKey(
  prefix: string,
  day: Date,
  fromId: string,
  toId: string,
): string {
  const yyyy = String(day.getUTCFullYear())
  const mm = String(day.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(day.getUTCDate()).padStart(2, "0")
  return [
    ...(prefix ? [prefix] : []),
    "i10-identity",
    yyyy,
    mm,
    dd,
    `${fromId}-${toId}.jsonl`,
  ].join("/")
}

/**
 * One line per event, in the audit log's own words.
 *
 * ⚠ BUILT FIELD BY FIELD, NOT SPREAD: the audit data never holds a secret
 * (db/identity.ts), and this makes it so no future column reaches a customer's
 * bucket without being named here.
 */
export function toJsonl(events: readonly StoredEvent[]): string {
  return events
    .map((e) =>
      JSON.stringify({
        id: e.id,
        type: e.type,
        actor_user_id: e.actorUserId,
        subject_user_id: e.subjectUserId,
        connection_id: e.connectionId,
        session_id: e.sessionId,
        reason: e.reason,
        data: e.data,
        created_at: e.createdAt.toISOString(),
      }),
    )
    .join("\n")
    .concat("\n")
}

// ── The request ─────────────────────────────────────────────────────────────

export interface PutDeps {
  fetch: OidcFetch
  now?: () => Date
}

/**
 * PUT one object. Throws `SiemRefused` with a message safe to store and show:
 * the status and S3's error code only.
 */
export class SiemRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SiemRefused"
  }
}

export async function putObject(
  d: PutDeps,
  target: Pick<SiemRow, "endpoint" | "bucket" | "region"> & {
    accessKeyId: string
    secretAccessKey: string
  },
  key: string,
  body: string,
  contentType: string,
): Promise<void> {
  const url = new URL(target.endpoint)
  const path = `/${target.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`
  const signer = new SignatureV4({
    service: "s3",
    region: target.region,
    credentials: {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
    },
    sha256: Sha256,
    // ⚠ S3 SIGNS THE PATH AS SENT, NOT DOUBLE-ENCODED (SigV4 for S3).
    uriEscapePath: false,
  })
  const signed = await signer.sign(
    {
      method: "PUT",
      protocol: "https:",
      hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      path,
      query: {},
      headers: {
        host: url.host,
        "content-type": contentType,
        "content-md5": createHash("md5").update(body).digest("base64"),
      },
      body,
    },
    { signingDate: (d.now ?? (() => new Date()))() },
  )
  let response: Response
  try {
    response = await d.fetch(`${url.origin}${path}`, {
      method: "PUT",
      headers: signed.headers as Record<string, string>,
      body,
      redirect: "manual",
    })
  } catch (error) {
    // The guard's own message names the host and the reason, nothing else.
    throw new SiemRefused(error instanceof Error ? error.message : "request failed")
  }
  if (response.status >= 200 && response.status < 300) return
  const text = await response.text().catch(() => "")
  const code = /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(text)?.[1]
  throw new SiemRefused(
    `The bucket answered ${response.status}${code ? ` ${code}` : ""}.`,
  )
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface ExportDeps {
  store: SiemStore
  fetch: OidcFetch
  /** The plan flag (identity/features.ts): a refused plan exports nothing. */
  allowed(tenantId: string): Promise<boolean>
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }
  now?: () => Date
}

export type ExportOutcome =
  | { outcome: "not_due" }
  | { outcome: "plan_required" }
  | { outcome: "exported"; objects: number; events: number }
  | { outcome: "failed"; error: string }

/**
 * One workspace's run: claim it, write what is new, move the cursor.
 *
 * ⚠ DUE IS RE-CHECKED HERE, IN THE DATABASE, NOT TAKEN FROM THE JOB. The job
 * only says "look at this workspace"; `claim` is the compare-and-set on
 * `next_run_at`, so a job that ran early (groupmq's retry floors time to the
 * second), a duplicate from another replica, or a stale one after the settings
 * were turned off finds nothing due and does nothing.
 *
 * ⚠ THE CURSOR MOVES AFTER EACH OBJECT, not at the end: a run that writes
 * three of five objects and then fails has still made progress.
 */
export async function runSiemExport(
  d: ExportDeps,
  tenantId: string,
): Promise<ExportOutcome> {
  const now = d.now ?? (() => new Date())
  const claimed = await d.store.claim(tenantId, SIEM_LEASE_MS)
  if (!claimed) return { outcome: "not_due" }
  if (!(await d.allowed(tenantId))) {
    await d.store.failed(
      tenantId,
      "Your plan does not include the SIEM export.",
      SIEM_EVERY_MS,
    )
    return { outcome: "plan_required" }
  }
  const settings = await d.store.withSecret(tenantId)
  if (!settings) return { outcome: "not_due" }

  let cursor = claimed.lastEventId
  let objects = 0
  let events = 0
  try {
    let drained = false
    for (let i = 0; i < SIEM_MAX_OBJECTS_PER_RUN && !drained; i++) {
      const batch = await d.store.eventsAfter(tenantId, cursor, SIEM_BATCH)
      if (batch.length === 0) break
      const first = batch[0]!
      const last = batch[batch.length - 1]!
      await putObject(
        { fetch: d.fetch, now },
        settings,
        objectKey(settings.prefix, last.createdAt, first.id, last.id),
        toJsonl(batch),
        "application/x-ndjson",
      )
      cursor = last.id
      objects++
      events += batch.length
      await d.store.progressed(tenantId, cursor)
      drained = batch.length < SIEM_BATCH
    }
    // More waiting than one run writes: come back at the next tick, not in an hour.
    const more = objects === SIEM_MAX_OBJECTS_PER_RUN && !drained
    await d.store.rescheduled(tenantId, more ? 0 : SIEM_EVERY_MS)
    return { outcome: "exported", objects, events }
  } catch (error) {
    const message =
      error instanceof SiemRefused ? error.message : "The export failed unexpectedly."
    if (!(error instanceof SiemRefused))
      d.log.warn({ tenantId, err: String(error) }, "SIEM export failed")
    await d.store.failed(tenantId, message, SIEM_RETRY_MS)
    return { outcome: "failed", error: message }
  }
}

/** Writes a small object to prove the endpoint, bucket, region and key work. */
export async function testSiem(
  d: PutDeps,
  target: Parameters<typeof putObject>[1] & { prefix: string },
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const at = (d.now ?? (() => new Date()))()
  const key = [
    ...(target.prefix ? [target.prefix] : []),
    "i10-identity",
    `connection-test-${at.toISOString().replace(/[:.]/g, "-")}.txt`,
  ].join("/")
  try {
    await putObject(
      d,
      target,
      key,
      "i10 identity export: connection test\n",
      "text/plain",
    )
    return { ok: true, key }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof SiemRefused ? error.message : "The test failed.",
    }
  }
}
