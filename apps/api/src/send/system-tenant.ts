import type { DomainIdentity } from "../domains/identity.js"
import { SYSTEM_SES_TENANT } from "../system-mail.js"
import { domainOf } from "./address.js"
import type { OutboundMessage, Transport } from "./transport.js"

/**
 * The SES tenant for i10's own mail (#206).
 *
 * ⚠ CUSTOMER MAIL GETS ITS TENANT FROM ITS DOMAIN ROW; OURS HAS NO ROW. The
 * send gate exempts our sender rather than looking it up (`alwaysSendable`), so
 * the claim's tenant is always null for it. This fills that one gap and nothing
 * else: a message that already names a tenant, or comes from any other domain,
 * passes through untouched.
 *
 * ⚠ IT NAMES THE TENANT ONLY AFTER ITS OWN ATTACH SUCCEEDED, the same rule the
 * column enforces for customers. SES refuses a tenant send whose identity or
 * configuration set the tenant does not hold, so naming it on hope would turn
 * an SES hiccup into refused sign-in codes. Until the attach works, our mail
 * goes untenanted - exactly as it always has.
 *
 * ⚠ AND IT LIVES IN THE WORKER, WITH A TIMER, INSTEAD OF A ROW. Every replica
 * attaches on its first own-mail send and again every few hours. `attach` is
 * idempotent and a handful of calls, so repeating it is cheap; a stored "done"
 * would be the database row this design exists to avoid.
 */
export interface SystemTenancy {
  /** The tenant to name for a message from `from`, or null. */
  tenantFor(from: string): Promise<string | null>
}

export interface SystemTenancyDeps {
  /** `AUTH_EMAIL_FROM`, which defaults to `SYSTEM_FROM`. */
  from: string
  identity: Pick<DomainIdentity, "attach" | "signature">
  log?: {
    error?: (o: object, m: string) => void
    info?: (o: object, m: string) => void
  }
  now?: () => number
}

/** How long a successful attach is trusted before it is repeated. */
const TRUST_MS = 6 * 60 * 60 * 1000
/** How long after a failure before trying again. */
const RETRY_MS = 5 * 60 * 1000

/** `a.b.example.com` → itself, `b.example.com`, `example.com`. */
function selfAndParents(domain: string): string[] {
  const labels = domain.split(".")
  const out: string[] = []
  for (let i = 0; labels.length - i >= 2; i++) out.push(labels.slice(i).join("."))
  return out
}

export function systemTenancy({
  from,
  identity,
  log,
  now = Date.now,
}: SystemTenancyDeps): SystemTenancy {
  const ours = domainOf(from)
  let state: { tenant: string | null; until: number } = { tenant: null, until: 0 }
  let inFlight: Promise<void> | null = null

  async function attach(): Promise<void> {
    if (!ours) return

    try {
      /*
       * ⚠ THE NEAREST IDENTITY, NOT THE SENDER'S EXACT DOMAIN. SES sends
       * `notifications.i10.tech` under the verified `i10.tech`, and it is that
       * identity SES checks the tenant for. `signature` reads an identity and
       * answers a null origin for one that does not exist.
       */
      let covering: string | null = null
      for (const candidate of selfAndParents(ours)) {
        if ((await identity.signature(candidate)).origin !== null) {
          covering = candidate
          break
        }
      }
      if (!covering) throw new Error(`no SES identity covers ${ours}`)

      await identity.attach(covering, SYSTEM_SES_TENANT)
      state = { tenant: SYSTEM_SES_TENANT, until: now() + TRUST_MS }
      log?.info?.(
        { identity: covering, sesTenant: SYSTEM_SES_TENANT },
        "our own mail sends through its SES tenant",
      )
    } catch (error) {
      state = { tenant: null, until: now() + RETRY_MS }
      log?.error?.(
        { err: error, from: ours, sesTenant: SYSTEM_SES_TENANT },
        "could not attach our own mail to its SES tenant - it sends untenanted until the retry",
      )
    }
  }

  return {
    async tenantFor(address) {
      if (!ours || domainOf(address) !== ours) return null
      if (now() >= state.until) {
        // ⚠ ONE ATTEMPT AT A TIME. A batch of sign-in codes arriving together
        // would otherwise fire one attach each, into SES's one request per
        // second for everything that is not a send.
        inFlight ??= attach().finally(() => {
          inFlight = null
        })
        await inFlight
      }
      return state.tenant
    },
  }
}

/** The SES transport, with our own mail's tenant filled in. */
export function withSystemTenant(
  transport: Transport,
  tenancy: SystemTenancy,
): Transport {
  return {
    async send(message: OutboundMessage) {
      if (message.sesTenant) return transport.send(message)
      const sesTenant = await tenancy.tenantFor(message.from)
      return transport.send(sesTenant ? { ...message, sesTenant } : message)
    },
  }
}
