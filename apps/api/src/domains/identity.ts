import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityDkimSigningAttributesCommand,
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
  /**
   * Registers the domain and the key WE generated. Idempotent.
   *
   * ⚠ IT TAKES A KEYPAIR RATHER THAN RETURNING ONE, WHICH IS THE WHOLE POINT OF
   * BYODKIM. The provider is told which key to sign with; it does not choose.
   * That is what lets a second sender — our own MTA — sign identically.
   */
  create(input: {
    domain: string
    mailFrom: string
    selector: string
    /** base64 PKCS#8 DER. */
    privateKey: string
  }): Promise<{ status: DomainStatus }>

  /** What the provider currently believes. */
  status(domain: string): Promise<{ status: DomainStatus }>

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
    return { status: toStatus(identity.DkimAttributes?.Status) }
  }

  return {
    async create({ domain, mailFrom, selector, privateKey }) {
      const signing = {
        DomainSigningSelector: selector,
        DomainSigningPrivateKey: privateKey,
      }

      try {
        await client.send(
          new CreateEmailIdentityCommand({
            EmailIdentity: domain,
            // ⚠ SUPPLYING THESE IS WHAT SELECTS BYODKIM. Omitting them opts
            // into Easy DKIM, where Amazon generates the pair and keeps the
            // private half — after which only Amazon can sign for this domain
            // and routing a message through our own MTA becomes impossible.
            DkimSigningAttributes: signing,
          }),
        )
      } catch (error) {
        if ((error as { name?: string }).name !== "AlreadyExistsException") throw error

        // ⚠ ALREADY EXISTS MEANS RE-ASSERT THE KEY, NOT SHRUG. With Easy DKIM
        // there was nothing to do here; with BYODKIM the existing identity may
        // be signing with an older key — a re-created domain, a rotation that
        // half-applied — and leaving it would mean SES signs with a key the
        // customer's DNS no longer publishes. Every signature then fails and
        // the records look correct.
        await client.send(
          new PutEmailIdentityDkimSigningAttributesCommand({
            EmailIdentity: domain,
            SigningAttributesOrigin: "EXTERNAL",
            SigningAttributes: signing,
          }),
        )
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
