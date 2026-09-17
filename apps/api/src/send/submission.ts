import type { SmtpConfig } from "@upyo/smtp"

/**
 * The submission client's configuration, built where it can be asserted.
 *
 * ⚠ THIS IS A SEPARATE FUNCTION BECAUSE worker.ts CANNOT BE IMPORTED BY A TEST.
 * That file has top-level `await`, connects to Postgres and Redis on import and
 * starts draining queues — so every setting inside it was, until now, unverified
 * by construction. The settings here are the ones whose failure is silent, which
 * is exactly the set that should not live somewhere untestable.
 *
 * ⚠ AND `SmtpConfig` ACCEPTS UNKNOWN PROPERTIES WITHOUT COMPLAINT, WHICH IS WHY
 * THE SPELLING MATTERS MORE THAN IT LOOKS. `requireTLS` — nodemailer's casing,
 * and the one already in this codebase's muscle memory — is not a type error
 * against upyo's `requireTls`. It is a silent `undefined`, which means STARTTLS
 * becomes optional: if Stalwart ever stops advertising it, submission proceeds
 * in the clear, carrying both the customer's message and our AUTH credentials.
 * Nothing fails, nothing logs, and the only symptom is on somebody's network tap.
 */
export interface SubmissionOptions {
  host: string
  port: number
  user: string
  password: string
  /** The name to give in EHLO. */
  localName: string
  /** Connections the pool may hold open; matched to the worker's fan-out. */
  poolSize: number
}

export function submissionConfig(opts: SubmissionOptions): SmtpConfig {
  return {
    host: opts.host,
    port: opts.port,
    // ⚠ STARTTLS ON 587 RATHER THAN IMPLICIT TLS. `secure: true` would speak TLS
    // from the first byte, which is 465's contract, not 587's — against a
    // submission port that expects STARTTLS it hangs until the socket times out
    // rather than failing with anything that names the cause.
    secure: opts.port === 465,
    // ⚠ THE LOWERCASE `s` IS LOAD-BEARING. See the note above; there is a test
    // asserting this exact key.
    requireTls: true,
    auth: { user: opts.user, pass: opts.password },
    // ⚠ NAMED EXPLICITLY, BECAUSE upyo's DEFAULT IS `localhost` AND THAT IS NOT A
    // NAME. An `EHLO localhost` from an authenticated submission client is
    // tolerated by most servers and refused by some, and it is the sort of thing
    // that shows up as an unexplained reputation problem rather than as an error.
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
