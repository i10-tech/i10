import type { Domain } from "@repo/contracts"
import { RECORD_TTL } from "../domains/zone.js"
import type { DnsConnectionStore } from "./connections.js"
import {
  DnsWriteError,
  zoneFor,
  type ConflictingRecord,
  type DesiredRecord,
  type Credential,
  type PublishOutcome,
  type ZoneWriter,
} from "./port.js"
import { writerFor } from "./writers.js"

/**
 * Publishing a domain's records into the customer's own DNS, for them.
 *
 * ⚠ THIS IS THE ANSWER TO "WHAT IS THE POINT OF STILL ADDING SIX RECORDS BY
 * HAND". Delegation already reduced six records to three delegated names; this
 * removes the hand entirely where we hold a credential. It publishes whichever
 * set the domain actually needs — the NS records for a delegated domain, the
 * six SPF/DKIM/DMARC/MX records for a manual one — because `Domain.records` is
 * already exactly that list and the API has never needed to care which it is.
 *
 * ⚠ IT REFUSES BEFORE IT DESTROYS. A domain that already has DMARC configured
 * has a TXT record at precisely the name delegation wants to take over, and
 * publishing an NS record beside it is either refused by the provider or
 * resolves unpredictably. Removing it is usually right and is never ours to
 * decide silently, so the first call reports the conflicts and changes nothing.
 * The console shows them, the customer agrees, and the second call carries
 * `replaceConflicts`.
 *
 * ⚠ AND IT WRITES NOTHING OF ITS OWN. The records come from `domainStore`,
 * which is the one place that knows what a domain needs; a second list built
 * here would drift from the table the customer is looking at, and the drift
 * would be invisible because both would look plausible.
 */

export type PublishResult =
  | { status: "published"; outcome: PublishOutcome }
  /** Nothing was written. The caller must confirm and retry. */
  | { status: "needs_confirmation"; conflicts: ConflictingRecord[] }
  | { status: "not_connected" }
  /** Connected, but the credential cannot reach the zone this domain is in. */
  | { status: "zone_not_found"; zones: string[] }
  | { status: "unsupported" }
  | { status: "failed"; kind: string; reason: string }

export interface DnsPublisher {
  publish(input: {
    tenantId: string
    provider: string
    domain: Domain
    replaceConflicts?: boolean
  }): Promise<PublishResult>
}

export interface PublisherDeps {
  connections: DnsConnectionStore
  log: { warn: (o: object, m: string) => void }
  /**
   * ⚠ INJECTED FOR THE SAME REASON `connections` IS, AND IT WAS THE ONE SEAM
   * THIS MODULE DID NOT HAVE. Every decision here — which zone, whether a
   * blocked publish is a refusal or a success, what gets written onto the
   * connection — is worth testing, and none of it could be reached while the
   * adapter arrived through a direct import. Production passes nothing and gets
   * the real registry.
   */
  writers?: (slug: string) => ZoneWriter | null
  /**
   * Renews an OAuth credential that is at or near its expiry.
   *
   * ⚠ WITHOUT IT A CONNECTION IS GOOD FOR ONE ACCESS TOKEN AND THEN DEAD. The
   * grant was stored the moment somebody authorised us and never looked at
   * again, so the first publish after the token expired failed `unauthorized`
   * — and the console correctly told the customer to reconnect, asking them to
   * redo an authorisation that had not actually lapsed.
   *
   * ⚠ IT DEFAULTS TO A NO-OP, WHICH IS THE RIGHT BEHAVIOUR FOR A PASTED API
   * TOKEN. Those do not expire and have nothing to refresh, and most providers
   * in the registry are reachable only that way.
   */
  renew?: (input: {
    tenantId: string
    provider: string
    credential: Credential
  }) => Promise<Credential>
}

export function dnsPublisher({
  connections,
  log,
  writers = writerFor,
  renew = async ({ credential }) => credential,
}: PublisherDeps): DnsPublisher {
  return {
    async publish({ tenantId, provider, domain, replaceConflicts }) {
      const writer = writers(provider)
      if (!writer) return { status: "unsupported" }

      const connection = await connections.get(tenantId, provider)
      if (!connection) return { status: "not_connected" }

      try {
        /*
         * ⚠ THE ZONES ARE RE-READ RATHER THAN TAKEN FROM THE STORED LIST. What
         * we saved at connect time is a snapshot; a customer can add or remove
         * a zone at any point afterwards, and publishing into a zone that is no
         * longer there fails in a way that reads as our bug. It also re-proves
         * the credential still works, which is the other thing worth knowing
         * before reporting success.
         */
        /*
         * ⚠ RENEWED BEFORE THE FIRST CALL, NOT AFTER THE FIRST 401. Catching the
         * failure and retrying would work, but it makes every expired
         * connection cost a wasted round trip AND has to be repeated at every
         * call site that touches a credential. Renewing once, here, is the only
         * place either of them happens.
         */
        const credential = await renew({
          tenantId,
          provider,
          credential: connection.credential,
        })

        const zones = await writer.zones(credential)
        const zone = zoneFor(zones, domain.name)

        if (!zone) {
          await connections.noteUse({ tenantId, provider, error: null })
          return { status: "zone_not_found", zones: zones.map((z) => z.name) }
        }

        const outcome = await writer.publish(credential, zone, desiredFor(domain), {
          replaceConflicts: replaceConflicts === true,
        })

        /*
         * ⚠ "NOTHING CREATED AND SOMETHING REMOVED" IS THE REFUSAL, NOT A
         * SUCCESS. The adapters signal a blocked publish by returning the
         * conflicts in `removed` with nothing created or unchanged — see the
         * note in each of them on deciding before writing. Reading that shape
         * here keeps the decision in one place rather than in three adapters.
         */
        if (
          replaceConflicts !== true &&
          outcome.removed.length > 0 &&
          outcome.created.length === 0 &&
          outcome.unchanged.length === 0
        ) {
          return { status: "needs_confirmation", conflicts: outcome.removed }
        }

        await connections.noteUse({ tenantId, provider, error: null })
        return { status: "published", outcome }
      } catch (error) {
        const failure =
          error instanceof DnsWriteError
            ? { kind: error.kind, reason: error.detail ?? error.message }
            : { kind: "unavailable", reason: String(error) }

        /*
         * ⚠ THE ERROR IS STORED ON THE CONNECTION, NOT ONLY RETURNED. A publish
         * that fails because a token was revoked fails identically the next
         * time and the time after; putting it on the row is what lets the
         * console show "this connection needs reconnecting" on the settings
         * page rather than only in the toast of whoever happened to press the
         * button.
         */
        await connections.noteUse({
          tenantId,
          provider,
          error: `${failure.kind}: ${failure.reason}`.slice(0, 500),
        })

        log.warn(
          { tenantId, provider, domain: domain.name, ...failure },
          "publishing dns records failed",
        )
        return { status: "failed", ...failure }
      }
    },
  }
}

/**
 * ⚠ TRANSLATED FROM THE RECORDS THE CUSTOMER IS ALREADY LOOKING AT. `Domain`
 * carries the display shape — a `ttl` of `"Auto"`, a `status` per row — and a
 * provider API wants numbers. Deriving both from one source is what stops the
 * table and the thing we publish from disagreeing.
 */
function desiredFor(domain: Domain): DesiredRecord[] {
  return domain.records.map((record) => ({
    name: record.name,
    type: record.type as DesiredRecord["type"],
    value: record.value,
    // ⚠ `RECORD_TTL` FOR "Auto", IMPORTED RATHER THAN REPEATED. It is the same
    // number the zones we serve ourselves use, and writing it twice is how the
    // two halves of one delegation came to be able to disagree. See the note
    // on the constant for why it is sixty seconds.
    ttl: record.ttl === "Auto" ? RECORD_TTL : Number(record.ttl) || RECORD_TTL,
    ...(record.priority === undefined ? {} : { priority: record.priority }),
  }))
}
