import type { SmtpConfig } from "@upyo/smtp"

/**
 * The relay client's configuration, built where it can be asserted.
 *
 * ⚠ THIS IS A SEPARATE FUNCTION BECAUSE worker.ts CANNOT BE IMPORTED BY A TEST.
 * That file has top-level `await`, connects to Postgres and Redis on import and
 * starts draining queues — so every setting inside it was, until now, unverified
 * by construction. The settings here are the ones whose failure is silent, which
 * is exactly the set that should not live somewhere untestable.
 *
 * ⚠ NO CREDENTIAL, AND THAT IS THE DESIGN RATHER THAN AN OMISSION. The worker
 * hands mail to Stalwart's `relay` listener on 2525, which accepts without AUTH
 * because of where the connection comes from: the port has no hostPort and is
 * not in `allow-public-mail`, so only the cluster reaches it, and Stalwart
 * relays there only for the worker's `bounce+` envelope. There is no account to
 * create, no password to rotate and nothing in Doppler. It replaced an SMTP
 * submission account that could never have worked — Stalwart refuses to hold a
 * password for any account while authd is the directory. See
 * infra/k8s/i10/stalwart/config/README.md, "The internal relay".
 */
export interface RelayOptions {
  host: string
  port: number
  /** The name to give in EHLO. */
  localName: string
  /** Connections the pool may hold open; matched to the worker's fan-out. */
  poolSize: number
}

export function relayConfig(opts: RelayOptions): SmtpConfig {
  return {
    host: opts.host,
    port: opts.port,
    // ⚠ PLAINTEXT, AND BOTH FLAGS HAVE TO SAY SO. The relay listener offers no
    // TLS, and it must not start to: upyo upgrades opportunistically whenever a
    // server advertises STARTTLS, then verifies the certificate against the name
    // it dialled. Stalwart's certificate is `*.i10.tech` and the worker dials a
    // `.svc.cluster.local` name, and upyo has no `servername` to verify against
    // instead — so TLS here could only ever be unverified, which is theatre.
    //
    // What crosses this hop is the message and nothing else: there is no
    // credential on it to steal. On a single node it never leaves the host's
    // kernel. If the cluster grows a second node, encrypt pod traffic (flannel's
    // WireGuard backend) rather than this one connection.
    secure: false,
    // ⚠ THE LOWERCASE `s` IS LOAD-BEARING. nodemailer spelled it `requireTLS`,
    // and `SmtpConfig` takes unknown properties without complaint — the wrong
    // casing is not a type error, it is a flag that silently does nothing. There
    // is a test asserting this exact key.
    requireTls: false,
    // ⚠ NAMED EXPLICITLY, BECAUSE upyo's DEFAULT IS `localhost` AND THAT IS NOT A
    // NAME. An `EHLO localhost` is tolerated by most servers and refused by some,
    // and it is the sort of thing that shows up as an unexplained reputation
    // problem rather than as an error.
    localName: opts.localName,
    // One connection pool, reused across the batch's concurrency.
    pool: true,
    // ⚠ IT MUST MATCH THE FAN-OUT OR IT SILENTLY BECOMES THE REAL LIMIT. upyo
    // defaults `poolSize` to five; `WORKER_CONCURRENCY` defaults to eight. Left
    // alone, three of every eight direct sends wait for a connection with nothing
    // in the logs naming the ceiling, and the knob that env.ts documents as the
    // throughput control is not the one deciding throughput.
    poolSize: opts.poolSize,
  }
}
