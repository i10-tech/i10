import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { identities, samlCertificates, ssoSessions } from "../db/identity.js"
import {
  SAML_CERTIFICATE_LIMIT,
  type SamlCertificateRow,
  type SamlStore,
} from "./ports.js"

/**
 * The database half of SAML (#339). Every read and write is under the row's
 * own tenant (`withTenant`); the one cross-workspace read is the definer in
 * migration 0137, which answers ids only.
 */

const toRow = (r: typeof samlCertificates.$inferSelect): SamlCertificateRow => ({
  id: r.id,
  fingerprint: r.fingerprint,
  certificate: r.certificate,
  subject: r.subject,
  notBefore: r.notBefore,
  notAfter: r.notAfter,
  source: r.source === "metadata" ? "metadata" : "upload",
  alertedDays: r.alertedDays,
  createdAt: r.createdAt,
})

export function samlStore(db: Database): SamlStore {
  return {
    async certificates(tenantId, connectionId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(samlCertificates)
          .where(
            and(
              eq(samlCertificates.tenantId, tenantId),
              eq(samlCertificates.connectionId, connectionId),
            ),
          )
          .orderBy(samlCertificates.createdAt),
      )
      return rows.map(toRow)
    },

    async addCertificate(tenantId, connectionId, cert, by) {
      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ THE LIMIT UNDER A LOCK ON THE CONNECTION'S ROWS, THE DUPLICATE BY
         * THE UNIQUE INDEX. Two adds at once each count four and insert a
         * fifth and sixth otherwise.
         */
        const held = await tx
          .select({ id: samlCertificates.id })
          .from(samlCertificates)
          .where(
            and(
              eq(samlCertificates.tenantId, tenantId),
              eq(samlCertificates.connectionId, connectionId),
            ),
          )
          .for("update")
        if (held.length >= SAML_CERTIFICATE_LIMIT) return "limit" as const
        const made = await tx
          .insert(samlCertificates)
          .values({ tenantId, connectionId, ...cert, createdBy: by })
          .onConflictDoNothing()
          .returning({ id: samlCertificates.id })
        return made.length ? ("added" as const) : ("exists" as const)
      })
    },

    async removeCertificate(tenantId, connectionId, id) {
      const gone = await withTenant(db, tenantId, (tx) =>
        tx
          .delete(samlCertificates)
          .where(
            and(
              eq(samlCertificates.tenantId, tenantId),
              eq(samlCertificates.connectionId, connectionId),
              eq(samlCertificates.id, id),
            ),
          )
          .returning({ id: samlCertificates.id }),
      )
      return gone.length > 0
    },

    async replaceMetadataCertificates(tenantId, connectionId, certs) {
      return withTenant(db, tenantId, async (tx) => {
        const current = await tx
          .select({
            id: samlCertificates.id,
            fingerprint: samlCertificates.fingerprint,
          })
          .from(samlCertificates)
          .where(
            and(
              eq(samlCertificates.tenantId, tenantId),
              eq(samlCertificates.connectionId, connectionId),
              eq(samlCertificates.source, "metadata"),
            ),
          )
          .for("update")
        const wanted = new Set(certs.map((c) => c.fingerprint))
        const stale = current.filter((c) => !wanted.has(c.fingerprint))
        if (stale.length)
          await tx.delete(samlCertificates).where(
            and(
              eq(samlCertificates.tenantId, tenantId),
              inArray(
                samlCertificates.id,
                stale.map((c) => c.id),
              ),
            ),
          )
        const added: string[] = []
        for (const cert of certs) {
          const made = await tx
            .insert(samlCertificates)
            .values({ tenantId, connectionId, ...cert, source: "metadata" })
            .onConflictDoNothing()
            .returning({ fingerprint: samlCertificates.fingerprint })
          if (made.length) added.push(cert.fingerprint)
        }
        return { added, removed: stale.map((c) => c.fingerprint) }
      })
    },

    async noteAlert(tenantId, certificateId, days) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(samlCertificates)
          .set({ alertedDays: days })
          .where(
            and(
              eq(samlCertificates.tenantId, tenantId),
              eq(samlCertificates.id, certificateId),
            ),
          ),
      )
    },

    async boundSession(tenantId, sessionId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            clerkUserId: ssoSessions.clerkUserId,
            connectionId: ssoSessions.connectionId,
            idpSession: ssoSessions.idpSession,
            subject: identities.subject,
            revokedAt: ssoSessions.revokedAt,
          })
          .from(ssoSessions)
          .leftJoin(identities, eq(identities.id, ssoSessions.identityId))
          .where(
            and(
              eq(ssoSessions.tenantId, tenantId),
              eq(ssoSessions.sessionId, sessionId),
            ),
          )
          .limit(1),
      )
      return row ? { ...row, subject: row.subject ?? null } : null
    },

    async sessionsForLogout(tenantId, connectionId, match) {
      if (match.subject === null && match.sessionIndexes.length === 0) return []
      return withTenant(db, tenantId, (tx) =>
        tx
          .select({
            sessionId: ssoSessions.sessionId,
            clerkUserId: ssoSessions.clerkUserId,
          })
          .from(ssoSessions)
          .leftJoin(identities, eq(identities.id, ssoSessions.identityId))
          .where(
            and(
              eq(ssoSessions.tenantId, tenantId),
              eq(ssoSessions.connectionId, connectionId),
              isNull(ssoSessions.revokedAt),
              match.subject !== null
                ? eq(identities.subject, match.subject)
                : undefined,
              match.sessionIndexes.length
                ? inArray(ssoSessions.idpSession, [...match.sessionIndexes])
                : undefined,
            ),
          ),
      )
    },

    async dueConnections(after, limit) {
      const rows = (await db.execute(
        sql`select * from identity.saml_connections_due(${after}::uuid, ${limit})`,
      )) as unknown as { id: string; tenant_id: string }[]
      return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }))
    },
  }
}
