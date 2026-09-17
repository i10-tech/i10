import { describe, expect, it } from "bun:test"
import { submissionConfig } from "../src/send/submission.js"

/**
 * The submission client's settings.
 *
 * ⚠ THESE LIVED IN worker.ts AND WERE UNVERIFIABLE THERE. That file has
 * top-level `await`, connects to Postgres and Redis on import and starts
 * draining queues, so nothing could import it to check a flag. Every setting
 * asserted here is one whose failure is silent rather than loud.
 */
const base = {
  host: "i10-stalwart.i10-prod.svc.cluster.local",
  port: 587,
  user: "submission",
  password: "hunter2",
  localName: "mail.i10.tech",
  poolSize: 8,
}

describe("submission config", () => {
  /**
   * ⚠ THE ONE THAT PUTS CREDENTIALS ON THE WIRE IF IT IS WRONG. upyo spells it
   * `requireTls`; nodemailer spelled it `requireTLS`, and this codebase carried
   * the nodemailer spelling for months. `SmtpConfig` takes unknown properties
   * without complaint, so the wrong casing is NOT a type error — it is a silent
   * `undefined` that makes STARTTLS optional. If Stalwart ever stops advertising
   * it, submission proceeds in the clear with the customer's message and our
   * AUTH credentials in it, and nothing anywhere says so.
   */
  it("requires STARTTLS, spelled the way upyo reads it", () => {
    const config = submissionConfig(base)

    expect(config.requireTls).toBe(true)
    // The nodemailer spelling must not be what is set, or the flag above is
    // decorative.
    expect(config).not.toHaveProperty("requireTLS")
  })

  /**
   * ⚠ `secure` AND `requireTls` ARE DIFFERENT THINGS AND 587 NEEDS THE SECOND.
   * `secure: true` speaks TLS from the first byte, which is 465's contract. On a
   * submission port expecting STARTTLS it hangs until the socket times out
   * rather than failing with anything that names the cause.
   */
  it("uses STARTTLS on 587 and implicit TLS on 465", () => {
    expect(submissionConfig({ ...base, port: 587 }).secure).toBe(false)
    expect(submissionConfig({ ...base, port: 465 }).secure).toBe(true)
    // Either way the upgrade is mandatory.
    expect(submissionConfig({ ...base, port: 587 }).requireTls).toBe(true)
    expect(submissionConfig({ ...base, port: 465 }).requireTls).toBe(true)
  })

  /**
   * ⚠ upyo DEFAULTS THE POOL TO FIVE AND THE WORKER FANS OUT TO EIGHT. Left
   * alone, three of every eight direct sends wait for a connection with nothing
   * in the logs naming the ceiling, and `WORKER_CONCURRENCY` — which env.ts
   * documents as the throughput control — is not the thing deciding throughput.
   */
  it("matches the pool to the worker's fan-out", () => {
    expect(submissionConfig({ ...base, poolSize: 8 }).poolSize).toBe(8)
    expect(submissionConfig({ ...base, poolSize: 24 }).poolSize).toBe(24)
    expect(submissionConfig(base).pool).toBe(true)
  })

  /** upyo's default EHLO name is `localhost`, which some servers refuse. */
  it("gives a real hostname in EHLO", () => {
    expect(submissionConfig(base).localName).toBe("mail.i10.tech")
    expect(submissionConfig(base).localName).not.toBe("localhost")
  })

  it("carries the credentials through", () => {
    expect(submissionConfig(base).auth).toEqual({
      user: "submission",
      pass: "hunter2",
    })
  })
})
