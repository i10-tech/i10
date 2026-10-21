import type { Context, Hono } from "hono"
import { z } from "zod"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { readIdpUrl } from "./identity-oidc.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import { OWNER_GUARDED, type Connection } from "../../identity/model.js"
import type { Logger, SamlStore } from "../../identity/ports.js"
import {
  readCertificate,
  newSpKey,
  type IdpCertificate,
} from "../../identity/saml-crypto.js"
import { parseIdpMetadata, type IdpMetadata } from "../../identity/saml-messages.js"
import { samlPresetOf } from "../../identity/saml-presets.js"
import { LINKABLE_NAMEID } from "../../identity/saml-verify.js"
import { refreshConnection } from "../../identity/saml-refresh.js"
import {
  SamlMisconfigured,
  samlReady,
  sealedSaml,
  storedSaml,
  type SamlEngine,
  type StoredSaml,
} from "../../identity/saml.js"

/**
 * A connection's SAML settings (#339), for the setup screen (#340). Mirrors
 * identity-oidc.ts.
 *
 *   GET    /identity/connections/:id/saml                    what to give the IdP, and what is set
 *   PUT    /identity/connections/:id/saml                    entity id, SSO/SLO URLs, metadata URL
 *                                                           or XML, NameID format, toggles (step-up)
 *   POST   /identity/connections/:id/saml/certificates       add an IdP certificate (step-up)
 *   DELETE /identity/connections/:id/saml/certificates/:cid  remove one (step-up)
 *   POST   /identity/connections/:id/saml/sp-key             make or rotate our SP key (step-up)
 *   POST   /identity/connections/:id/saml/refresh            fetch the metadata URL now
 *
 * ⚠ THE TRUST RULE (sso.md 2.14, carried to SAML in 2.16). The IdP entity
 * id, its SSO and SLO URLs, the metadata URL or file, its certificates, the
 * subject attribute, the NameID format, the MFA context classes, requiring
 * encryption and IdP-initiated sign-in all decide who the connection
 * believes, or how loosely. On an `active` or `disabled` connection changing
 * any of them needs `owners:manage` as well as step-up, and is audited with
 * the actor. Signing our own requests is not trust: it changes what the IdP
 * believes of us, not what we believe of it.
 *
 * ⚠ OUR PRIVATE KEY IS WRITE-ONLY, as the OIDC client secret is. It is drawn
 * here, sealed into `secrets.saml`, and never read back by any route; the
 * config keeps the public certificates the IdP needs.
 */

export interface SamlConsoleDeps {
  engine: SamlEngine
  store: SamlStore
  log: Logger
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = z.string().regex(/^[\x21-\x7E]{1,256}$/)

const SamlInput = z
  .object({
    idpEntityId: z.string().trim().min(1).max(1024).optional(),
    ssoUrl: z.string().max(512).optional(),
    sloUrl: z.string().max(512).nullable().optional(),
    metadataUrl: z.string().max(512).nullable().optional(),
    metadataXml: z
      .string()
      .min(1)
      .max(256 * 1024)
      .optional(),
    nameIdFormat: z.enum(LINKABLE_NAMEID as [string, ...string[]]).optional(),
    signRequests: z.boolean().optional(),
    requireEncryption: z.boolean().optional(),
    idpInitiated: z.boolean().optional(),
    subjectAttribute: z.string().min(1).max(256).nullable().optional(),
    mfaContextClasses: z.array(TOKEN).max(10).optional(),
  })
  .strict()

const TRUST_FIELDS = [
  "idpEntityId",
  "ssoUrl",
  "sloUrl",
  "metadataUrl",
  "nameIdFormat",
  "requireEncryption",
  "idpInitiated",
  "subjectAttribute",
  "mfaContextClasses",
] as const

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const certView = (c: {
  id: string
  fingerprint: string
  subject: string
  notBefore: Date
  notAfter: Date
  source: string
}) => ({
  id: c.id,
  fingerprint: c.fingerprint,
  subject: c.subject,
  notBefore: c.notBefore,
  notAfter: c.notAfter,
  source: c.source,
})

export function mountIdentitySaml(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }

  const load = async (c: Context) => {
    const id = d.identity
    if (!id?.saml) return { error: c.json(notWired("SAML connections"), 501) }
    if (!(await allowed(c, "sso:manage")))
      return { error: c.json(forbidden("Only an admin can change SSO settings."), 403) }
    const connectionId = c.req.param("id") ?? ""
    if (!UUID.test(connectionId)) return { error: c.json(notFound(), 404) }
    const { tenantId } = c.get("auth")
    const connection = await id.store.connection(tenantId, connectionId)
    if (!connection || connection.protocol !== "saml")
      return { error: c.json(notFound(), 404) }
    return { id, saml: id.saml, connection, tenantId }
  }

  /** ⚠ THE TRUST RULE, in one place for every write. See the file header. */
  const trustRefusal = async (c: Context, connection: Connection) => {
    if (!OWNER_GUARDED.includes(connection.status)) return null
    if (await allowed(c, "owners:manage")) return null
    return c.json(
      forbidden(
        "Only an owner can change who an active connection trusts. Ask an owner, or disable the connection first and have an owner make the change.",
      ),
      403,
    )
  }

  const view = async (connection: Connection, s: SamlConsoleDeps) => {
    const preset = samlPresetOf(connection.provider)
    const stored = storedSaml(connection)
    const certs = await s.store.certificates(connection.tenantId, connection.id)
    const at = s.engine.endpoints(connection.id)
    return {
      provider: connection.provider,
      label: preset?.label ?? connection.provider,
      entityId: at.entityId,
      acsUrl: at.acsUrl,
      sloUrl: at.sloUrl,
      metadataUrl: at.entityId,
      entityIdHint: preset?.entityIdHint ?? null,
      requires: preset?.requires ?? [],
      idpEntityId: stored.idpEntityId ?? null,
      ssoUrl: stored.ssoUrl ?? null,
      idpSloUrl: stored.sloUrl ?? null,
      idpMetadataUrl: stored.metadataUrl ?? null,
      metadataFetchedAt: stored.metadataFetchedAt ?? null,
      metadataError: stored.metadataError ?? null,
      nameIdFormat: stored.nameIdFormat ?? preset?.nameIdFormat ?? null,
      signRequests: stored.signRequests === true,
      requireEncryption: stored.requireEncryption === true,
      idpInitiated: stored.idpInitiated === true,
      subjectAttribute: stored.subjectAttribute ?? null,
      mfaContextClasses: stored.mfaContextClasses ?? [],
      spCertificates: (stored.spCertificates ?? []).map((k) => ({
        fingerprint: k.fingerprint,
        certificate: k.certificate,
        notAfter: k.notAfter,
        createdAt: k.createdAt,
      })),
      certificates: certs.map(certView),
      ready: samlReady(connection, certs),
    }
  }

  /** Draws our SP key the first time a connection is set up, under the secrets lock. */
  const ensureSpKey = async (
    c: Context,
    connection: Connection,
    loaded: { id: NonNullable<ConsoleDeps["identity"]>; tenantId: string },
  ) => {
    if ((storedSaml(connection).spCertificates?.length ?? 0) > 0) return connection
    const made = await newSpKey(`i10 SAML ${connection.id}`)
    const after = await loaded.id.store.setConnectionSecrets(
      loaded.tenantId,
      connection.id,
      (now) => {
        const current = storedSaml({ config: now.config })
        if ((current.spCertificates?.length ?? 0) > 0) return now
        return {
          secrets: {
            ...now.secrets,
            saml: { ...sealedSaml(now.secrets), spKeys: [made.privateKey] },
          },
          config: {
            ...now.config,
            saml: { ...current, spCertificates: [made.publicCert] },
          },
        }
      },
    )
    if (after)
      await loaded.id.store.record(loaded.tenantId, {
        type: "connection.key_rotated",
        actorUserId: c.get("user").userId,
        connectionId: connection.id,
        data: {
          kind: "saml_sp",
          fingerprint: made.publicCert.fingerprint,
          previous: null,
        },
      })
    return after ?? connection
  }

  /**
   * Metadata from the request (a URL to fetch or a file), or a response that
   * says why not.
   *
   * ⚠ THE GUARD'S REASON IS NEVER REPEATED (sso.md 2.14): it can name what a
   * host resolved to inside our network.
   */
  const readMetadata = async (
    c: Context,
    s: SamlConsoleDeps,
    input: { url?: string | null; xml?: string },
    connectionId: string,
  ): Promise<{ metadata: IdpMetadata } | { error: Response }> => {
    if (input.xml !== undefined) {
      const parsed = parseIdpMetadata(input.xml)
      return "error" in parsed
        ? { error: c.json(validation(parsed.error), 422) }
        : { metadata: parsed }
    }
    try {
      return { metadata: await s.engine.fetchMetadata(input.url!) }
    } catch (error) {
      if (error instanceof SamlMisconfigured)
        return {
          error: c.json(
            validation(`We could not use that metadata: ${error.message}`),
            422,
          ),
        }
      s.log.warn(
        { connectionId, err: error instanceof Error ? error.message : "unknown" },
        "SAML metadata could not be fetched through the egress guard",
      )
      return {
        error: c.json(
          validation(
            "We could not reach that metadata URL from the internet. Check the URL and that it is public.",
          ),
          422,
        ),
      }
    }
  }

  app.get("/identity/connections/:id/saml", async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    return c.json(await view(loaded.connection, loaded.saml))
  })

  app.put("/identity/connections/:id/saml", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, saml, tenantId } = loaded
    let connection = loaded.connection
    const parsed = SamlInput.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(validation("Those SAML settings are not valid."), 422)
    const body = parsed.data
    const current = storedSaml(connection)
    const next: StoredSaml = { ...current }

    if (body.metadataUrl !== undefined) {
      if (body.metadataUrl === null || body.metadataUrl === "") next.metadataUrl = null
      else {
        const url = readIdpUrl(body.metadataUrl, "metadataUrl", { query: true })
        if (typeof url !== "string") return c.json(validation(url.error), 422)
        next.metadataUrl = url
      }
    }
    for (const key of ["ssoUrl", "sloUrl"] as const) {
      const value = body[key]
      if (value === undefined) continue
      if (value === null || value === "") {
        if (key === "ssoUrl")
          return c.json(validation("ssoUrl must be an https URL."), 422)
        next.sloUrl = null
        continue
      }
      const url = readIdpUrl(value, key, { query: true })
      if (typeof url !== "string") return c.json(validation(url.error), 422)
      next[key] = url
    }
    if (body.idpEntityId !== undefined) next.idpEntityId = body.idpEntityId
    if (body.nameIdFormat !== undefined) next.nameIdFormat = body.nameIdFormat
    for (const key of ["signRequests", "requireEncryption", "idpInitiated"] as const)
      if (body[key] !== undefined) next[key] = body[key]
    if (body.subjectAttribute !== undefined)
      next.subjectAttribute = body.subjectAttribute
    if (body.mfaContextClasses !== undefined)
      next.mfaContextClasses = [...new Set(body.mfaContextClasses)]

    // ⚠ METADATA FILLS IN THE IdP's SETTINGS AND ITS CERTIFICATES, as one change.
    let metadata: IdpMetadata | null = null
    const fromUrl = body.metadataUrl !== undefined && next.metadataUrl
    if (body.metadataXml !== undefined || fromUrl) {
      const read = await readMetadata(
        c,
        saml,
        body.metadataXml !== undefined
          ? { xml: body.metadataXml }
          : { url: next.metadataUrl },
        connection.id,
      )
      if ("error" in read) return read.error
      metadata = read.metadata
      next.idpEntityId = metadata.entityId
      next.ssoUrl = metadata.ssoUrl
      next.sloUrl = metadata.sloUrl
      next.sloResponseUrl = metadata.sloResponseUrl
      if (metadata.wantAuthnRequestsSigned) next.signRequests = true
      if (fromUrl) {
        next.metadataFetchedAt = new Date().toISOString()
        next.metadataError = null
      }
    }

    const changed = ([...TRUST_FIELDS, "signRequests"] as const).filter(
      (k) => JSON.stringify(next[k] ?? null) !== JSON.stringify(current[k] ?? null),
    )
    const trust = changed.filter((k) => (TRUST_FIELDS as readonly string[]).includes(k))
    if (trust.length || metadata) {
      const refusal = await trustRefusal(c, connection)
      if (refusal) return refusal
    }
    const { userId } = c.get("user")
    connection = await ensureSpKey(c, connection, { id, tenantId })
    const after = await id.store.setConnectionSecrets(
      tenantId,
      connection.id,
      (now) => ({
        secrets: now.secrets,
        config: {
          ...now.config,
          saml: {
            ...next,
            spCertificates: storedSaml({ config: now.config }).spCertificates ?? [],
          },
        },
      }),
    )
    if (!after) return c.json(notFound(), 404)
    let certificates: { added: string[]; removed: string[] } | null = null
    if (metadata)
      certificates = await saml.store.replaceMetadataCertificates(
        tenantId,
        connection.id,
        metadata.certificates,
      )
    if (changed.length || certificates)
      await id.store.record(tenantId, {
        type: "connection.saml_updated",
        actorUserId: userId,
        connectionId: connection.id,
        data: {
          changed,
          trust: trust.length > 0 || metadata !== null,
          status: connection.status,
          from: pick(current, changed),
          to: pick(next, changed),
          ...(certificates ? { certificates } : {}),
        },
      })
    return c.json(await view(after, saml))
  })

  app.post(
    "/identity/connections/:id/saml/certificates",
    requireFreshAuth,
    async (c) => {
      const loaded = await load(c)
      if ("error" in loaded) return loaded.error
      const { id, saml, connection, tenantId } = loaded
      const refusal = await trustRefusal(c, connection)
      if (refusal) return refusal
      const parsed = z
        .object({
          certificate: z
            .string()
            .min(1)
            .max(16 * 1024),
        })
        .strict()
        .safeParse((await readJson(c)) ?? {})
      if (!parsed.success)
        return c.json(
          validation("certificate must be one PEM or base64 X.509 certificate."),
          422,
        )
      const cert = readCertificate(parsed.data.certificate)
      if ("error" in cert) return c.json(validation(cert.error), 422)
      if (cert.notAfter.getTime() <= Date.now())
        return c.json(validation("That certificate has expired."), 422)
      const { userId } = c.get("user")
      const added = await saml.store.addCertificate(
        tenantId,
        connection.id,
        { ...(cert as IdpCertificate), source: "upload" },
        userId,
      )
      if (added === "limit")
        return c.json(
          validation("A connection holds at most five certificates. Remove one first."),
          422,
        )
      if (added === "added")
        await id.store.record(tenantId, {
          type: "connection.certificate_added",
          actorUserId: userId,
          connectionId: connection.id,
          data: {
            fingerprint: cert.fingerprint,
            notAfter: cert.notAfter,
            status: connection.status,
          },
        })
      return c.json(await view(connection, saml), added === "added" ? 201 : 200)
    },
  )

  app.delete(
    "/identity/connections/:id/saml/certificates/:certificateId",
    requireFreshAuth,
    async (c) => {
      const loaded = await load(c)
      if ("error" in loaded) return loaded.error
      const { id, saml, connection, tenantId } = loaded
      const certificateId = c.req.param("certificateId")
      if (!UUID.test(certificateId)) return c.json(notFound(), 404)
      const refusal = await trustRefusal(c, connection)
      if (refusal) return refusal
      if (!(await saml.store.removeCertificate(tenantId, connection.id, certificateId)))
        return c.json(notFound(), 404)
      await id.store.record(tenantId, {
        type: "connection.certificate_removed",
        actorUserId: c.get("user").userId,
        connectionId: connection.id,
        data: { certificateId, status: connection.status },
      })
      return c.json(await view(connection, saml))
    },
  )

  app.post("/identity/connections/:id/saml/sp-key", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, saml, connection, tenantId } = loaded
    const refusal = await trustRefusal(c, connection)
    if (refusal) return refusal
    const made = await newSpKey(`i10 SAML ${connection.id}`)
    const previous = storedSaml(connection).spCertificates?.[0]?.fingerprint ?? null
    /*
     * ⚠ THE PREVIOUS KEY STAYS, AND ONLY THE PREVIOUS ONE: an IdP still
     * encrypting to it, or still holding the old certificate for our
     * signatures, keeps working until it is updated. We sign with the new key
     * at once; a second rotation retires the oldest.
     */
    const after = await id.store.setConnectionSecrets(
      tenantId,
      connection.id,
      (now) => {
        const sealed = sealedSaml(now.secrets)
        const current = storedSaml({ config: now.config })
        return {
          secrets: {
            ...now.secrets,
            saml: {
              ...sealed,
              spKeys: [made.privateKey, ...(sealed.spKeys ?? [])].slice(0, 2),
            },
          },
          config: {
            ...now.config,
            saml: {
              ...current,
              spCertificates: [
                made.publicCert,
                ...(current.spCertificates ?? []),
              ].slice(0, 2),
            },
          },
        }
      },
    )
    if (!after) return c.json(notFound(), 404)
    await id.store.record(tenantId, {
      type: "connection.key_rotated",
      actorUserId: c.get("user").userId,
      connectionId: connection.id,
      data: {
        kind: "saml_sp",
        fingerprint: made.publicCert.fingerprint,
        previous,
        status: connection.status,
      },
    })
    return c.json(await view(after, saml), 201)
  })

  /*
   * ⚠ AN ADMIN MAY REFRESH, NOT RE-POINT: the URL is the owner-guarded part,
   * and this only reads it again, as the daily job does.
   */
  app.post("/identity/connections/:id/saml/refresh", async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, saml, connection, tenantId } = loaded
    const url = storedSaml(connection).metadataUrl
    if (!url) return c.json(validation("This connection has no metadata URL."), 422)
    const read = await readMetadata(c, saml, { url }, connection.id)
    if ("error" in read) return read.error
    const done = await refreshConnection(
      { store: id.store, saml: saml.store, log: saml.log },
      connection,
      read.metadata,
      c.get("user").userId,
    )
    const after = (await id.store.connection(tenantId, connection.id)) ?? connection
    return c.json({ ...(await view(after, saml)), refresh: done })
  })
}

function pick(o: StoredSaml, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.map((k) => [k, (o as Record<string, unknown>)[k] ?? null]),
  )
}
