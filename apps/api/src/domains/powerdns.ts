import { sql, type SQL } from "drizzle-orm"
import type { Database } from "../db/client.js"
import type { DnsZones, Zone, ZoneRecord } from "./zone.js"

/**
 * PowerDNS, backed by the same Postgres everything else here uses.
 *
 * ⚠ THE ZONE IS ROWS WE WRITE, NOT AN API WE CALL, AND THAT IS THE WHOLE REASON
 * THIS IS CHEAP TO RUN ON THE BOX. There is no provisioning request to retry,
 * no key to hold and nothing to reconcile — creating a domain and publishing
 * its zone are statements in one transaction, so a domain row without a working
 * delegation is not a state that exists.
 *
 * ⚠ AND IT IS THE FIRST ADAPTER, NOT THE COMMITMENT. Cloudflare or Route 53
 * later implements the same port against an HTTP API; the zone contents come
 * from `delegatedZones` and do not change. What changes is that the answer
 * stops depending on one machine being up — see the note on redundancy in
 * docs/decisions/mail-routing.md.
 */

/**
 * ⚠ `NATIVE`, NOT `MASTER`. `MASTER` makes PowerDNS send NOTIFYs and expect
 * secondaries to transfer from it; with one server and no AXFR there is nobody
 * to notify, and the failed attempts are noise in the log that looks like a
 * problem. `NATIVE` means "the database is the replication" — which it is,
 * because CNPG replicates it.
 */
const ZONE_TYPE = "NATIVE"

/**
 * ⚠ NAMES ARE LOWERCASED BECAUSE THE SCHEMA REFUSES ANYTHING ELSE. PowerDNS's
 * tables carry `CHECK (name = LOWER(name))`, so a mixed-case domain — which a
 * customer will paste — is a constraint violation at insert time rather than a
 * zone that quietly does not match queries.
 */
const lower = (value: string) => value.toLowerCase()

export const upsertZoneStatement = (zone: string): SQL => sql`
  insert into pdns.domains (name, type)
  values (${lower(zone)}, ${ZONE_TYPE})
  on conflict (name) do update set type = excluded.type
  returning id
`

export const clearRecordsStatement = (zone: string): SQL => sql`
  delete from pdns.records
   where domain_id = (select id from pdns.domains where name = ${lower(zone)})
`

export const insertRecordsStatement = (
  domainId: number,
  records: readonly ZoneRecord[],
): SQL => sql`
  insert into pdns.records (domain_id, name, type, content, ttl, prio)
  values ${sql.join(
    records.map(
      (record) => sql`(
      ${domainId}, ${lower(record.name)}, ${record.type},
      ${record.content}, ${record.ttl}, ${record.priority ?? null}
    )`,
    ),
    sql`, `,
  )}
`

export const dropZoneStatement = (zone: string): SQL => sql`
  delete from pdns.domains where name = ${lower(zone)}
`

export function powerDnsZones(db: Database): DnsZones {
  return {
    async put(zone: Zone) {
      // ⚠ ONE TRANSACTION, AND THE DELETE IS INSIDE IT. Replacing a zone by
      // clearing and re-inserting is the only way to make removal work at all —
      // a diff would have to decide what "the same record" means when the value
      // is what changed. Outside a transaction, the window between the two is a
      // zone that answers NXDOMAIN for every name it holds.
      await db.transaction(async (tx) => {
        const rows = (await tx.execute(upsertZoneStatement(zone.name))) as unknown as {
          id: number
        }[]
        const domainId = Number(rows[0]?.id)
        if (!Number.isInteger(domainId)) {
          throw new Error(`could not create zone ${zone.name}`)
        }

        await tx.execute(clearRecordsStatement(zone.name))
        if (zone.records.length > 0) {
          await tx.execute(insertRecordsStatement(domainId, zone.records))
        }
      })
    },

    async remove(zoneName) {
      // Records cascade from the zone's foreign key.
      await db.execute(dropZoneStatement(zoneName))
    },
  }
}
