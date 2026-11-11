import { createHmac } from "node:crypto"

/**
 * The Feedback-ID that lets Gmail complaints be attributed to a workspace.
 *
 * ⚠ GMAIL SENDS NO COMPLAINT EVENTS TO ANYBODY. The only per-sender view of its
 * spam reports is Google Postmaster Tools, whose Feedback Loop groups them by the
 * identifiers in a `Feedback-ID: a:b:c:SenderId` header, and only for traffic
 * DKIM-signed by a domain the sender verified there. This is where `a` comes
 * from. Sources: https://support.google.com/mail/answer/6254652 and
 * https://aws.amazon.com/blogs/messaging-and-targeting/understanding-google-postmaster-tools-spam-complaints-for-amazon-ses-email-senders/
 *
 * ⚠ THE TOKEN IS DERIVED, NOT STORED, AND NOT THE TENANT ID. Headers are public:
 * every recipient reads this one. The tenant UUID is internal, and the tenant
 * `slug` is worse - it comes from the workspace name and already appears in
 * dashboard links. So the identifier is an HMAC of the tenant id under a server
 * secret: stable for a tenant, different between tenants, opaque to a reader,
 * and recomputable from the tenant id alone, so there is no table and no
 * migration. Mapping a Postmaster row back to a workspace means computing the
 * token for each tenant and matching.
 *
 * ⚠ KEYED WITH `WEBHOOK_SECRET_KEY`, AND THAT KEY IS EFFECTIVELY PERMANENT. It
 * seals every webhook secret and DKIM private key, and `env.ts` already says
 * losing it is unrecoverable, so it is never rotated. Rotating it would still
 * orphan every Postmaster row recorded under the old tokens; if a rotation
 * scheme is ever built, this derivation has to be carried across it. The label
 * below keeps the HMAC input distinct from every other use of the key.
 *
 * ⚠ 16 HEX CHARACTERS, 64 BITS. Enough that two workspaces colliding is not a
 * real event, short enough to read in a dashboard, and inside the letters,
 * digits, underscore and dash that an SES message-tag value allows (256 chars
 * at most), with no colon to break the `a:b:c:SenderId` split.
 */

/** Maps a tenant id to its Feedback-ID token. Total: any string yields one. */
export type FeedbackTokens = (tenantId: string) => string

const LABEL = "i10/feedback-id/v1"

export function feedbackTokens(secret: string): FeedbackTokens {
  return (tenantId) =>
    createHmac("sha256", secret)
      .update(`${LABEL}:${tenantId}`)
      .digest("hex")
      .slice(0, 16)
}

/**
 * ⚠ GOOGLE REQUIRES `SenderId` (5 TO 15 CHARACTERS) AND IGNORES THE WHOLE
 * HEADER WITHOUT IT. It is ours on the direct route; on SES the fourth field is
 * always `AmazonSES` and cannot be overridden, so this is never used there.
 */
export const FEEDBACK_SENDER_ID = "i10mail"

/**
 * The complete header value for the direct route: `token:::i10mail`.
 *
 * ⚠ `b` AND `c` ARE EMPTY ON PURPOSE. Google aggregates each of the four fields
 * independently and says an empty field only skips that field's data, so the
 * workspace token in `a` still reports. Filling `b` or `c` with something
 * invented would create identifiers nobody asked for.
 */
export function feedbackIdHeaderValue(token: string): string {
  return `${token}:::${FEEDBACK_SENDER_ID}`
}

/** The SES message tag that SES folds into field `a` of its own Feedback-ID. */
export const SES_FEEDBACK_TAG = "ses:feedback-id-a"
