import { describe, expect, it } from "bun:test"
import { relayConfig } from "../src/send/relay.js"

/**
 * The relay client's settings.
 *
 * ⚠ THESE LIVED IN worker.ts AND WERE UNVERIFIABLE THERE. That file has
 * top-level `await`, connects to Postgres and Redis on import and starts
 * draining queues, so nothing could import it to check a flag. Every setting
 * asserted here is one whose failure is silent rather than loud.
 */
const base = {
  host: "i10-stalwart-mail.i10-prod.svc.cluster.local",
  port: 2525,
  localName: "mail.i10.tech",
  poolSize: 8,
}

describe("relay config", () => {
  /**
   * ⚠ NO CREDENTIAL, AND A TEST SO ONE IS NOT QUIETLY ADDED BACK. The relay's
   * trust is the network boundary; an `auth` block here would mean somebody
   * reintroduced a secret the design exists to not have — and upyo refuses AUTH
   * over plaintext to a non-loopback host, so it would also fail every send.
   */
  it("presents no credential", () => {
    expect(relayConfig(base).auth).toBeUndefined()
  })

  /**
   * ⚠ BOTH FLAGS, BECAUSE upyo UPGRADES WHENEVER IT IS OFFERED. `secure: false`
   * alone still lets a STARTTLS advertisement pull the client into a handshake
   * it cannot verify — `*.i10.tech` against a `.svc.cluster.local` name. The
   * listener offers none; this says the client does not require one either.
   */
  it("speaks plaintext to the in-cluster listener", () => {
    const config = relayConfig(base)

    expect(config.secure).toBe(false)
    expect(config.requireTls).toBe(false)
    // The nodemailer spelling must not be what is set, or the flag above is
    // decorative.
    expect(config).not.toHaveProperty("requireTLS")
  })

  /**
   * ⚠ upyo DEFAULTS THE POOL TO FIVE AND THE WORKER FANS OUT TO EIGHT. Left
   * alone, three of every eight direct sends wait for a connection with nothing
   * in the logs naming the ceiling, and `WORKER_CONCURRENCY` — which env.ts
   * documents as the throughput control — is not the thing deciding throughput.
   */
  it("matches the pool to the worker's fan-out", () => {
    expect(relayConfig({ ...base, poolSize: 8 }).poolSize).toBe(8)
    expect(relayConfig({ ...base, poolSize: 24 }).poolSize).toBe(24)
    expect(relayConfig(base).pool).toBe(true)
  })

  /** upyo's default EHLO name is `localhost`, which some servers refuse. */
  it("gives a real hostname in EHLO", () => {
    expect(relayConfig(base).localName).toBe("mail.i10.tech")
    expect(relayConfig(base).localName).not.toBe("localhost")
  })

  it("dials the host and port it is given", () => {
    expect(relayConfig(base).host).toBe("i10-stalwart-mail.i10-prod.svc.cluster.local")
    expect(relayConfig(base).port).toBe(2525)
  })
})
