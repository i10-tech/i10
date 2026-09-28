import {
  DeleteSuppressedDestinationCommand,
  ListSuppressedDestinationsCommand,
  type SESv2Client,
} from "@aws-sdk/client-sesv2"

/**
 * A workspace's suppression list on SES's side (#159).
 *
 * ⚠ SES KEEPS ITS OWN COPY, AND IT IS THE ONE THAT DECIDES. Every tenant of ours
 * suppresses with `TENANT` scope (see `TENANT_SUPPRESSION`), so SES records the
 * same hard bounces and complaints we ingest into `core.suppressions` and
 * refuses to send to them. Removing an address from our list alone would let the
 * message past `accept()` only for SES to drop it as `OnTenantSuppressionList` -
 * which ingestion then records as a hard bounce, putting the row straight back.
 * A removal that cannot reach SES has not happened.
 *
 * ⚠ ONLY REMOVAL. Nothing here adds to SES's list: `accept()` already refuses a
 * suppressed address before SES sees it, and SES refuses
 * `PutSuppressedDestination` outright in the sandbox.
 *
 * ⚠ AND NEVER THE ACCOUNT LIST. That one is shared by every untenanted send, so
 * clearing an address from it on one workspace's say-so is the cross-tenant
 * decision #159 exists to stop making.
 */
export interface TenantSuppressions {
  /**
   * Takes `address` off `tenant`'s list. Succeeds when it is not there.
   *
   * `since` is when our own row was written - the earliest SES can have
   * recorded it - and narrows the search for a differently-cased copy.
   */
  release(tenant: string, address: string, since?: Date): Promise<void>
}

const isNamed = (error: unknown, name: string) =>
  (error as { name?: string }).name === name

/**
 * ⚠ A DAY OF SLACK BEFORE OUR ROW. SES records the bounce before the SNS
 * notification that makes us write the row, so its entry is always a little
 * OLDER than ours; the slack only has to cover that and a clock or two.
 */
const SLACK_MS = 24 * 60 * 60 * 1000

export function sesTenantSuppressions(client: SESv2Client): TenantSuppressions {
  async function remove(tenant: string, address: string): Promise<boolean> {
    try {
      await client.send(
        new DeleteSuppressedDestinationCommand({
          TenantName: tenant,
          EmailAddress: address,
        }),
      )
      return true
    } catch (error) {
      // ⚠ ONE ERROR FOR "NOT ON THE LIST" AND "NO SUCH TENANT", and both mean
      // there is nothing on SES's side stopping this address.
      if (isNamed(error, "NotFoundException")) return false
      throw error
    }
  }

  return {
    async release(tenant, address, since) {
      const wanted = address.trim().toLowerCase()
      if (await remove(tenant, wanted)) return

      /*
       * ⚠ SES STORES THE ADDRESS AS IT WAS SENT, AND MATCHES IT EXACTLY. We
       * lowercase on write, so `Bob@Acme.com` is ours as `bob@acme.com` and
       * SES's as `Bob@Acme.com`, and the delete above misses it. There is no
       * address filter on the listing, so the window since our row was written
       * is what keeps this from reading a workspace's whole list.
       */
      if (!since) return
      const variants = new Set<string>()
      let token: string | undefined
      try {
        do {
          const page = await client.send(
            new ListSuppressedDestinationsCommand({
              TenantName: tenant,
              StartDate: new Date(since.getTime() - SLACK_MS),
              EndDate: new Date(),
              PageSize: 1000,
              NextToken: token,
            }),
          )
          for (const s of page.SuppressedDestinationSummaries ?? []) {
            const found = s.EmailAddress
            if (found && found !== wanted && found.toLowerCase() === wanted) {
              variants.add(found)
            }
          }
          token = page.NextToken
        } while (token)
      } catch (error) {
        if (isNamed(error, "NotFoundException")) return
        throw error
      }
      for (const variant of variants) await remove(tenant, variant)
    },
  }
}

/** For a deployment with SES off: there is no list on the other side. */
export const offlineTenantSuppressions = (): TenantSuppressions => ({
  async release() {},
})
