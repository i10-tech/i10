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
  /** The blob is not there (a message deleted while it was being read). */
  | "not_found"
  /** The account has no room left. Retrying cannot help. */
  | "over_quota"
  /** The server's size limit for one message or upload. */
  | "too_large"

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

/**
 * A team inbox as apps/api knows it: its address, and the name it was given in
 * the directory (`authd.groups.name`). Only the address reaches the registry
 * lookup; the directory name is carried for the callers that need it.
 */
export interface AuthorisedGroup {
  address: string
  name: string
}

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

  /**
   * Runs the methods against a team inbox's Group account.
   *
   * `from` is the mailbox a cross-account method (`Email/copy`) reads from; its
   * id is resolved and injected as `fromAccountId` exactly as the destination's
   * is as `accountId`, and a caller supplying either is refused.
   */
  callAsGroup(
    group: AuthorisedGroup,
    methods: readonly JmapMethod[],
    options?: { using?: readonly string[]; from?: AuthorisedMailbox },
  ): Promise<JmapResponse[]>

  /**
   * Destroys the team inbox's Group account, mail and all. `false` when the
   * registry has no such account, which for a group that nobody has signed in to
   * yet is the ordinary case.
   */
  destroyGroup(group: AuthorisedGroup): Promise<boolean>

  /**
   * Takes these mailboxes out of the team inbox's Group account in the registry,
   * so they lose access now rather than at their next directory lookup.
   * Nothing to do when either side has no account yet.
   */
  revokeGroup(
    group: AuthorisedGroup,
    members: readonly AuthorisedMailbox[],
  ): Promise<void>

  /**
   * Streams a blob out of the mailbox's account. The body is NOT read here:
   * the caller pulls it, so a 50 MB message is never held whole.
   *
   * ⚠ THE TIMEOUT COVERS THE RESPONSE HEADERS ONLY. The body of a large blob
   * legitimately takes longer than `timeoutMs`; a stalled body is the job
   * timeout's business.
   */
  downloadBlob(mailbox: AuthorisedMailbox, blobId: string): Promise<BlobDownload>

  /** Uploads one raw RFC 5322 message AS the mailbox's account. */
  uploadBlob(
    mailbox: AuthorisedMailbox,
    bytes: Uint8Array,
  ): Promise<{ blobId: string; size: number }>
}

export interface BlobDownload {
  body: ReadableStream<Uint8Array>
  /** `Content-Length`, when the server sent one. */
  size: number | null
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

  // ⚠ THE KIND IS PART OF THE KEY. An address is one account, but a group's id
  // must never answer for a user lookup or the reverse; the type check in
  // `lookup` only runs on a miss.
  private key(address: string, kind: AccountKind): string {
    return `${kind}:${address.toLowerCase()}`
  }

  get(address: string, kind: AccountKind = "User"): StalwartAccountId | null {
    const key = this.key(address, kind)
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

  set(
    address: string,
    id: StalwartAccountId,
    began: number,
    kind: AccountKind = "User",
  ): void {
    // ⚠ A LOOKUP THAT STARTED BEFORE THE MAILBOX WAS FORGOTTEN MUST NOT WRITE
    // ITS ANSWER BACK, or the delete it raced with is undone.
    if (began !== this.epoch) return
    this.entries.set(this.key(address, kind), {
      id,
      expires: this.now() + this.ttlMs,
    })
  }

  /** Drops both kinds: whatever the address was, it no longer resolves. */
  forget(address: string): void {
    this.epoch += 1
    this.entries.delete(this.key(address, "User"))
    this.entries.delete(this.key(address, "Group"))
  }
}

type AccountKind = "User" | "Group"

/** The cache the API process shares; the projection writer invalidates it. */
export const mailboxIdCache = new MailboxIdCache()

const ADDRESS = /^[^\s@]+@[^\s@]+$/

/**
 * One registry round trip: the method calls in, the FIRST method's result out.
 * The caller supplies the credential, so the lookup below serves both the
 * impersonation client (which reads the registry with the admin token) and the
 * quota sync.
 */
export type RegistryCall = (methodCalls: unknown[]) => Promise<Record<string, unknown>>

/** The registry account found for an address; `id` is a bare string, not yet minted. */
export interface RegistryMatch {
  id: string
  "@type"?: unknown
}

/**
 * The registry account carrying exactly `address`.
 *
 * ⚠ THERE IS NO `emailAddress` FILTER. Probed on 1.0.3: it answers
 * `unsupportedFilter`, and `text` matches neither a full address nor case
 * variants. `name` is exact (`mohamed` does not match `mohamed-legacy`) and
 * is the address's local part, so the query narrows by local part and the
 * exact address check below picks the account. Two domains sharing a local
 * part both come back from the query; only one can carry the address.
 *
 * Throws `JmapAsError` `no_account` / `address_mismatch` when nothing carries
 * it and `ambiguous_account` when more than one does. It never creates anything.
 */
export async function findRegistryAccount(
  registry: RegistryCall,
  address: string,
  registryName?: string,
): Promise<RegistryMatch> {
  const wanted = address.toLowerCase()
  const name = registryName ?? wanted.slice(0, wanted.lastIndexOf("@"))
  const queried = await registry([["x:Account/query", { filter: { name } }, "q"]])

  const ids = (Array.isArray(queried.ids) ? queried.ids : []).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  )
  if (ids.length === 0) {
    throw new JmapAsError("no_account", `no stalwart account for ${address}`)
  }

  const fetched = await registry([
    ["x:Account/get", { ids, properties: ["@type", "emailAddress"] }, "g"],
  ])

  const list = Array.isArray(fetched.list)
    ? (fetched.list as Record<string, unknown>[])
    : []
  const carrying = list.filter(
    (account) =>
      typeof account.emailAddress === "string" &&
      account.emailAddress.toLowerCase() === wanted &&
      typeof account.id === "string" &&
      ids.includes(account.id),
  )

  if (carrying.length === 0) {
    throw new JmapAsError("address_mismatch", `no stalwart account carries ${address}`)
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
  return { id: account.id as string, "@type": account["@type"] }
}

/*
 * ⚠ THE TWO BLOB URLS, BUILT HERE AND NOWHERE ELSE. They are RFC 8620's
 * `downloadUrl` and `uploadUrl` templates (sections 6.2 and 6.1) as Stalwart
 * documents them (`/jmap/download/<accountId>/<blobId>/<name>` and
 * `/jmap/upload/<accountId>/`), with the in-cluster base put in front. A client
 * is supposed to take the templates from `/jmap/session`, and this one does
 * not: the session advertises the PUBLIC hostname, which does not route to the
 * management pod (see the header). So the paths are copied, and the copy is the
 * risk.
 *
 * ⚠ RE-CHECK BOTH AGAINST `GET /jmap/session` ON EVERY STALWART UPGRADE. A
 * moved path answers 404 to every export and import, and the symptom is the
 * job failing, not anything at startup.
 */
export const blobDownloadUrl = (
  base: string,
  accountId: string,
  blobId: string,
  name = "message.eml",
) =>
  `${base}/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/${encodeURIComponent(name)}`

export const blobUploadUrl = (base: string, accountId: string) =>
  `${base}/jmap/upload/${encodeURIComponent(accountId)}/`

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

  async function lookup(
    address: string,
    kind: AccountKind,
    registryName: string,
  ): Promise<StalwartAccountId> {
    const account = await findRegistryAccount(
      async (methodCalls) =>
        (await post(opts.registryToken, REGISTRY_USING, methodCalls))[0]![1],
      address,
      registryName,
    )

    // ⚠ THE KIND MUST MATCH IN BOTH DIRECTIONS. A mailbox call must not land on a
    // group's account, and a team inbox call must not land on somebody's own.
    if ((account["@type"] === "Group") !== (kind === "Group")) {
      throw new JmapAsError(
        "ambiguous_account",
        kind === "Group"
          ? `${address} is not a group`
          : `${address} is a group, not a mailbox`,
      )
    }

    return mint(account.id)
  }

  async function resolve(
    rawAddress: string,
    kind: AccountKind,
    registryName: (address: string) => string,
  ): Promise<StalwartAccountId> {
    const address = rawAddress.trim().toLowerCase()
    if (!ADDRESS.test(address)) {
      throw new JmapAsError("invalid_address", `not a mailbox address: ${rawAddress}`)
    }

    const cached = cache.get(address, kind)
    if (cached) return cached

    const began = cache.begin()
    const id = await lookup(address, kind, registryName(address))
    cache.set(address, id, began, kind)
    return id
  }

  // ⚠ A REGISTRY NAME IS THE LOCAL PART OF THE ADDRESS, FOR USERS AND GROUPS
  // ALIKE (probed on 1.0.3: the directory group `probe-team@i10.tech` became the
  // Group account `probe-team`). Two workspaces' `support@` therefore share a
  // name; the exact `emailAddress` match in `lookup` is what tells them apart.
  const localPart = (a: string) => a.slice(0, a.lastIndexOf("@"))

  const resolveAccount = (mailbox: AuthorisedMailbox) =>
    resolve(mailbox.address, "User", localPart)

  const resolveGroup = (group: AuthorisedGroup) =>
    resolve(group.address, "Group", localPart)

  // ⚠ REFUSED RATHER THAN OVERWRITTEN: an account id in the arguments means a
  // caller is trying to name the account, and silently replacing it would hide
  // the bug that put it there. Checked before the registry is asked.
  const refuseNamedAccounts = (methods: readonly JmapMethod[]) => {
    for (const [name, args] of methods) {
      if ("accountId" in args || "fromAccountId" in args) {
        throw new Error(`${name}: accountId is supplied by the client, not the caller`)
      }
    }
  }

  return {
    async call(mailbox, methods, using = MAIL_USING) {
      refuseNamedAccounts(methods)

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

    async callAsGroup(group, methods, options = {}) {
      refuseNamedAccounts(methods)

      const accountId = await resolveGroup(group)
      const fromAccountId = options.from ? await resolveAccount(options.from) : null

      return post(
        opts.impersonationToken,
        options.using ?? MAIL_USING,
        methods.map(([name, args, callId]): JmapMethod => [
          name,
          // ⚠ ONLY A COPY TAKES A SOURCE ACCOUNT. The other methods would
          // answer `invalidArguments` to an argument they do not define.
          fromAccountId && name.endsWith("/copy")
            ? { ...args, accountId, fromAccountId }
            : { ...args, accountId },
          callId,
        ]),
      )
    },

    async destroyGroup(group) {
      let id: StalwartAccountId
      try {
        id = await resolveGroup(group)
      } catch (error) {
        if (error instanceof JmapAsError && error.code === "no_account") return false
        throw error
      }

      const [, result] = (
        await post(opts.registryToken, REGISTRY_USING, [
          ["x:Account/set", { destroy: [id] }, "d"],
        ])
      )[0]!
      cache.forget(group.address)

      const destroyed = Array.isArray(result.destroyed) ? result.destroyed : []
      if (!destroyed.includes(id)) {
        throw new JmapAsError(
          "stalwart",
          `stalwart did not destroy the account for ${group.address}`,
        )
      }
      return true
    },

    /**
     * ⚠ REMOVING THE DIRECTORY ROW IS NOT ENOUGH. Probed on prod (1.0.3,
     * 2026-11-06): with the member's `authd.group_members` row deleted, the
     * account kept the group's folders for the full 15 minutes measured,
     * because Stalwart refreshes memberships only when it looks the account up
     * in the directory again (a new sign-in, or mail arriving for it). Clearing
     * the group from the account's `memberGroupIds` took access away at once.
     */
    async revokeGroup(group, members) {
      let groupId: StalwartAccountId
      try {
        groupId = await resolveGroup(group)
      } catch (error) {
        if (error instanceof JmapAsError && error.code === "no_account") return
        throw error
      }

      for (const member of members) {
        let memberId: StalwartAccountId
        try {
          memberId = await resolveAccount(member)
        } catch (error) {
          if (error instanceof JmapAsError && error.code === "no_account") continue
          throw error
        }

        const [, got] = (
          await post(opts.registryToken, REGISTRY_USING, [
            ["x:Account/get", { ids: [memberId], properties: ["memberGroupIds"] }, "g"],
          ])
        )[0]!
        const account = (Array.isArray(got.list) ? got.list[0] : undefined) as
          { memberGroupIds?: Record<string, boolean> } | undefined
        const groups = { ...(account?.memberGroupIds ?? {}) }
        if (!(groupId in groups)) continue
        delete groups[groupId]

        const [, set] = (
          await post(opts.registryToken, REGISTRY_USING, [
            [
              "x:Account/set",
              { update: { [memberId]: { memberGroupIds: groups } } },
              "s",
            ],
          ])
        )[0]!
        const updated = (set.updated ?? {}) as Record<string, unknown>
        if (!(memberId in updated)) {
          throw new JmapAsError(
            "stalwart",
            `stalwart did not remove ${member.address} from ${group.address}`,
          )
        }
      }
    },

    async downloadBlob(mailbox, blobId) {
      const accountId = await resolveAccount(mailbox)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await doFetch(blobDownloadUrl(base, accountId, blobId), {
          method: "GET",
          headers: { authorization: `Bearer ${opts.impersonationToken}` },
          signal: controller.signal,
        })

        if (!response.ok) {
          await response.body?.cancel()
          throw new JmapAsError(
            response.status === 404 ? "not_found" : "stalwart",
            `stalwart blob download returned ${response.status}`,
          )
        }
        if (!response.body) {
          throw new JmapAsError("stalwart", "stalwart blob download had no body")
        }

        const length = Number(response.headers.get("content-length"))
        return {
          body: response.body,
          size: Number.isSafeInteger(length) && length >= 0 ? length : null,
        }
      } catch (error) {
        if (error instanceof JmapAsError) throw error
        throw new JmapAsError(
          "stalwart",
          `stalwart unreachable: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        // Headers are in; the body is the caller's to pull, and must not be
        // cut off by a timer that was only ever for the headers.
        clearTimeout(timer)
      }
    },

    async uploadBlob(mailbox, bytes) {
      const accountId = await resolveAccount(mailbox)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await doFetch(blobUploadUrl(base, accountId), {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.impersonationToken}`,
            "content-type": "message/rfc822",
          },
          // Cast for the DOM typings, as in `streamOf`: a message is never shared memory.
          body: bytes as Uint8Array<ArrayBuffer>,
          signal: controller.signal,
        })

        if (!response.ok) {
          // ⚠ QUOTA AND SIZE ARE TOLD APART, because only one of them is the
          // customer's to fix by freeing space. Stalwart's wording for a full
          // account is not pinned down, so the status or the body's word for it
          // both count.
          const detail = (await response.text().catch(() => "")).slice(0, 300)
          if (response.status === 507 || /quota/i.test(detail)) {
            throw new JmapAsError(
              "over_quota",
              `the mailbox is over its quota (stalwart returned ${response.status})`,
            )
          }
          if (response.status === 413) {
            throw new JmapAsError(
              "too_large",
              "stalwart refused the message as too large (413)",
            )
          }
          throw new JmapAsError(
            "stalwart",
            `stalwart blob upload returned ${response.status}`,
          )
        }

        const body = (await response.json()) as { blobId?: string; size?: number }
        if (!body.blobId) {
          throw new JmapAsError("stalwart", "stalwart returned no blobId")
        }
        return { blobId: body.blobId, size: body.size ?? bytes.byteLength }
      } catch (error) {
        if (error instanceof JmapAsError) throw error
        throw new JmapAsError(
          "stalwart",
          `stalwart unreachable: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
