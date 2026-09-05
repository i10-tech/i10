import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  type SESv2Client,
} from "@aws-sdk/client-sesv2"
import type { DomainStatus } from "@repo/contracts"

/**
 * The sending identity behind a domain.
 *
 * ⚠ A PORT, FOR THE SAME REASON `Metering` IS ONE: the store and the route are
 * the parts with the interesting decisions in them — the capacity check, the
 * verified gate, the idempotent create — and none of them should need AWS to be
 * tested. The SES adapter below is the only thing in this feature that cannot
 * be exercised without credentials.
 */
export interface DomainIdentity {
  /** Idempotent: creating one that exists returns its existing tokens. */
  create(input: {
    domain: string
    mailFrom: string
  }): Promise<{ dkimTokens: string[]; status: DomainStatus }>

  /** What the provider currently believes. */
  status(domain: string): Promise<{ dkimTokens: string[]; status: DomainStatus }>

  remove(domain: string): Promise<void>
}

/**
 * SES's DKIM vocabulary, mapped to ours.
 *
 * ⚠ `TEMPORARY_FAILURE` IS NOT `FAILED`, AND FLATTENING THEM IS A SUPPORT
 * TICKET. SES uses the first for a DNS lookup that failed in a way worth
 * retrying — a nameserver that timed out, propagation still in flight — and
 * telling that customer their records are wrong sends them to re-check DNS that
 * is already correct. `NOT_STARTED` is the third distinct one: the identity
 * exists but SES has not looked yet.
 */
const STATUS: Readonly<Record<string, DomainStatus>> = {
  NOT_STARTED: "not_started",
  PENDING: "pending",
  SUCCESS: "verified",
  FAILED: "failed",
  TEMPORARY_FAILURE: "temporary_failure",
}

const toStatus = (dkim: string | undefined): DomainStatus =>
  (dkim && STATUS[dkim]) || "pending"

export function sesIdentity(client: SESv2Client): DomainIdentity {
  async function read(domain: string) {
    const identity = await client.send(
      new GetEmailIdentityCommand({ EmailIdentity: domain }),
    )
    return {
      dkimTokens: identity.DkimAttributes?.Tokens ?? [],
      status: toStatus(identity.DkimAttributes?.Status),
    }
  }

  return {
    async create({ domain, mailFrom }) {
      try {
        await client.send(
          new CreateEmailIdentityCommand({
            EmailIdentity: domain,
            // Easy DKIM. Omitting `DkimSigningAttributes` is what selects it —
            // supplying a key would opt into BYODKIM and make us the holder of
            // a private key for every customer domain.
            DkimSigningAttributes: undefined,
          }),
        )
      } catch (error) {
        // ⚠ ALREADY EXISTS IS A SUCCESS, NOT AN ERROR, AND RE-CREATING WOULD BE
        // THE REAL FAILURE. A second `CreateEmailIdentity` mints DIFFERENT DKIM
        // tokens, so a customer who already published the first set would
        // silently stop verifying — with correct-looking records in their DNS.
        // Retries and double-clicks both land here.
        if ((error as { name?: string }).name !== "AlreadyExistsException") throw error
      }

      // ⚠ SET AFTER THE IDENTITY EXISTS, AND SEPARATELY, because SES has no way
      // to do both at once. `USE_DEFAULT_VALUE` means that if the MAIL FROM MX
      // is missing or broken, SES falls back to amazonses.com rather than
      // refusing the send — a deliverability cost rather than an outage.
      await client.send(
        new PutEmailIdentityMailFromAttributesCommand({
          EmailIdentity: domain,
          MailFromDomain: mailFrom,
          BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
        }),
      )

      return read(domain)
    },

    status: read,

    async remove(domain) {
      try {
        await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }))
      } catch (error) {
        // Already gone is the state we wanted.
        if ((error as { name?: string }).name !== "NotFoundException") throw error
      }
    },
  }
}
