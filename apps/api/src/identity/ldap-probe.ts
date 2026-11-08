import { Client, SizeLimitExceededError } from "ldapts"
import type { EgressVerdict } from "../webhooks/egress.js"
import { renderFilter, type PassthroughSettings } from "./ldap.js"
import type { Logger } from "./ports.js"

/**
 * The setup test for a connection's LDAP pass-through (#344): the same walk
 * authd makes at a bind, run once, so an admin hears about a wrong host, a
 * certificate that does not verify or a filter that finds nobody before any
 * mail client does.
 *
 * ⚠ THE HOST IS CUSTOMER INPUT AND THE API SITS INSIDE THE CLUSTER. It is
 * resolved and vetted (public addresses only: no loopback, private,
 * link-local or metadata) by the egress guard before anything is sent, and
 * the connection goes to the vetted ADDRESS, with the name kept only as the
 * TLS server name. A name that resolves somewhere else a moment later cannot
 * redirect the connection, and a service secret is never sent to a host that
 * was not checked.
 *
 * ⚠ TLS IS NOT OPTIONAL. `ldaps` is TLS from the first byte; `starttls`
 * upgrades before anything else is sent, and a server that will not upgrade is
 * a `tls_failed`, never a plaintext bind. The certificate is verified against
 * the system roots, or against the pinned CA when the connection has one.
 *
 * ⚠ THE TEST USER'S PASSWORD IS USED FOR THIS CALL AND NOTHING ELSE: it is not
 * stored, logged or put in an error, and the audit event says only whether a
 * user bind was tried.
 */

/** The fixed answers the console shows. */
export const PROBE_RESULTS = [
  "ok",
  "unreachable",
  "tls_failed",
  "service_bind_failed",
  "user_not_found",
  "user_bind_failed",
] as const
export type ProbeResult = (typeof PROBE_RESULTS)[number]

export interface ProbeInput extends PassthroughSettings {
  /** The address to look for. */
  address: string
  /** When given, bind as the entry found. */
  password?: string
}

export interface ProbeOutcome {
  result: ProbeResult
  /** For our audit log only, never the console: why `user_not_found` was said. */
  detail?: "not_found" | "ambiguous"
}

export interface LdapProbe {
  run(input: ProbeInput): Promise<ProbeOutcome>
}

export interface LdapProbeDeps {
  /** `vetHost` with the deployment's allow list (index.ts). */
  vet: (host: string, signal: AbortSignal) => Promise<EgressVerdict>
  log: Logger
  /** Per operation, and for the connection. */
  timeoutMs?: number
}

const TOTAL_MS = 20_000

/** A failure to verify the server's certificate or to speak TLS at all. */
function isTlsFailure(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "")
  return /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(VERIFY|GET)|HOSTNAME_MISMATCH|ERR_OSSL)/.test(
    code,
  )
}

export function ldapProbe(deps: LdapProbeDeps): LdapProbe {
  const timeout = deps.timeoutMs ?? 5_000
  return {
    async run(input) {
      const signal = AbortSignal.timeout(TOTAL_MS)
      const verdict = await deps.vet(input.host, signal)
      if (!verdict.ok) {
        deps.log.warn(
          { host: input.host, kind: verdict.kind },
          "an LDAP pass-through host was refused by the egress guard",
        )
        return { result: "unreachable" }
      }
      const at = verdict.family === 6 ? `[${verdict.address}]` : verdict.address
      const tlsOptions = {
        // ⚠ THE NAME THE CERTIFICATE IS CHECKED AGAINST, while the socket goes
        // to the vetted address.
        servername: input.host,
        ...(input.caPem ? { ca: input.caPem } : {}),
        minVersion: "TLSv1.2" as const,
        rejectUnauthorized: true,
      }
      const client = new Client({
        url: `${input.tlsMode === "ldaps" ? "ldaps" : "ldap"}://${at}:${input.port}`,
        timeout,
        connectTimeout: timeout,
        tlsOptions,
        strictDN: false,
      })
      try {
        return await Promise.race([
          walk(client, input, tlsOptions),
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("timeout")), {
              once: true,
            })
          }),
        ])
      } catch (error) {
        deps.log.warn(
          { host: input.host, err: errorName(error) },
          "an LDAP pass-through test could not finish",
        )
        return { result: isTlsFailure(error) ? "tls_failed" : "unreachable" }
      } finally {
        await client.unbind().catch((error: unknown) => {
          deps.log.warn(
            { err: errorName(error) },
            "an LDAP test connection did not close",
          )
        })
      }
    },
  }
}

async function walk(
  client: Client,
  input: ProbeInput,
  tlsOptions: Record<string, unknown>,
): Promise<ProbeOutcome> {
  // ⚠ BEFORE ANYTHING ELSE IS SENT: the upgrade is the first operation.
  if (input.tlsMode === "starttls") await client.startTLS(tlsOptions)

  try {
    await client.bind(input.bindDn, input.bindSecret)
  } catch (error) {
    // A transport or TLS failure surfaces on the first operation; only an
    // answer from the directory is a statement about the service account.
    if (isTlsFailure(error) || !isDirectoryAnswer(error)) throw error
    return { result: "service_bind_failed" }
  }

  let found: string[]
  try {
    const { searchEntries } = await client.search(input.searchBase, {
      scope: "sub",
      filter: renderFilter(input.userFilter, input.address),
      attributes: ["dn"],
      // One more than wanted, so "several" can be told from "one".
      sizeLimit: 2,
      derefAliases: "never",
    })
    found = searchEntries.map((e) => e.dn)
  } catch (error) {
    if (error instanceof SizeLimitExceededError)
      return { result: "user_not_found", detail: "ambiguous" }
    if (isDirectoryAnswer(error))
      return { result: "user_not_found", detail: "not_found" }
    throw error
  }
  if (found.length === 0) return { result: "user_not_found", detail: "not_found" }
  if (found.length > 1) return { result: "user_not_found", detail: "ambiguous" }
  if (input.password === undefined) return { result: "ok" }

  try {
    await client.bind(found[0]!, input.password)
  } catch (error) {
    if (isTlsFailure(error) || !isDirectoryAnswer(error)) throw error
    return { result: "user_bind_failed" }
  }
  return { result: "ok" }
}

/** The directory answered with a result code (ldapts's `ResultCodeError`s carry one). */
function isDirectoryAnswer(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === "number"
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown"
}
