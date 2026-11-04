import type { Connection } from "./model.js"
import type {
  IdentityStore,
  Logger,
  ReplayCache,
  SamlCertificateRow,
  SamlStore,
} from "./ports.js"
import type { ConnectionHealthStore } from "./health.js"
import { IdpUnreachable } from "./oidc-fetch.js"
import type { IdpMetadata } from "./saml-messages.js"
import {
  ReplayUnavailable,
  SamlMisconfigured,
  storedSaml,
  type ForcedRefresh,
  type StoredSaml,
} from "./saml.js"
import type { StoredOidc } from "./oidc.js"
import type {
  DirectoryProvider,
  DirectorySyncStatus,
  DirectoryToken,
} from "./directory-ports.js"

/**
 * The daily SAML pass (#339, sso.md 2.10): every SAML connection that is not
 * a draft has its metadata URL read again, and its IdP certificates checked
 * against 30, 7 and 1 days (and 0: expired) before they expire.
 *
 * ⚠ IT RIDES THE NIGHTLY RE-CHECK JOB (src/recheck.ts), which already runs
 * once a day across every workspace; a second CronJob would be a second
 * schedule to keep in step with Sentry for the same cadence.
 *
 * ⚠ METADATA MAY ROTATE CERTIFICATES AND MOVE ENDPOINTS, NEVER RE-POINT THE
 * TRUST. An owner set the URL, so what it lists is what the owner chose to
 * believe: new signing certificates are added, retired ones removed, the SSO
 * and SLO URLs followed. A changed entity id is a different IdP, and is
 * refused and audited until an owner sets it.
 *
 * ⚠ AN UNREACHABLE URL CHANGES NOTHING but `metadataError` and an audit
 * event: the certificates we hold keep verifying until they expire, which the
 * alerts below announce.
 */

export interface RefreshDeps {
  store: Pick<IdentityStore, "connection" | "updateConnection" | "record">
  saml: SamlStore
  log: Logger
  now?: () => Date
}

/** Thresholds, in days, largest first. 0 means "has expired". */
export const EXPIRY_ALERT_DAYS = [30, 7, 1, 0] as const
/** A metadata URL fetched less than this long ago is not fetched again. */
const REFRESH_EVERY_MS = 20 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export type RefreshOutcome =
  | { outcome: "updated"; added: string[]; removed: string[] }
  | { outcome: "entity_changed" }

/** Applies fetched metadata to one connection. The console's refresh uses it too. */
export async function refreshConnection(
  d: RefreshDeps,
  connection: Connection,
  metadata: IdpMetadata,
  actorUserId: string | null,
): Promise<RefreshOutcome> {
  const now = (d.now ?? (() => new Date()))()
  const stored = storedSaml(connection)
  if (stored.idpEntityId && stored.idpEntityId !== metadata.entityId) {
    await d.store.updateConnection(connection.tenantId, connection.id, {
      config: {
        ...connection.config,
        saml: { ...stored, metadataError: "entity_id_changed" },
      },
    })
    await d.store.record(connection.tenantId, {
      type: "connection.metadata_refused",
      actorUserId,
      connectionId: connection.id,
      reason: "entity_id_changed",
      data: { from: stored.idpEntityId, to: metadata.entityId },
    })
    d.log.warn(
      { connectionId: connection.id },
      "SAML metadata names another entity id; not applied",
    )
    return { outcome: "entity_changed" }
  }
  const certificates = await d.saml.replaceMetadataCertificates(
    connection.tenantId,
    connection.id,
    metadata.certificates,
  )
  const next: StoredSaml = {
    ...stored,
    idpEntityId: metadata.entityId,
    ssoUrl: metadata.ssoUrl,
    sloUrl: metadata.sloUrl,
    sloResponseUrl: metadata.sloResponseUrl,
    metadataFetchedAt: now.toISOString(),
    metadataError: null,
    ...(metadata.wantAuthnRequestsSigned ? { signRequests: true } : {}),
  }
  await d.store.updateConnection(connection.tenantId, connection.id, {
    config: { ...connection.config, saml: next },
  })
  const moved = (["ssoUrl", "sloUrl", "sloResponseUrl"] as const).filter(
    (k) => (stored[k] ?? null) !== (next[k] ?? null),
  )
  if (certificates.added.length || certificates.removed.length || moved.length)
    await d.store.record(connection.tenantId, {
      type: "connection.metadata_refreshed",
      actorUserId,
      connectionId: connection.id,
      data: { ...certificates, moved },
    })
  return { outcome: "updated", ...certificates }
}

/** A connection's metadata is forced fresh by a failed signature at most this often. */
export const FORCE_REFRESH_EVERY_MS = 10 * 60 * 1000

export interface ForceRefreshDeps extends RefreshDeps {
  fetchMetadata(url: string): Promise<IdpMetadata>
  /** Redis: the 10-minute limit is one `claim`, shared by every API replica. */
  replay: ReplayCache
}

/**
 * The certificate-rotation path (the daily pass is up to a day late): a
 * sign-in whose signature failed asks for the connection's metadata now.
 * Returns the certificates to check the SAME response against again, or null
 * when there is nothing new to try.
 *
 * ⚠ ONE READ PER 10 MINUTES PER CONNECTION, ATOMIC IN REDIS. A forged
 * response from anyone can cause this, so it must not become a way to make us
 * fetch an owner's URL on every POST. The claim is taken before the fetch and
 * kept when the fetch fails: a failing IdP is not asked again for 10 minutes.
 * The price is that someone can burn the window just before a real rotation;
 * the daily pass and the next window still recover it.
 *
 * ⚠ ONLY NEW CERTIFICATES EARN A RETRY. A read that adds none (or names
 * another entity id) changes nothing for this response, so there is no second
 * read and no loop. An unreachable metadata URL or Redis refuses, as before.
 */
export async function forceRefresh(
  d: ForceRefreshDeps,
  connection: Connection,
  before: SamlCertificateRow[],
): Promise<ForcedRefresh | null> {
  const url = storedSaml(connection).metadataUrl
  if (!url) return null
  let metadata: IdpMetadata
  try {
    if (
      !(await d.replay.claim(
        `sso:saml:force-refresh:${connection.id}`,
        FORCE_REFRESH_EVERY_MS,
      ))
    )
      return null
    metadata = await d.fetchMetadata(url)
  } catch (error) {
    if (!(
      error instanceof IdpUnreachable ||
      error instanceof SamlMisconfigured ||
      error instanceof ReplayUnavailable
    ))
      throw error
    d.log.warn(
      { connectionId: connection.id },
      "SAML metadata could not be re-read after a failed signature",
    )
    return null
  }
  const applied = await refreshConnection(d, connection, metadata, null)
  if (applied.outcome !== "updated") return null
  const certificates = await d.saml.certificates(connection.tenantId, connection.id)
  const audit = (retried: boolean, succeeded: boolean) =>
    d.store.record(connection.tenantId, {
      type: "saml.certificate_refreshed",
      connectionId: connection.id,
      data: {
        retried,
        retrySucceeded: succeeded,
        certificatesBefore: before.length,
        certificatesAfter: certificates.length,
        added: applied.added.length,
        removed: applied.removed.length,
      },
    })
  if (applied.added.length === 0) {
    await audit(false, false)
    return null
  }
  return { certificates, settle: (ok) => audit(true, ok) }
}

/**
 * The expiry threshold a certificate has newly crossed, or null.
 *
 * ⚠ ONCE PER THRESHOLD. `alertedDays` keeps the smallest one announced, so a
 * certificate 6 days out is announced at 7 and next at 1, not every night.
 */
export function crossedThreshold(
  cert: Pick<SamlCertificateRow, "notAfter" | "alertedDays">,
  now: Date,
): number | null {
  const left = (cert.notAfter.getTime() - now.getTime()) / DAY_MS
  let crossed: number | null = null
  for (const days of EXPIRY_ALERT_DAYS) if (left <= days) crossed = days
  if (crossed === null) return null
  return cert.alertedDays === null || crossed < cert.alertedDays ? crossed : null
}

export interface DailyDeps extends RefreshDeps {
  fetchMetadata(url: string): Promise<IdpMetadata>
}

export interface DailySummary {
  connections: number
  refreshed: number
  failed: number
  alerts: number
}

export async function dailySamlPass(d: DailyDeps): Promise<DailySummary> {
  const now = (d.now ?? (() => new Date()))()
  const summary: DailySummary = { connections: 0, refreshed: 0, failed: 0, alerts: 0 }
  let after: string | null = null
  for (;;) {
    const page = await d.saml.dueConnections(after, 200)
    if (page.length === 0) break
    after = page[page.length - 1]!.id
    for (const due of page) {
      const connection = await d.store.connection(due.tenantId, due.id)
      if (!connection || connection.protocol !== "saml") continue
      summary.connections++
      const stored = storedSaml(connection)
      const fetchedAt = stored.metadataFetchedAt
        ? Date.parse(stored.metadataFetchedAt)
        : 0
      if (stored.metadataUrl && now.getTime() - fetchedAt >= REFRESH_EVERY_MS) {
        try {
          const metadata = await d.fetchMetadata(stored.metadataUrl)
          if (
            (await refreshConnection(d, connection, metadata, null)).outcome ===
            "updated"
          )
            summary.refreshed++
        } catch (error) {
          if (!(error instanceof IdpUnreachable || error instanceof SamlMisconfigured))
            throw error
          summary.failed++
          const code = error instanceof IdpUnreachable ? error.kind : "unusable"
          await d.store.updateConnection(connection.tenantId, connection.id, {
            config: { ...connection.config, saml: { ...stored, metadataError: code } },
          })
          await d.store.record(connection.tenantId, {
            type: "connection.metadata_failed",
            connectionId: connection.id,
            reason: code,
          })
          d.log.warn(
            { connectionId: connection.id, code },
            "SAML metadata refresh failed",
          )
        }
      }
      for (const cert of await d.saml.certificates(
        connection.tenantId,
        connection.id,
      )) {
        const days = crossedThreshold(cert, now)
        if (days === null) continue
        summary.alerts++
        await d.store.record(connection.tenantId, {
          type: "sso.certificate.expiring",
          connectionId: connection.id,
          reason: days === 0 ? "expired" : `${days}_days`,
          data: {
            fingerprint: cert.fingerprint,
            notAfter: cert.notAfter.toISOString(),
            days,
          },
        })
        d.log.warn(
          {
            tenantId: connection.tenantId,
            connectionId: connection.id,
            fingerprint: cert.fingerprint,
            days,
          },
          days === 0
            ? "a SAML IdP certificate has expired"
            : "a SAML IdP certificate expires soon",
        )
        await d.saml.noteAlert(connection.tenantId, cert.id, days)
      }
    }
  }
  return summary
}

export async function checkOidcSecret(
  d: {
    store: Pick<IdentityStore, "updateConnection" | "record">
    log: Logger
  },
  connection: Connection,
  now: Date,
): Promise<boolean> {
  if (connection.protocol !== "oidc") return false
  const oidc = connection.config.oidc as StoredOidc | undefined
  if (!oidc?.secretExpiresAt) return false
  const notAfter = new Date(oidc.secretExpiresAt)
  if (Number.isNaN(notAfter.getTime())) return false

  const days = crossedThreshold(
    { notAfter, alertedDays: oidc.secretAlertedDays ?? null },
    now,
  )
  if (days === null) return false

  await d.store.record(connection.tenantId, {
    type: "sso.certificate.expiring",
    connectionId: connection.id,
    reason: days === 0 ? "expired" : `${days}_days`,
    data: {
      kind: "client_secret",
      notAfter: oidc.secretExpiresAt,
      days,
    },
  })
  d.log.warn(
    {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      days,
    },
    days === 0
      ? "an OIDC client secret has expired"
      : "an OIDC client secret expires soon",
  )
  await d.store.updateConnection(connection.tenantId, connection.id, {
    config: {
      ...connection.config,
      oidc: {
        ...oidc,
        secretAlertedDays: days,
      },
    },
  })
  return true
}

export async function checkDirectoryTokens(
  d: {
    store: Pick<IdentityStore, "record">
    health?: ConnectionHealthStore
    log: Logger
  },
  directory: { id: string; tenantId: string },
  tokens: DirectoryToken[],
  now: Date,
): Promise<number> {
  let alerted = 0
  for (const token of tokens) {
    if (!token.expiresAt || token.revokedAt) continue
    const notAfter = token.expiresAt
    if (Number.isNaN(notAfter.getTime())) continue
    const left = (notAfter.getTime() - now.getTime()) / DAY_MS
    let crossed: number | null = null
    for (const days of EXPIRY_ALERT_DAYS) if (left <= days) crossed = days
    if (crossed === null) continue

    if (d.health) {
      const claimed = await d.health.claimAlert(
        directory.tenantId,
        { directoryId: directory.id },
        { kind: "scim_token", tokenId: token.id, days: crossed },
        // ⚠ ONCE PER TOKEN AND THRESHOLD: the 30-day one stays crossed for 23 nights.
        400 * DAY_MS,
        `sso-scim-token:${token.id}:${crossed}`,
      )
      if (!claimed) continue
    }

    alerted++
    await d.store.record(directory.tenantId, {
      type: "sso.certificate.expiring",
      reason: crossed === 0 ? "expired" : `${crossed}_days`,
      data: {
        kind: "scim_token",
        directoryId: directory.id,
        tokenId: token.id,
        hint: token.hint,
        notAfter: notAfter.toISOString(),
        days: crossed,
      },
    })
    d.log.warn(
      {
        tenantId: directory.tenantId,
        directoryId: directory.id,
        tokenId: token.id,
        days: crossed,
      },
      crossed === 0
        ? "a SCIM directory token has expired"
        : "a SCIM directory token expires soon",
    )
  }
  return alerted
}

export async function checkDirectoryStaleSync(
  d: {
    store: Pick<IdentityStore, "record">
    log: Logger
  },
  directory: {
    id: string
    tenantId: string
    provider: DirectoryProvider
    enabled: boolean
    createdAt: Date
    lastSyncAt: Date | null
    lastSyncStatus: DirectorySyncStatus | null
  },
  now: Date,
): Promise<boolean> {
  // ⚠ ONLY A DIRECTORY WE PULL: SCIM is pushed to us and never "syncs" on our side.
  if (!directory.enabled || directory.provider !== "google") return false
  const lastSuccessTime =
    directory.lastSyncStatus === "ok" && directory.lastSyncAt
      ? directory.lastSyncAt.getTime()
      : null

  const referenceTime = lastSuccessTime ?? directory.createdAt.getTime()
  const isStale = now.getTime() - referenceTime >= 24 * 60 * 60 * 1000

  if (!isStale) return false

  await d.store.record(directory.tenantId, {
    type: "directory.sync_failed",
    reason: "stale_sync",
    data: {
      directoryId: directory.id,
      error: "stale_sync",
    },
  })
  d.log.warn(
    {
      tenantId: directory.tenantId,
      directoryId: directory.id,
    },
    "directory has had no successful sync for 24 hours",
  )
  return true
}
