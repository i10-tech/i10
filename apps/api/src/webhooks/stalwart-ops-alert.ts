import type { AuthEmailSender } from "../auth-email/deliver.js"
import type { Logger } from "./events.js"
import type { OperatorAlertType, StalwartOperatorAlert } from "./stalwart.js"

/**
 * Telling the operator that Stalwart's encryption is faulting.
 *
 * ⚠ THE LOG LINE IS THE ALERT AND THE EMAIL IS A CONVENIENCE. Nothing in the
 * cluster scrapes Stalwart's metrics, so these four events are the only way a
 * bad blob key, a failed decryption, a bounced encrypted message or a changed
 * correspondent key is ever noticed. The line is always written; the email goes
 * out only when `OPS_ALERT_EMAIL` is set and a system sender exists.
 *
 * ⚠ NOTHING HERE MAY THROW. The route answers 500 to make Stalwart redeliver a
 * batch, and a send failure on an alert is not a reason to replay every mail
 * event that came with it. A failed send is logged and that is all.
 *
 * ⚠ ONE EMAIL PER TYPE PER HOUR. A broken key makes every read fail, so the
 * events arrive in thousands, from both nodes. The idempotency key is the type
 * and the UTC hour; a process also remembers the keys it has used, because the
 * send path refuses a repeated key (`replayed` or `conflict`), which
 * `authEmailSender` throws.
 */

export interface OpsAlertMail {
  /** `OPS_ALERT_EMAIL`. */
  to: string
  sender: AuthEmailSender
}

const ACTIONS: Record<OperatorAlertType, string> = {
  "store.decrypt-error":
    "A stored blob could not be decrypted. Check STALWART_BLOB_KEY in Doppler " +
    "prod_stalwart against the key fingerprint recorded in " +
    "infra/k8s/i10/stalwart/config/README.md (Blob encryption). Do not rotate " +
    "or delete any key.",
  "store.crypto-error":
    "An encryption or decryption operation on stored data failed. Check " +
    "STALWART_BLOB_KEY in Doppler prod_stalwart against the key fingerprint " +
    "recorded in infra/k8s/i10/stalwart/config/README.md (Blob encryption). " +
    "Do not rotate or delete any key.",
  "encryption.gateway-bounced":
    "The encryption gateway rejected a recipient. Check that recipient's key " +
    "and the Encryption gatewayOutbound policy; the reason is below when " +
    "Stalwart gave one.",
  "encryption.key-change":
    "A correspondent's key changed and the new one waits for approval; the old " +
    "key stays in use. Confirm the new key with the recipient, then approve or " +
    "reject it with x:ExternalPublicKey/set over JMAP (status active to " +
    "approve, rejected to refuse).",
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function messageFor(alert: StalwartOperatorAlert) {
  const lines = [
    `Stalwart reported ${alert.type} at ${alert.occurredAt.toISOString()}.`,
    ACTIONS[alert.type],
  ]
  if (alert.keyId) lines.push(`Key id: ${alert.keyId}`)
  if (alert.cipher) lines.push(`Cipher: ${alert.cipher}`)
  if (alert.recipientDomain) lines.push(`Recipient domain: ${alert.recipientDomain}`)
  if (alert.reason) lines.push(`Reason: ${alert.reason}`)
  return {
    subject: `[i10 ops] Stalwart ${alert.type}`,
    text: lines.join("\n\n"),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
  }
}

export const alertKey = (alert: StalwartOperatorAlert) =>
  `stalwart-alert:${alert.type}:${alert.occurredAt.toISOString().slice(0, 13)}`

export function operatorAlerts(log: Logger, mail?: OpsAlertMail) {
  const sent = new Set<string>()

  return async function raise(alert: StalwartOperatorAlert): Promise<void> {
    log.error(
      {
        event: alert.type,
        keyId: alert.keyId,
        cipher: alert.cipher,
        recipientDomain: alert.recipientDomain,
        reason: alert.reason,
        at: alert.occurredAt.toISOString(),
      },
      "Stalwart encryption alert",
    )
    if (!mail) return

    const key = alertKey(alert)
    if (sent.has(key)) return
    // Marked before the send and kept on failure: a down mail path would
    // otherwise retry on every event of a burst. The log line above remains.
    sent.add(key)
    // Bounded: one key per type per hour, so this only grows by four a hour.
    if (sent.size > 512) sent.delete(sent.values().next().value as string)

    try {
      await mail.sender.send({ to: mail.to, ...messageFor(alert), idempotencyKey: key })
    } catch (err) {
      // ⚠ ANOTHER PROCESS ALREADY SENT THIS HOUR'S ALERT, WHICH IS NOT A FAULT.
      // The send path answers a key it has seen with `replayed` when the body is
      // identical and `conflict` when it differs, and a second event of the
      // same type carries another time and reason, so `conflict` is the usual
      // one. `authEmailSender` throws both as "...: <status>".
      if (/: (replayed|conflict)$/.test(String(err))) return
      log.error({ err, event: alert.type }, "could not email the Stalwart alert")
    }
  }
}
