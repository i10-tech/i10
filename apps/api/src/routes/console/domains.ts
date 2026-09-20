import type { Hono } from "hono"
import { requireFreshAuth } from "../../middleware/session.js"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"

/**
 * Sending domains, and the live DNS behind them.
 *
 * ⚠ EVERY WRITE GOES THROUGH `DomainStore`, WHICH IS THE ONLY PLACE A PLAN'S
 * DOMAIN LIMIT IS ENFORCED. A console path that wrote `core.domains` itself
 * would be a second implementation of that limit, and the console is exactly
 * where somebody would notice it was missing last.
 */
export function mountDomains(app: Hono, d: ConsoleDeps): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Domains
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/domains", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.domains.list(tenantId) })
  })

  app.post("/domains", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)

    const name = typeof body?.name === "string" ? body.name : ""
    if (!name) return c.json(validation("`name` is required."), 422)

    const created = await d.domains.create(tenantId, {
      name,
      ...(typeof body?.custom_return_path === "string"
        ? { custom_return_path: body.custom_return_path }
        : {}),
      ...(typeof body?.delegated === "boolean" ? { delegated: body.delegated } : {}),
    })

    switch (created.status) {
      case "created":
        return c.json(created.domain, 201)
      case "rejected":
        return c.json(validation(created.reason), 422)
      case "conflict":
        return c.json(
          {
            statusCode: 409,
            name: "domain_already_exists" as const,
            message: created.reason,
          },
          409,
        )
      default:
        // ⚠ 403 AND A MACHINE-READABLE NAME, BECAUSE THE CONSOLE TURNS THIS ONE
        // INTO AN UPGRADE PROMPT RATHER THAN AN ERROR TOAST. A plan limit is the
        // one refusal on this surface that has a button attached to it.
        return c.json(
          {
            statusCode: 403,
            name: "plan_limit_exceeded" as const,
            message: created.reason,
          },
          403,
        )
    }
  })

  app.get("/domains/:id", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const domain = await d.domains.get(tenantId, c.req.param("id"))
    return domain ? c.json(domain) : c.json(notFound("No domain with that id."), 404)
  })

  app.post("/domains/:id/verify", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const outcome = await d.domains.verify(tenantId, c.req.param("id"))

    switch (outcome.status) {
      /*
       * ⚠ 200, NOT AN ERROR. The challenge record simply is not published yet,
       * which is the ordinary state of every delegated domain between being added
       * and being set up — the same state a manual domain is in before its six
       * records resolve, which also answers 200. The domain comes back carrying
       * its record list, where the outstanding `Ownership` row is the signal.
       */

      /*
       * ⚠ `ownership` IS THE ANSWER THIS ROUTE USED TO THROW AWAY, AND ITS
       * ABSENCE WAS MOST OF "I PUBLISHED THE RECORDS AND NOTHING HAPPENS".
       * `verify` distinguishes three outcomes that matter to the person
       * pressing the button — we proved the domain, we asked and the records
       * were not there, we could not ask at all — and all three arrived at the
       * console as the same unchanged domain row. The console then read
       * `status`, which is SES's opinion, and said "the records have not
       * propagated" to somebody whose records were fine and whose nameservers
       * had simply timed out, and the same sentence again to somebody whose
       * DNS half was finished and who was only waiting on Amazon.
       *
       * ⚠ AND IT IS A SIBLING OF THE DOMAIN RATHER THAN A FIELD ON IT. Whether
       * we could read DNS a second ago is not a property of the domain; it is
       * the result of this call, it is not stored, and putting it on the row
       * would imply a durability it does not have.
       */
      case "ok":
        return c.json({ ...outcome.domain, ownership: { proven: true } })
      case "unproven":
        return c.json({
          ...outcome.domain,
          ownership: { proven: false, reason: outcome.reason },
        })
      case "missing":
        return c.json(notFound("No domain with that id."), 404)
      default:
        /*
         * ⚠ 409, NOT 403 AND NOT A `failed` DOMAIN. Their records may well be
         * perfect — they lost a race to prove ownership, which is a conflict
         * over a name rather than a problem with their DNS or their permission.
         */
        return c.json(
          {
            statusCode: 409,
            name: "domain_already_claimed" as const,
            message:
              `${outcome.domain.name} has just been verified by another ` +
              `workspace, so it cannot be verified here as well. If that is ` +
              `also yours, remove it there; otherwise contact support@i10.tech.`,
          },
          409,
        )
    }
  })

  /**
   * The same answer as `verify`, cheap enough to ask repeatedly.
   *
   * ⚠ THIS IS WHAT THE CONSOLE POLLS WHILE SOMEBODY WATCHES, AND IT EXISTS SO
   * THAT NOBODY HAS TO PRESS ANYTHING. Publishing records takes seconds and
   * Amazon's verification takes as long as it takes; between those two facts
   * sat a person refreshing a page. The console now asks this every few
   * seconds until the badge turns green.
   *
   * ⚠ IT IS A POST BECAUSE IT WRITES, even though it reads like a GET. What it
   * writes is SES's current opinion and the check timestamp — see the note on
   * `DomainStore.refresh` for what it deliberately does NOT do, which is
   * everything expensive or consequential in `verify`.
   */
  app.post("/domains/:id/refresh", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const outcome = await d.domains.refresh(tenantId, c.req.param("id"))

    switch (outcome.status) {
      case "ok":
        return c.json(outcome.domain)
      /*
       * ⚠ 200 AND THE DOMAIN, NOT AN ERROR. "Nothing has been registered yet"
       * is the ordinary state of a domain whose records are still being
       * published, which is precisely when something is polling — answering
       * 409 would turn the normal case into an error in somebody's console.
       */
      case "not_registered":
        return c.json(outcome.domain)
      default:
        return c.json(notFound("No domain with that id."), 404)
    }
  })

  /**
   * Why a delegated domain has not verified.
   *
   * ⚠ SEPARATE FROM `verify`, AND DELIBERATELY NOT FOLDED INTO IT. Verifying is
   * a write that asks SES and stores the answer; this is a read that asks
   * public DNS and stores nothing. Merging them would put three DNS lookups on
   * the path of a button somebody presses repeatedly, and would make a slow
   * resolver look like a failed verification.
   *
   * ⚠ IT IS ONLY MEANINGFUL FOR A DELEGATED DOMAIN. A manual one publishes six
   * records into its own zone and there is no delegation to diagnose — the
   * record-by-record status the domain already carries is the better answer
   * there.
   */
  app.get("/domains/:id/delegation", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    if (!d.delegation) return c.json(notWired("Delegation checks"), 501)

    const { tenantId } = c.get("auth")
    const domain = await d.domains.get(tenantId, c.req.param("id"))
    if (!domain) return c.json(notFound("No domain with that id."), 404)

    if (!domain.delegated) {
      return c.json(
        validation("That domain publishes its own records; there is no delegation."),
        422,
      )
    }

    /*
     * ⚠ THE NAMES COME OFF THE DOMAIN'S OWN RECORD LIST, which is the list the
     * customer is looking at three inches below this note. Per-claim
     * delegation gives every domain its own nameserver hostnames, so checking
     * against the deployment's `MAIL_NAMESERVERS` — which is what this did —
     * told a customer who had published exactly what we asked for that their
     * records pointed at somebody else, and named our own nameserver as the
     * somebody else.
     */
    const expected = domain.records.filter((r) => r.type === "NS").map((r) => r.value)

    try {
      return c.json(await d.delegation.check(domain.name, expected))
    } catch (error) {
      // ⚠ A FAILED DIAGNOSIS IS NOT A FAILED PAGE. This is advisory; answering
      // 502 would replace a domain's records with a red box because a resolver
      // was slow.
      d.log.warn({ err: String(error), domain: domain.name }, "delegation check failed")
      return c.json(
        {
          domain: domain.name,
          nameservers: [],
          nameserversAnswering: true,
          zones: [],
          error: "check_failed",
        },
        200,
      )
    }
  })

  /**
   * Publishes this domain's records into the customer's own DNS, for them.
   *
   * ⚠ THE ANSWER TO "WHY AM I STILL TYPING SIX RECORDS". Where we hold a
   * credential for the provider that hosts the domain, nothing needs typing at
   * all — the same records the table below shows are written directly.
   *
   * ⚠ IT REFUSES BEFORE IT DESTROYS, AND THE FIRST CALL IS ALWAYS A DRY RUN
   * WHERE ANYTHING WOULD BE REMOVED. A domain that already has DMARC configured
   * has a TXT record at precisely the name delegation takes over; deleting it is
   * usually right and never ours to decide silently. 409 with the list, the
   * console asks, and the second call carries `replace_conflicts`.
   */
  app.post("/domains/:id/publish", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    if (!d.dnsPublisher) return c.json(notWired("DNS publishing"), 501)

    const { tenantId } = c.get("auth")
    const domain = await d.domains.get(tenantId, c.req.param("id"))
    if (!domain) return c.json(notFound("No domain with that id."), 404)

    const body = await readJson(c)
    const provider = typeof body?.provider === "string" ? body.provider : ""
    if (!provider) return c.json(validation("`provider` is required."), 422)

    const result = await d.dnsPublisher.publish({
      tenantId,
      provider,
      domain,
      replaceConflicts: body?.replace_conflicts === true,
    })

    switch (result.status) {
      case "published":
        return c.json({ status: "published", ...result.outcome })

      case "needs_confirmation":
        // ⚠ 409, AND NOTHING HAS BEEN WRITTEN. The zone is exactly as it was.
        return c.json(
          {
            statusCode: 409,
            name: "validation_error" as const,
            message:
              "Publishing these records means removing records that already " +
              "exist at the same names. Confirm to continue.",
            conflicts: result.conflicts,
          },
          409,
        )

      case "not_connected":
        return c.json(validation(`This workspace has no ${provider} connection.`), 422)

      case "zone_not_found":
        return c.json(
          validation(
            `That connection cannot see a zone for ${domain.name}. ` +
              `It reaches: ${result.zones.join(", ") || "no zones"}.`,
          ),
          422,
        )

      case "unsupported":
        return c.json(validation(`We cannot publish records at ${provider} yet.`), 422)

      default:
        /*
         * ⚠ `unauthorized` IS A 409, NOT A 502, BECAUSE THE REMEDY IS THEIRS.
         * A revoked or expired grant will fail identically for ever; telling
         * somebody the provider is having trouble sends them to wait instead of
         * to reconnect.
         */
        return c.json(
          {
            statusCode: result.kind === "unauthorized" ? 409 : 502,
            name:
              result.kind === "unauthorized"
                ? ("invalid_access" as const)
                : ("internal_server_error" as const),
            message:
              result.kind === "unauthorized"
                ? `Your ${provider} connection is no longer valid. Reconnect it and try again.`
                : `${provider} refused the change: ${result.reason}`,
          },
          result.kind === "unauthorized" ? 409 : 502,
        )
    }
  })

  /*
   * ⚠ STEP-UP. A deleted domain stops every message the workspace sends from
   * it, and re-adding one means re-proving ownership and re-publishing DNS —
   * so this is the most expensive thing a stolen session could do here. See
   * `requireFreshAuth`.
   */
  app.delete("/domains/:id", requireFreshAuth, async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const removed = await d.domains.remove(tenantId, c.req.param("id"))
    return removed
      ? c.json({ object: "domain", id: c.req.param("id"), deleted: true })
      : c.json(notFound("No domain with that id."), 404)
  })

  /**
   * Live DNS for a domain: who hosts it, and what we can currently see.
   *
   * ⚠ IT TAKES A NAME RATHER THAN AN ID, BECAUSE IT IS USED *BEFORE* THE DOMAIN
   * EXISTS. The onboarding flow asks "who is your DNS provider" while the
   * person is still typing the apex, so requiring a `core.domains` row first
   * would mean creating one to find out we cannot help with it — and then
   * having to delete it.
   */
  app.get("/dns/lookup", async (c) => {
    if (!d.dns) return c.json(notWired("DNS lookups"), 501)
    const name = (c.req.query("domain") ?? "").trim().toLowerCase()
    if (!name) return c.json(validation("`domain` is required."), 422)

    try {
      return c.json(await d.dns.inspect(name))
    } catch (error) {
      d.log.warn({ err: String(error), domain: name }, "dns lookup failed")
      /*
       * ⚠ 200 WITH AN `unknown` PROVIDER, NOT A 5xx. A failed NS lookup is an
       * ordinary outcome of typing a domain that does not exist yet — which is
       * most of what happens in an onboarding form. Answering with an error
       * status makes the console render a red box while somebody is still
       * halfway through typing.
       */
      return c.json({
        domain: name,
        nameservers: [],
        provider: null,
        records: {},
        error: "lookup_failed",
      })
    }
  })
}
