import type { MailboxStorage } from "./storage.js"

/**
 * Stalwart's registry API, for the one number we need from it.
 *
 * ⚠ THIS IS THE ONE PIECE OF THIS FEATURE THAT HAS NOT BEEN RUN AGAINST A REAL
 * SERVER. `crates/jmap/src/registry/get.rs` serves `UsedDiskQuota` as a
 * property of an `Account` object through a JMAP `get`, and that much is read
 * from their source — but the method name on the wire, and the exact envelope,
 * are not something a repository can confirm. Everything around it is tested
 * without a server; this needs one.
 *
 * ⚠ SO IT THROWS ON ANYTHING IT DOES NOT RECOGNISE, AND NEVER RETURNS 0. A
 * wrong guess about the shape would otherwise read as "this mailbox uses no
 * space", which grants the whole allowance to everybody — silently, and in the
 * direction nobody reports. The sampler treats a throw as "do not write a
 * total", so a mistake here leaves the previous figure standing instead of
 * replacing it with a fiction.
 */

export interface StalwartOptions {
  /** e.g. `https://mail.i10.tech`. The JMAP endpoint lives under it. */
  baseUrl: string
  /**
   * An admin credential.
   *
   * ⚠ NOT A USER'S PASSWORD, AND THERE IS NO PATH THAT WOULD LET IT BE ONE.
   * Stalwart also reports usage through JMAP `Quota/get` and IMAP `GETQUOTA`,
   * both authenticated AS the account — and we never hold a user's password,
   * because the whole authd bind-delegation design exists so that we do not.
   */
  token: string
  timeoutMs?: number
  fetch?: typeof fetch
}

/** The JMAP object property that carries the figure. */
const USED_DISK_QUOTA = "usedDiskQuota"

export function stalwartStorage(opts: StalwartOptions): MailboxStorage {
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? 10_000
  const base = opts.baseUrl.replace(/\/$/, "")

  return {
    async usedBytes(email) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await doFetch(`${base}/jmap`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.token}`,
            "content-type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            using: ["urn:ietf:params:jmap:core", "urn:stalwart:params:jmap:registry"],
            methodCalls: [
              ["Account/get", { ids: [email], properties: [USED_DISK_QUOTA] }, "s0"],
            ],
          }),
        })

        if (!response.ok) {
          throw new Error(`stalwart returned ${response.status}`)
        }

        const body = (await response.json()) as {
          methodResponses?: [string, { list?: Record<string, unknown>[] }, string][]
        }

        const account = body.methodResponses?.[0]?.[1]?.list?.[0]
        const bytes = account?.[USED_DISK_QUOTA]

        // ⚠ A MISSING PROPERTY IS A FAILURE, NOT A ZERO. It means the shape is
        // not what we expect — a renamed property, a different method name, an
        // account the server does not know — and every one of those reads as
        // "uses no space" if it is allowed to fall through.
        if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
          throw new Error(`no usable ${USED_DISK_QUOTA} for ${email}`)
        }

        return bytes
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
