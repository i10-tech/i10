import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
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

  /**
   * Every DOMAIN identity the account holds, oldest first is not promised.
   *
   * ⚠ IT EXISTS BECAUSE NOTHING COULD ANSWER "WHAT IS IN SES THAT SHOULD NOT
   * BE". Every other call here is keyed on a domain we already have a row for,
   * so an identity whose row is gone is unreachable through all of them — and
   * identities whose row is gone are exactly what a delete that silently failed
   * leaves behind. For most of this product's life `DeleteEmailIdentity` was
   * missing from the IAM policy, so EVERY delete failed that way.
   *
   * ⚠ DOMAINS ONLY, NEVER EMAIL ADDRESSES. The account also holds verified
   * sender addresses — people's own mailboxes, created by hand in the AWS
   * console — which no row in this database has ever described and which
   * nothing here may reason about, let alone remove.
   */
  list(): Promise<string[]>

  /**
   * How an identity is signed, so we can tell OURS from somebody's hand-made one.
   *
   * ⚠ "NO ROW POINTS AT IT" IS NOT ENOUGH TO DELETE SOMETHING, and this is the
   * second half of the proof. The AWS account is not ours alone in practice —
   * identities get created by hand in the console, for a test, for a one-off
   * send — and an orphan sweep that reasoned only from our own database would
   * delete every one of them the first time it ran. That is unrecoverable and
   * would be entirely our fault.
   *
   * ⚠ BYODKIM IS THE SIGNATURE. Our `create` always supplies
   * `DkimSigningAttributes`, which sets the origin to `EXTERNAL` and makes the
   * token our own generated selector — `i10` followed by twelve hex characters,
   * see `generateSelector`. An Easy DKIM identity, which is what the console
   * makes by default, has origin `AWS_SES` and three CNAME tokens that look
   * nothing like that. So the pair is a positive statement that this code
   * created the identity, rather than an absence of evidence that anything else
   * did.
   */
  signature(domain: string): Promise<{ origin: string | null; tokens: string[] }>

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

/** The slice of the logger this adapter uses. Structurally satisfied by pino. */
export interface IdentityLogger {
  info: (o: object, m: string) => void
}

export interface SesIdentityOptions {
  /** Given one, every status read writes down what SES ACTUALLY said. */
  log?: IdentityLogger
  /**
   * The region this client talks to, for the log line only.
   *
   * ⚠ IT IS HERE BECAUSE A REGION MISMATCH EXPLAINS THIS FEATURE'S TWO MOST
   * CONFUSING SYMPTOMS AT ONCE, and nothing in the product could say which
   * region it had asked. An identity lives in ONE region: if the API talks to
   * `eu-central-1` while somebody reads the console in `us-east-1`, then the
   * verified domain they can see is not the one we registered. Verify reports
   * `pending` — correctly, about a real and genuinely pending identity — and
   * deleting the domain removes an identity that is not the one still sitting
   * in the console they are looking at. Both read as "the product is broken"
   * and neither is a bug in it.
   */
  region?: string
}

export function sesIdentity(
  client: SESv2Client,
  options: SesIdentityOptions = {},
): DomainIdentity {
  const { log, region } = options
  /**
   * ⚠ "NO SUCH IDENTITY" IS AN ANSWER, NOT A FAILURE, AND LETTING IT THROW WAS
   * A 500 ON THE ONE BUTTON THIS FEATURE HAS. `GetEmailIdentity` raises
   * `NotFoundException` for a name SES has never been told about, which is the
   * ordinary state of every domain until `create` succeeds — and there are two
   * ways to reach this call without that having happened. `registerIdentity`
   * returns early for a row with no selector or no sealed key, and `refresh`
   * asks about any domain past `not_started` without registering anything. Both
   * then hit an uncaught exception, the API answered "Something went wrong.",
   * and the console said "Could not check the records" for ever — about a
   * domain whose DNS was perfect and whose records it had already published.
   *
   * ⚠ IT MAPS TO `not_started`, WHICH IS EXACTLY WHAT IT MEANS. SES's own
   * vocabulary has a word for "the identity exists and I have not looked yet";
   * this is one step before that, and the customer-facing consequence is
   * identical — nothing has been confirmed, and the next verify is what starts
   * it. Reporting `failed` would send somebody to fix DNS that is correct.
   */
  /**
   * The identity as SES holds it, or `null` when there is none.
   *
   * ⚠ ONE PLACE THAT SWALLOWS `NotFoundException`, because two callers need it
   * and they want opposite things from it — `read` turns it into a status,
   * `create` treats it as "nothing to compare against". Duplicating the catch
   * is how one of them ends up throwing on the ordinary case.
   */
  async function describe(domain: string) {
    try {
      return await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }))
    } catch (error) {
      if ((error as { name?: string }).name !== "NotFoundException") throw error
      return null
    }
  }

  async function read(domain: string) {
    const identity = await describe(domain)
    if (identity === null) return { status: "not_started" as const }
    {
      /*
       * ⚠ WHAT SES SAID, NOT WHAT WE MADE OF IT, AND THE DIFFERENCE IS THE
       * ONLY THING THAT CAN SETTLE "THE CONSOLE SAYS VERIFIED AND YOU SAY
       * PENDING". Three separate facts can each produce that sentence and they
       * have three different fixes: DKIM genuinely still pending, an identity
       * verified for sending by some other means while DKIM has not landed, or
       * this client talking to a DIFFERENT REGION from the console somebody is
       * looking at. Mapping to one word first and logging nothing left no way
       * to tell them apart except guessing.
       *
       * ⚠ `info`, AND ONLY ON A READ. This is one line per verify press and
       * per sweep tick, carries no customer content beyond a domain name we
       * already log everywhere, and is the difference between a five-minute
       * answer and another round trip through somebody's AWS console.
       */
      log?.info(
        {
          domain,
          region: region ?? null,
          dkim: identity.DkimAttributes?.Status ?? null,
          dkimOrigin: identity.DkimAttributes?.SigningAttributesOrigin ?? null,
          verifiedForSending: identity.VerifiedForSendingStatus ?? null,
          mailFrom: identity.MailFromAttributes?.MailFromDomainStatus ?? null,
        },
        "ses identity status",
      )

      return { status: toStatus(identity.DkimAttributes?.Status) }
    }
  }

  return {
    async create({ domain, mailFrom, selector, privateKey }) {
      const signing = {
        DomainSigningSelector: selector,
        DomainSigningPrivateKey: privateKey,
      }

      /*
       * ⚠ COMPARE BEFORE WRITING, BECAUSE RE-ASSERTING UN-VERIFIES A VERIFIED
       * DOMAIN. `PutEmailIdentityDkimSigningAttributes` does not mean "confirm
       * this key"; it means "here is a new signing configuration", and SES
       * answers by throwing away the result of its DKIM check and starting
       * again — `SUCCESS` drops to `PENDING` and `VerifiedForSendingStatus`
       * goes false. `PutEmailIdentityMailFromAttributes` does the same to MAIL
       * FROM.
       *
       * ⚠ AND THE SEND GATE READS THAT. So pressing Verify on a domain that was
       * already working took it OUT of service for as long as Amazon took to
       * re-check — observed in production: verified, pressed, pending, back to
       * verified minutes later. A button that causes a sending outage.
       *
       * ⚠ WHAT IS NOT SAFE IS SKIPPING UNCONDITIONALLY. Re-asserting is
       * genuinely correct when the identity carries somebody ELSE'S key: a
       * domain that changed hands, or a rotation that half-applied, where
       * leaving it means SES signs with a key the customer's DNS no longer
       * publishes and every signature fails while the records look right. So
       * the test is not "does an identity exist" but "does it already carry
       * THIS ROW'S selector" — which is exactly the case where the write would
       * change nothing and cost a verification.
       */
      const current = await describe(domain)
      const keyIsAlreadyOurs =
        current?.DkimAttributes?.SigningAttributesOrigin === "EXTERNAL" &&
        (current.DkimAttributes?.Tokens ?? []).includes(selector)
      const mailFromIsAlreadySet =
        current?.MailFromAttributes?.MailFromDomain === mailFrom

      if (keyIsAlreadyOurs && mailFromIsAlreadySet) {
        log?.info(
          { domain, region: region ?? null, selector },
          "ses identity already carries this key and return path — left alone",
        )
        return { status: toStatus(current?.DkimAttributes?.Status) }
      }

      if (keyIsAlreadyOurs) {
        /*
         * ⚠ ONLY THE RETURN PATH MOVED, so only that is written. Re-asserting
         * the key here would reset a DKIM verification that is already correct
         * for a change that has nothing to do with it.
         */
        await client.send(
          new PutEmailIdentityMailFromAttributesCommand({
            EmailIdentity: domain,
            MailFromDomain: mailFrom,
            BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
          }),
        )
        return read(domain)
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

    async list() {
      const names: string[] = []
      let token: string | undefined

      /*
       * ⚠ PAGED, BECAUSE THE DEFAULT PAGE IS NOT THE WHOLE ACCOUNT. Reading one
       * page and treating it as the full set would be harmless for the report
       * and actively wrong for the sweep that consumes it — a second page is
       * simply invisible, so those identities are never found and never
       * cleaned up, for ever, with nothing to indicate they were missed.
       */
      do {
        const page = await client.send(
          new ListEmailIdentitiesCommand({ NextToken: token, PageSize: 1000 }),
        )

        for (const identity of page.EmailIdentities ?? []) {
          // ⚠ DOMAINS ONLY. See the note on the port: the account also holds
          // verified sender ADDRESSES that this database has never described.
          if (identity.IdentityType !== "DOMAIN") continue
          if (identity.IdentityName) names.push(identity.IdentityName)
        }

        token = page.NextToken
      } while (token)

      return names
    },

    async signature(domain) {
      try {
        const identity = await client.send(
          new GetEmailIdentityCommand({ EmailIdentity: domain }),
        )
        return {
          origin: identity.DkimAttributes?.SigningAttributesOrigin ?? null,
          tokens: identity.DkimAttributes?.Tokens ?? [],
        }
      } catch (error) {
        // ⚠ GONE IS NOT OURS. An identity that vanished between the listing and
        // this read needs no decision made about it.
        if ((error as { name?: string }).name !== "NotFoundException") throw error
        return { origin: null, tokens: [] }
      }
    },

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

/**
 * A domain identity for a deployment that is not talking to SES.
 *
 * ⚠ IT EXISTS BECAUSE `SES_ENABLED=false` DID NOT MEAN WHAT IT SAYS. The flag
 * gated SENDING, and the SES client was wired unconditionally — so adding a
 * domain on a laptop pointed at the production AWS credentials called
 * `CreateEmailIdentity` against the real account. The database is isolated
 * locally and the mail server is absent, but this one call reached straight
 * through into production and left an identity there for `test.example.com`:
 * invisible, billable, and indistinguishable from a real customer's.
 *
 * ⚠ IT REPORTS `pending`, NOT `verified`, AND THE DIFFERENCE IS THE WHOLE
 * VALUE. A stub that claimed verification would let local work pass through
 * every gate that exists to stop unverified mail, and the first place that
 * assumption would be tested is production. Pending is honest: the domain was
 * created, the zone was published, and nothing has confirmed anything — which
 * is exactly the state a real domain is in before its records resolve.
 *
 * ⚠ AND IT IS NOT A TEST DOUBLE. Tests construct their own; this is a
 * production code path for a deployment configured without SES, chosen at
 * startup by the same flag the send path reads.
 */
export function offlineIdentity(): DomainIdentity {
  return {
    async create() {
      return { status: "pending" }
    },
    async status() {
      return { status: "pending" }
    },
    // ⚠ EMPTY, NOT A THROW. A deployment without SES has no identities, which
    // is an answer — and the orphan sweep asking it should find nothing to do
    // rather than fail its whole pass.
    async list() {
      return []
    },
    // ⚠ NOTHING IS OURS WHEN THERE IS NO PROVIDER, which makes the orphan sweep
    // refuse to remove anything rather than reason from an empty answer.
    async signature() {
      return { origin: null, tokens: [] }
    },
    async remove() {},
  }
}
