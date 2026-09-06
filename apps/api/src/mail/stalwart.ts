import type { MailboxStorage } from "./storage.js"

/**
 * Stalwart's object registry, for the one number we need from it.
 *
 * ⚠ EVERY DETAIL BELOW WAS READ OFF THE RUNNING SERVER, NOT INFERRED. An
 * earlier version of this file guessed the wire shape from the source tree and
 * got four things wrong at once: the method name, the capability, the id type
 * and the call count. The probe transcript is in docs/decisions/metering.md.
 *
 *   POST {base}/jmap
 *   using        ["urn:ietf:params:jmap:core"]        ← and nothing else
 *   methodCalls  [["x:Account/query", …], ["x:Account/get", …]]
 *
 * ⚠ THE `x:` PREFIX IS THE REGISTRY'S NAMESPACE AND IT IS NOT OPTIONAL.
 * `Account/get` answers `unknownMethod`; `x:Account/get` returns the object.
 * The schema at `/api/schema` names every registry type this way — `x:Account`,
 * `x:Account/User`, `x:Account/Group` — while the RFC types (`Mailbox`,
 * `Principal`) carry no prefix. A vendor extension can be renamed between
 * releases, so a bump of the Stalwart image is a reason to re-run the probe.
 *
 * ⚠ AND NO VENDOR CAPABILITY IS ADVERTISED FOR IT. The session lists seventeen
 * `urn:ietf:…` capabilities and no Stalwart URI at all, authenticated or not.
 * Naming one in `using` is what a conforming server MUST reject, so `using`
 * carries core alone even though the method is an extension.
 */

/**
 * ⚠ AND THE SESSION'S OWN `apiUrl` IS DELIBERATELY IGNORED. It advertises
 * `https://mail.i10.tech/jmap/`, which is the public hostname — and Traefik
 * routes only autoconfig, autodiscover and MTA-STS to this pod, so every one of
 * those requests 404s. A conforming JMAP client follows `apiUrl`; ours must
 * not. `baseUrl` is the in-cluster service and stays authoritative.
 */
export interface StalwartOptions {
  /** e.g. `http://i10-stalwart:8080`. NOT the public hostname. */
  baseUrl: string
  /**
   * An admin credential, sent as `Bearer`.
   *
   * ⚠ NOT A USER'S PASSWORD, AND THERE IS NO PATH THAT WOULD LET IT BE ONE.
   * The RFC 9425 route — `Quota/get` — is scoped to the authenticated account,
   * and we never hold a user's password, because the whole authd
   * bind-delegation design exists so that we do not. The registry is the only
   * source that answers for accounts other than the caller's own.
   *
   * Stalwart accepts either an `x:ApiKey` as a bearer token or basic auth. A
   * key is the better credential here: it is revocable on its own and is not
   * the recovery admin's password.
   */
  token: string
  timeoutMs?: number
  fetch?: typeof fetch
}

/** The property carrying the figure. `server-set`, bytes, per the schema. */
const USED_DISK_QUOTA = "usedDiskQuota"

/** `maxObjectsInGet` from the session. Ids per `x:Account/get`. */
const GET_CHUNK = 500

/** Ids per `x:Account/query` page. */
const QUERY_PAGE = 500

interface RegistryAccount {
  id?: unknown
  emailAddress?: unknown
  "@type"?: unknown
  [key: string]: unknown
}

export function stalwartStorage(opts: StalwartOptions): MailboxStorage {
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? 10_000
  const base = opts.baseUrl.replace(/\/$/, "")

  async function call(methodCalls: unknown[]): Promise<unknown[]> {
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
          using: ["urn:ietf:params:jmap:core"],
          methodCalls,
        }),
      })

      if (!response.ok) throw new Error(`stalwart returned ${response.status}`)

      const body = (await response.json()) as {
        methodResponses?: [string, Record<string, unknown>, string][]
      }
      const first = body.methodResponses?.[0]
      if (!first) throw new Error("stalwart returned no method response")

      // ⚠ A JMAP ERROR IS A 200 WITH `error` IN THE SLOT WHERE THE METHOD NAME
      // GOES. Checking response.ok alone would read `unknownMethod` — the exact
      // failure this file was shipped with once — as a successful empty result.
      if (first[0] === "error") {
        const detail = first[1]
        throw new Error(
          `stalwart rejected the call: ${String(detail?.type ?? "unknown")} ${String(
            detail?.description ?? "",
          )}`.trim(),
        )
      }

      return [first[0], first[1]]
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async snapshot() {
      // ── every account id, paged ──────────────────────────────────────────
      const ids: string[] = []
      const seen = new Set<string>()

      for (let position = 0; ; position += QUERY_PAGE) {
        const [, result] = (await call([
          ["x:Account/query", { position, limit: QUERY_PAGE }, "q"],
        ])) as [string, { ids?: unknown }]

        const page = Array.isArray(result.ids) ? result.ids : []
        if (page.length === 0) break

        // ⚠ THE LOOP TERMINATES ON NEW IDS, NOT ON PAGE SIZE, BECAUSE `limit`
        // AND `position` ARE NOT VERIFIED. If the server ignores them it
        // returns the same full page forever, and a size-based condition spins.
        let added = 0
        for (const id of page) {
          if (typeof id !== "string" || seen.has(id)) continue
          seen.add(id)
          ids.push(id)
          added += 1
        }
        if (added === 0 || page.length < QUERY_PAGE) break
      }

      // ── their emails and usage, chunked ──────────────────────────────────
      const usage = new Map<string, number>()

      for (let i = 0; i < ids.length; i += GET_CHUNK) {
        const chunk = ids.slice(i, i + GET_CHUNK)
        const [, result] = (await call([["x:Account/get", { ids: chunk }, "g"]])) as [
          string,
          { list?: unknown },
        ]

        const list = Array.isArray(result.list)
          ? (result.list as RegistryAccount[])
          : []
        for (const account of list) {
          const email = account.emailAddress
          if (typeof email !== "string" || email.length === 0) continue

          // ⚠ A GROUP HAS NO `usedDiskQuota` AND THAT IS STRUCTURAL, NOT A
          // FAILURE. `x:Account` is a union: the `User` variant carries the
          // field, the `Group` variant does not have it at all — a group is a
          // delivery target with no store of its own. Treating the absence as
          // an error, which this file used to, would abort a whole tenant's
          // sample over a mailing list.
          if (account["@type"] === "Group") {
            usage.set(email.toLowerCase(), 0)
            continue
          }

          const bytes = account[USED_DISK_QUOTA]

          // ⚠ A MISSING PROPERTY ON A USER IS A FAILURE, NOT A ZERO. It means
          // the shape is not what we expect — a renamed property, a changed
          // variant tag — and every one of those reads as "uses no space" if it
          // is allowed to fall through, which grants the whole allowance to
          // everybody, silently, in the direction nobody reports.
          if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
            throw new Error(`no usable ${USED_DISK_QUOTA} for ${email}`)
          }

          usage.set(email.toLowerCase(), bytes)
        }
      }

      return usage
    },
  }
}
