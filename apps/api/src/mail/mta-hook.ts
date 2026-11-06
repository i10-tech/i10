import { domainOf } from "../send/address.js"
import { admitSend, type AdmitDeps, type Refusal } from "../send/admit.js"

/**
 * Mailbox sends, held to the same limits as API sends.
 *
 * Stalwart consults an MtaHook during an authenticated submission (port 465)
 * and POSTs the session here. We answer with `admitSend`, the decision
 * `acceptSend` makes for an API send: the risk hold, the plan, and the free
 * tier's monthly line.
 *
 * ⚠ THE WIRE SHAPE IS FROM THE DOCS, NOT FROM A PROBE. Request and response are
 * as https://stalw.art/docs/mta/filter/mtahooks/ describes them for Stalwart
 * 1.0 (read 2026-11-06); nothing here has been seen against our server.
 * `parseHookRequest` is the only function that reads the request's shape, so a
 * difference found in a probe is a change in one place.
 *
 * ⚠ THERE IS NO TEMPFAIL ACTION. The response vocabulary is accept, reject,
 * discard and quarantine. A 4xx is therefore never an answer we give: it is what
 * Stalwart does when this endpoint fails (`tempFailOnError`, 451 4.3.5), which
 * is why every error path here is a non-2xx status and not a JSON body. See the
 * README, "The MTA hook".
 *
 * ⚠ ONLY A SENDER WE CAN PLACE IS LIMITED. The tenant is whoever owns the
 * sender's mailbox domain, the key `core.mailbox_route` already uses. i10's own
 * addresses have no owner (`authd.accounts.tenant_id` is null for them), so they
 * pass untouched. That relies on `MtaStageAuth.mustMatchSender`, which defaults
 * to true and which our plan does not override: an authenticated session can
 * only send as one of its own addresses, so it cannot pick a domain to dodge a
 * hold.
 */

/** What the hook reads out of Stalwart's request. */
export interface HookRequest {
  /** The authenticated account; null when the client has not authenticated. */
  login: string | null
  /** The envelope sender, as the client gave it; null before MAIL FROM. */
  sender: string | null
}

export type HookResponse =
  | { action: "accept" }
  | {
      action: "reject"
      response: { status: number; enhanced_status: string; message: string }
    }

/**
 * ⚠ THE ONLY PLACE THE REQUEST'S SHAPE IS READ. `context.sasl.login` is present
 * only after AUTH; `envelope.from.address` from MAIL FROM on. Both are optional
 * on the wire, and an empty sender (`<>`) is a legitimate null reverse path, so
 * absence is a value here and not an error. Null is "this is not a body from
 * Stalwart".
 */
export function parseHookRequest(body: unknown): HookRequest | null {
  if (!isRecord(body) || !isRecord(body.context)) return null
  const { sasl } = body.context
  const from = isRecord(body.envelope) ? body.envelope.from : undefined
  const login = isRecord(sasl) && typeof sasl.login === "string" ? sasl.login : null
  const sender =
    isRecord(from) && typeof from.address === "string" && from.address !== ""
      ? from.address
      : null
  return { login: login === "" ? null : login, sender }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface HookDeps {
  /** The tenant that owns this mailbox domain, or null. `core.mailbox_domains()`. */
  domainOwner: (domain: string) => Promise<string | null>
  admit: AdmitDeps
}

const ACCEPT: HookResponse = { action: "accept" }

/**
 * ⚠ 5xx, NOT 4xx, FOR BOTH REFUSALS, as the API's 403 and 429 are not retryable
 * either: a hold lifts with a person's review and an allowance with the period,
 * and a mail client retrying a 4xx would sit on the message for days instead of
 * telling the sender now. The text is the API's, single-line.
 */
const rejection = (refusal: Refusal): HookResponse => ({
  action: "reject",
  response: {
    status: 550,
    enhanced_status: refusal.status === "held" ? "5.7.1" : "5.4.5",
    message: refusal.message,
  },
})

/**
 * Accept or refuse one consultation. Throws when the decision cannot be made;
 * the route turns that into a tempfail.
 *
 * ⚠ THE WORKSPACE COMES FROM THE LOGIN, NOT THE ENVELOPE SENDER. A signed-in
 * user can send `MAIL FROM:<>`, and placing by the sender alone would wave that
 * message through every check. Logins are mailbox addresses (the directory's
 * `filterLogin` matches `mail`), so the login's domain is the workspace; the
 * sender is only the fallback for a login that is not an address.
 *
 * ⚠ STAGE-AGNOSTIC ON PURPOSE. Whatever stage Stalwart consults us at, the
 * question is the same - may this workspace send one message - so changing
 * `stages` in the plan can never switch the check off.
 *
 * ⚠ THE COUNT IS ONE MESSAGE, HOWEVER MANY RECIPIENTS. That is how `acceptSend`
 * counts (per payload), and what the H1 throttles count too. The hook is
 * consulted once per RCPT TO, so it asks again for each recipient; the answer
 * does not depend on the recipient and nothing is recorded, so repeating it is
 * harmless.
 */
export async function decideHook(
  request: HookRequest,
  deps: HookDeps,
): Promise<HookResponse> {
  // Not a submission. The plan's `enable` expression keeps these away; this is
  // the second lock.
  if (request.login === null) return ACCEPT

  const domain =
    domainOf(request.login) ??
    (request.sender === null ? null : domainOf(request.sender))
  const tenantId = domain === null ? null : await deps.domainOwner(domain)
  if (tenantId === null) return ACCEPT

  const refusal = await admitSend(tenantId, 1, deps.admit, "mailbox")
  return refusal ? rejection(refusal) : ACCEPT
}
