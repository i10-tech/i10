import type { Mailbox } from "@repo/contracts"

/**
 * JMAP calls made AS a mailbox, for reading and writing a person's mail.
 *
 * ⚠ ACTING AS ANOTHER ACCOUNT IS JUST THE `accountId`. Read off the running
 * server (1.0.3), not inferred: a caller holding the `impersonate` permission -
 * superusers have it, and for a key it is a permission on the `x:ApiKey` -
 * passes the target's id as the `accountId` of an ordinary JMAP method call.
 * There is no master-user login and no extra header.
 *
 *   POST {base}/jmap          authorization: Bearer <impersonation key>
 *   using        ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"]
 *   methodCalls  [["Mailbox/get", { accountId: <target>, … }, "c0"]]
 *
 * The JMAP accountId IS the registry `x:Account` id (`e` for mohamed@i10.tech
 * in both), which is why the id is looked up in the registry and not guessed.
 * As in `stalwart.ts`, the session's own `apiUrl` is ignored: it names the
 * public hostname, which does not route to the management pod.
 *
 * ⚠ STALWART ACCEPTS ANY WELL-FORMED ID, EVEN ONE FOR NO ACCOUNT. `"zzzz"` (no
 * such account) and `"f"` (an account destroyed a minute earlier) both answered
 * with a fresh set of default mailboxes, created on the spot. Only a malformed
 * id (`"!!"`) gets `accountNotFound`. So the server will not catch a wrong or
 * stale id; it silently writes data for a phantom account, and the mail the
 * caller meant to read or write goes nowhere. Correctness of the id is entirely
 * this file's job, and it is enforced three ways:
 *
 *   - the input is an i10 mailbox apps/api has already authorised for a
 *     workspace, never an account id, and the id is branded so a string
 *     cannot be passed where a resolved one is required;
 *   - an empty or ambiguous registry lookup is an error, and the account
 *     found must carry exactly the requested address, never "use the id anyway";
 *   - the cache is short and dropped when the mailbox goes (`forget`).
 *
 * ⚠ THE CALLER NEVER NAMES AN ACCOUNT. `call` injects `accountId` into every
 * method itself and refuses arguments that already carry one.
 *
 * ONE-TIME SETUP, DONE BY A PERSON AND NOT BY THIS CODE:
 *   1. In the registry, create an `x:ApiKey` with the `impersonate` permission
 *      (and no more than that and what it needs to read mail).
 *   2. Store its secret in Doppler config `prod_api` as
 *      `STALWART_IMPERSONATE_TOKEN`.
 *   3. Restart the API, since a Doppler change reloads no pod.
 * Registry lookups keep using the existing admin token (`STALWART_API_TOKEN`),
 * so the impersonation key never needs to read the registry.
 */

declare const resolvedAccount: unique symbol

/**
 * A Stalwart account id that came out of a verified registry lookup.
 *
 * ⚠ ONLY `resolveAccount` MINTS ONE. The type is exported and the constructor
 * is not, so the only way to hold a value of it is to have gone through the
 * checks that make it safe - a bare string does not typecheck.
 */
export type StalwartAccountId = string & { readonly [resolvedAccount]: true }

const mint = (id: string) => id as StalwartAccountId

export type JmapAsFailure =
  /** The address is not a plausible mailbox address; the registry was not asked. */
  | "invalid_address"
  /** The registry has no account for the address. */
  | "no_account"
  /** The registry answered with more than one account, or one we cannot trust. */
  | "ambiguous_account"
  /** The account found does not carry the requested address. */
  | "address_mismatch"
  /** The server refused or could not be reached. */
  | "stalwart"

export class JmapAsError extends Error {
  constructor(
    readonly code: JmapAsFailure,
    message: string,
  ) {
    super(message)
    this.name = "JmapAsError"
  }
}

/** The mailbox as apps/api knows it, once it has been authorised for a workspace. */
export type AuthorisedMailbox = Pick<Mailbox, "address">

export type JmapMethod = readonly [
  name: string,
  args: Record<string, unknown>,
  callId: string,
]

export type JmapResponse = [
  name: string,
  result: Record<string, unknown>,
  callId: string,
]

export interface JmapAsOptions {
  /** e.g. `http://i10-stalwart:8080`. NOT the public hostname. */
  baseUrl: string
  /** The existing admin credential. Used for the registry lookup only. */
  registryToken: string
  /**
   * An `x:ApiKey` holding `impersonate`, sent as `Bearer` on mailbox calls only.
   *
   * ⚠ NEVER THE ADMIN TOKEN. Reading another account's mail is a different
   * power from reading the registry, and a key that can only do the first is
   * revocable on its own.
   */
  impersonationToken: string
  timeoutMs?: number
  fetch?: typeof fetch
  cache?: MailboxIdCache
}

export interface JmapAsClient {
  /** Runs the methods against the mailbox's own account, in one request. */
  call(
    mailbox: AuthorisedMailbox,
    methods: readonly JmapMethod[],
    using?: readonly string[],
  ): Promise<JmapResponse[]>
}

/** Long enough to spare the registry on a burst, short enough to bound a miss. */
const DEFAULT_TTL_MS = 60_000

/** Core plus mail: the capabilities `Mailbox/*` and `Email/*` are declared under. */
const MAIL_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"] as const

const REGISTRY_USING = ["urn:ietf:params:jmap:core"] as const

/**
 * Resolved ids by address, with a TTL.
 *
 * ⚠ `forget` MUST RUN WHEN A MAILBOX IS DELETED OR RENAMED. A cached id outliving
 * its account is the phantom-account trap: Stalwart would answer for it. It is
 * called from `projection/writer.ts`, the one place a mailbox row is removed.
 * The cache is per process, so another process keeps its entry for at most the
 * TTL, which is the bound on how long a deleted mailbox can still resolve there.
 */
export class MailboxIdCache {
  private readonly entries = new Map<
    string,
    { id: StalwartAccountId; expires: number }
  >()
  private epoch = 0

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(address: string): StalwartAccountId | null {
    const key = address.toLowerCase()
    const hit = this.entries.get(key)
    if (!hit) return null
    if (hit.expires <= this.now()) {
      this.entries.delete(key)
      return null
    }
    return hit.id
  }

  /** The value to hand back to `set`, so a lookup in flight across a `forget` is dropped. */
  begin(): number {
    return this.epoch
  }

  set(address: string, id: StalwartAccountId, began: number): void {
    // ⚠ A LOOKUP THAT STARTED BEFORE THE MAILBOX WAS FORGOTTEN MUST NOT WRITE
    // ITS ANSWER BACK, or the delete it raced with is undone.
    if (began !== this.epoch) return
    this.entries.set(address.toLowerCase(), { id, expires: this.now() + this.ttlMs })
  }

  forget(address: string): void {
    this.epoch += 1
    this.entries.delete(address.toLowerCase())
  }
}

/** The cache the API process shares; the projection writer invalidates it. */
export const mailboxIdCache = new MailboxIdCache()

const ADDRESS = /^[^\s@]+@[^\s@]+$/

export function jmapAs(opts: JmapAsOptions): JmapAsClient {
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? 10_000
  const base = opts.baseUrl.replace(/\/$/, "")
  const cache = opts.cache ?? mailboxIdCache

  async function post(
    token: string,
    using: readonly string[],
    methodCalls: readonly JmapMethod[] | unknown[],
  ): Promise<JmapResponse[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await doFetch(`${base}/jmap`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({ using, methodCalls }),
      })

      if (!response.ok) {
        throw new JmapAsError("stalwart", `stalwart returned ${response.status}`)
      }

      const body = (await response.json()) as { methodResponses?: JmapResponse[] }
      const responses = body.methodResponses
      if (!Array.isArray(responses) || responses.length === 0) {
        throw new JmapAsError("stalwart", "stalwart returned no method response")
      }

      // ⚠ A JMAP ERROR IS A 200 WITH `error` IN THE SLOT WHERE THE METHOD NAME
      // GOES, as in `stalwart.ts`; response.ok alone would read it as success.
      for (const [name, result] of responses) {
        if (name === "error") {
          throw new JmapAsError(
            "stalwart",
            `stalwart rejected the call: ${String(result?.type ?? "unknown")} ${String(
              result?.description ?? "",
            )}`.trim(),
          )
        }
      }

      return responses
    } catch (error) {
      if (error instanceof JmapAsError) throw error
      throw new JmapAsError(
        "stalwart",
        `stalwart unreachable: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * ⚠ THERE IS NO `emailAddress` FILTER. Probed on 1.0.3: it answers
   * `unsupportedFilter`, and `text` matches neither a full address nor case
   * variants. `name` is exact (`mohamed` does not match `mohamed-legacy`) and
   * is the address's local part, so the query narrows by local part and the
   * exact address check below picks the account. Two domains sharing a local
   * part both come back from the query; only one can carry the address.
   */
  async function lookup(address: string): Promise<StalwartAccountId> {
    const localPart = address.slice(0, address.lastIndexOf("@"))
    const [, queried] = (
      await post(opts.registryToken, REGISTRY_USING, [
        ["x:Account/query", { filter: { name: localPart } }, "q"],
      ])
    )[0]!

    const ids = (Array.isArray(queried.ids) ? queried.ids : []).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    )
    if (ids.length === 0) {
      throw new JmapAsError("no_account", `no stalwart account for ${address}`)
    }

    const [, fetched] = (
      await post(opts.registryToken, REGISTRY_USING, [
        ["x:Account/get", { ids, properties: ["@type", "emailAddress"] }, "g"],
      ])
    )[0]!

    const list = Array.isArray(fetched.list)
      ? (fetched.list as Record<string, unknown>[])
      : []
    const carrying = list.filter(
      (account) =>
        typeof account.emailAddress === "string" &&
        account.emailAddress.toLowerCase() === address &&
        typeof account.id === "string" &&
        ids.includes(account.id),
    )

    if (carrying.length === 0) {
      throw new JmapAsError(
        "address_mismatch",
        `no stalwart account carries ${address}`,
      )
    }

    // ⚠ MORE THAN ONE IS AN ERROR, NOT "TAKE THE FIRST": the first of a list is
    // somebody else's account as often as not.
    if (carrying.length !== 1) {
      throw new JmapAsError(
        "ambiguous_account",
        `${carrying.length} stalwart accounts carry ${address}`,
      )
    }

    const account = carrying[0]!
    // A group is a delivery target with no store of its own; it has no mail to act on.
    if (account["@type"] === "Group") {
      throw new JmapAsError("ambiguous_account", `${address} is a group, not a mailbox`)
    }

    return mint(account.id as string)
  }

  async function resolveAccount(
    mailbox: AuthorisedMailbox,
  ): Promise<StalwartAccountId> {
    const address = mailbox.address.trim().toLowerCase()
    if (!ADDRESS.test(address)) {
      throw new JmapAsError(
        "invalid_address",
        `not a mailbox address: ${mailbox.address}`,
      )
    }

    const cached = cache.get(address)
    if (cached) return cached

    const began = cache.begin()
    const id = await lookup(address)
    cache.set(address, id, began)
    return id
  }

  return {
    async call(mailbox, methods, using = MAIL_USING) {
      // ⚠ REFUSED RATHER THAN OVERWRITTEN: an `accountId` in the arguments means
      // a caller is trying to name the account, and silently replacing it would
      // hide the bug that put it there. Checked before the registry is asked.
      for (const [name, args] of methods) {
        if ("accountId" in args) {
          throw new Error(
            `${name}: accountId is supplied by the client, not the caller`,
          )
        }
      }

      const accountId = await resolveAccount(mailbox)

      return post(
        opts.impersonationToken,
        using,
        methods.map(([name, args, callId]): JmapMethod => [
          name,
          { ...args, accountId },
          callId,
        ]),
      )
    },
  }
}
