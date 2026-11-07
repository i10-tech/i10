import type { Context, Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import {
  presentSiem,
  siemSettingsSchema,
  testSiem,
  type SiemStore,
} from "../../identity/siem.js"
import type { EgressVerdict } from "../../webhooks/egress.js"
import type { OidcFetch } from "../../identity/oidc-fetch.js"

/**
 * The SIEM export's settings (#345, identity/siem.ts).
 *
 *   GET    /identity/siem        the settings, with the secret as a hint (sso:manage)
 *   PUT    /identity/siem        save them (owner, step-up)
 *   DELETE /identity/siem        stop exporting and forget the key (owner, step-up)
 *   POST   /identity/siem/test   write a small object to the bucket (owner, step-up)
 *
 * ⚠ THE SECRET ACCESS KEY GOES IN AND NEVER COMES BACK: no read returns it,
 * only `••••` and its last four characters, and neither the audit event nor a
 * log line carries it. A change that omits it keeps the stored one.
 *
 * ⚠ THE ENDPOINT IS VETTED WHEN IT IS SAVED (https, public addresses only: the
 * webhook egress guard) and again on every request the export makes. A
 * refusal here is a 422 naming the reason, so a typo or an internal address is
 * found by the person typing it.
 *
 * ⚠ READING IS AN ADMIN'S, CHANGING IS AN OWNER'S WITH STEP-UP, and every
 * change is an audit event with the actor - the destination of the whole audit
 * log is a trust decision, the kind sso.md 2.14 keeps with owners.
 */
export interface SiemConsoleDeps {
  store: SiemStore
  /** `vetHost` with the deployment's allow list (index.ts). */
  vet: (host: string, signal: AbortSignal) => Promise<EgressVerdict>
  fetch: OidcFetch
}

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

export function mountIdentitySiem(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }
  const load = async (c: Context, permission: Permission) => {
    const siem = d.identity?.siem
    if (!siem) return { error: c.json(notWired("The SIEM export"), 501) }
    if (!(await allowed(c, permission)))
      return {
        error: c.json(
          forbidden(
            permission === "owners:manage"
              ? "Only an owner can change the SIEM export."
              : "Only an admin can see the SIEM export.",
          ),
          403,
        ),
      }
    return { siem, tenantId: c.get("auth").tenantId, userId: c.get("user").userId }
  }
  const refusal = async (siem: SiemConsoleDeps, endpoint: string) => {
    const verdict = await siem.vet(
      new URL(endpoint).hostname,
      AbortSignal.timeout(5_000),
    )
    return verdict.ok ? null : verdict.reason
  }

  app.get("/identity/siem", async (c) => {
    const loaded = await load(c, "sso:manage")
    if ("error" in loaded) return loaded.error
    const row = await loaded.siem.store.get(loaded.tenantId)
    return c.json({ configured: row !== null, settings: row ? presentSiem(row) : null })
  })

  app.put("/identity/siem", requireFreshAuth, async (c) => {
    const loaded = await load(c, "owners:manage")
    if ("error" in loaded) return loaded.error
    const parsed = siemSettingsSchema.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid SIEM settings."),
        422,
      )
    const { secretAccessKey, ...rest } = parsed.data
    const before = await loaded.siem.store.get(loaded.tenantId)
    if (!before && !secretAccessKey)
      return c.json(validation("secretAccessKey is required."), 422)
    const refused = await refusal(loaded.siem, rest.endpoint)
    if (refused !== null)
      return c.json(validation(`endpoint is not allowed: ${refused}`), 422)
    const row = secretAccessKey
      ? await loaded.siem.store.put(
          loaded.tenantId,
          { ...rest, secretAccessKey },
          loaded.userId,
        )
      : await loaded.siem.store.update(loaded.tenantId, rest, loaded.userId)
    if (!row) return c.json(validation("secretAccessKey is required."), 422)
    // ⚠ NEVER THE KEY: where it goes and who changed it.
    await d.identity!.store.record(loaded.tenantId, {
      type: "siem.configured",
      actorUserId: loaded.userId,
      data: {
        endpoint: row.endpoint,
        bucket: row.bucket,
        region: row.region,
        prefix: row.prefix,
        accessKeyId: row.accessKeyId,
        enabled: row.enabled,
        secretChanged: Boolean(secretAccessKey),
        created: before === null,
      },
    })
    return c.json({ configured: true, settings: presentSiem(row) })
  })

  app.delete("/identity/siem", requireFreshAuth, async (c) => {
    const loaded = await load(c, "owners:manage")
    if ("error" in loaded) return loaded.error
    const removed = await loaded.siem.store.remove(loaded.tenantId)
    if (removed)
      await d.identity!.store.record(loaded.tenantId, {
        type: "siem.removed",
        actorUserId: loaded.userId,
        data: {},
      })
    return c.json({ configured: false })
  })

  app.post("/identity/siem/test", requireFreshAuth, async (c) => {
    const loaded = await load(c, "owners:manage")
    if ("error" in loaded) return loaded.error
    const settings = await loaded.siem.store.withSecret(loaded.tenantId)
    if (!settings) return c.json(validation("Save the SIEM settings first."), 422)
    const result = await testSiem({ fetch: loaded.siem.fetch }, settings)
    await d.identity!.store.record(loaded.tenantId, {
      type: "siem.tested",
      actorUserId: loaded.userId,
      reason: result.ok ? "ok" : "failed",
      data: result.ok ? { key: result.key } : { error: result.error },
    })
    return c.json(
      result.ok ? { ok: true, key: result.key } : { ok: false, error: result.error },
    )
  })
}
