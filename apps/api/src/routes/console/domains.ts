import type { Hono } from "hono"
import { updateDomainSchema } from "@repo/contracts"
import { cacheKeyFor } from "../../auth/api-key.js"
import { requireFreshAuth } from "../../middleware/session.js"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { sendingStatus } from "./sending.js"

/**
 * Sending domains, and the live DNS behind them.
 *
 * ⚠ EVERY WRITE GOES THROUGH `DomainStore`, WHICH IS THE ONLY PLACE A PLAN'S
 * DOMAIN LIMIT IS ENFORCED. A console path that wrote `core.domains` itself
 * would be a second implementation of that limit, and the console is exactly
 * where somebody would notice it was missing last.
 */
export function mountDomains(app: Hono, d: ConsoleDeps): void {
  /*
   * What the sidebar's mark on "Domains" is counting.
   *
   * ⚠ EVERY PART IS BEST-EFFORT AND ALWAYS 200. The mark is on every page; a
   * slow Clerk or a missing store must drop that one reason, never fail the
   * shell or paint a problem that is not there.
   *
   * ⚠ REPUTATION IS HERE THOUGH IT IS THE WORKSPACE'S, NOT A DOMAIN'S. SES
   * judges the tenant, but what a customer fixes about it - which domain is
   * sending to a stale list - they fix from the domains they send from.
   */
  app.get("/attention", async (c) => {
    const { tenantId } = c.get("auth")
    const userId = c.get("user").userId
    const settle = async <T>(p: Promise<T> | undefined, fallback: T): Promise<T> => {
      try {
        return (await p) ?? fallback
      } catch {
        return fallback
      }
    }

    const [held, transfers, status] = await Promise.all([
      settle(d.domains?.needsAttention(tenantId), { unverified: 0, proofMissing: 0 }),
      settle(
        d.transfers && d.people
          ? verifiedEmailsFor(d, userId).then((emails) =>
              d.transfers!.incoming(tenantId, emails),
            )
          : undefined,
        [],
      ),
      settle(sendingStatus(d, tenantId), null),
    ])
    const reputation = status?.health ?? "healthy"
    return c.json({
      domains: {
        total:
          held.unverified +
          held.proofMissing +
          transfers.length +
          (reputation === "healthy" ? 0 : 1),
        unverified: held.unverified,
        proof_missing: held.proofMissing,
        transfers: transfers.length,
        reputation,
      },
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Domains
  // ───────────────────────────────────────────────────────────────────────────

  /*
   * ⚠ `displaced_at` IS ADDED HERE AND NOWHERE ELSE. It says another workspace
   * proved the name and took it; the console needs it to explain a domain that
   * suddenly cannot send, and the public API's `Domain` has no business
   * carrying anything about our other customers.
   */
  app.get("/domains", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const [list, displaced] = await Promise.all([
      d.domains.list(tenantId),
      d.domains.displaced(tenantId),
    ])
    return c.json({
      data: list.map((domain) => ({
        ...domain,
        displaced_at: displaced[domain.id] ?? null,
      })),
    })
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

  /**
   * Whether `POST /domains` would refuse this name, asked while it is typed.
   *
   * ⚠ REGISTERED ABOVE `/domains/:id`, OR `check` IS READ AS AN ID.
   *
   * ⚠ 200 EITHER WAY. A refusal is the answer to the question, not a failure
   * to ask it - and the console treats any error here as "no objection" so a
   * slow check never blocks somebody adding a domain; `create` still decides.
   */
  app.get("/domains/check", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const name = (c.req.query("name") ?? "").trim()
    if (!name) return c.json(validation("`name` is required."), 422)
    return c.json({ name, refusal: await d.domains.refusal(tenantId, name) })
  })

  app.get("/domains/:id", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const [domain, displaced, checks] = await Promise.all([
      d.domains.get(tenantId, c.req.param("id")),
      d.domains.displaced(tenantId),
      // ⚠ CONSOLE ONLY, like `displaced_at`: the events strip's timestamps.
      d.domains.checks(tenantId, c.req.param("id")),
    ])
    return domain
      ? c.json({
          ...domain,
          displaced_at: displaced[domain.id] ?? null,
          verified_at: checks?.verified_at ?? null,
          dns_checked_at: checks?.dns_checked_at ?? null,
        })
      : c.json(notFound("No domain with that id."), 404)
  })

  /*
   * Open and click tracking (#154). The same contract as the public
   * `PATCH /domains/{id}`, validated with the same schema, so the two surfaces
   * cannot accept different things.
   */
  app.patch("/domains/:id", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const parsed = updateDomainSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(validation(parsed.error.issues[0]?.message ?? "Invalid body."), 422)
    }
    const domain = await d.domains.update(tenantId, c.req.param("id"), parsed.data)
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
       * and being set up - the same state a manual domain is in before its six
       * records resolve, which also answers 200. The domain comes back carrying
       * its record list, where the outstanding `Ownership` row is the signal.
       */

      /*
       * ⚠ `ownership` IS THE ANSWER THIS ROUTE USED TO THROW AWAY, AND ITS
       * ABSENCE WAS MOST OF "I PUBLISHED THE RECORDS AND NOTHING HAPPENS".
       * `verify` distinguishes three outcomes that matter to the person
       * pressing the button - we proved the domain, we asked and the records
       * were not there, we could not ask at all - and all three arrived at the
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
      /*
       * ⚠ `leftover_records` ONLY WHEN THIS VERIFY TOOK THE NAME FROM ANOTHER
       * WORKSPACE AND THEIR RECORDS STILL RESOLVE. The latest proof wins, so
       * while those are published the old holder can take it straight back -
       * removing them is how the person who just proved it keeps it.
       */
      case "ok":
        return c.json({
          ...outcome.domain,
          ownership: { proven: true },
          ...(outcome.leftover ? { leftover_records: outcome.leftover } : {}),
        })
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
         * perfect. Proving a name takes it from whoever holds it, so this is
         * only ever a race - another workspace proved it in the same moment -
         * and pressing Verify again settles it.
         */
        return c.json(
          {
            statusCode: 409,
            name: "domain_already_claimed" as const,
            message:
              `${outcome.domain.name} was verified by another workspace at the ` +
              `same moment. Press Verify again to settle which one holds it.`,
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
   * writes is SES's current opinion and the check timestamp - see the note on
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
       * published, which is precisely when something is polling - answering
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
   * records into its own zone and there is no delegation to diagnose - the
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
     * against the deployment's `MAIL_NAMESERVERS` - which is what this did -
     * told a customer who had published exactly what we asked for that their
     * records pointed at somebody else, and named our own nameserver as the
     * somebody else.
     */
    const delegation = domain.records.filter((r) => r.type === "NS")
    const zones = [...new Set(delegation.map((r) => r.name))]
    const expected = delegation.map((r) => r.value)

    try {
      return c.json(await d.delegation.check(domain.name, zones, expected))
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
   * all - the same records the table below shows are written directly.
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
   * it, and re-adding one means re-proving ownership and re-publishing DNS -
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

  // ───────────────────────────────────────────────────────────────────────────
  // Transfers - offering a domain to an email address, and answering one
  // ───────────────────────────────────────────────────────────────────────────

  /** The open offer for this domain, if the workspace has made one. */
  app.get("/domains/:id/transfer", async (c) => {
    if (!d.transfers) return c.json(notWired("Transfers"), 501)
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.transfers.outgoing(tenantId, c.req.param("id")) })
  })

  /*
   * ⚠ STEP-UP, LIKE DELETE. An accepted offer takes the domain out of this
   * workspace as surely as deleting it does, and a stolen session could
   * otherwise offer a customer's domain to an address it controls.
   *
   * ⚠ THE OFFER MOVES NOTHING BY ITSELF. The domain keeps sending from here
   * until the recipient accepts, and this workspace can withdraw it until then.
   */
  app.post("/domains/:id/transfer", requireFreshAuth, async (c) => {
    if (!d.transfers || !d.people) return c.json(notWired("Transfers"), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const email = typeof body?.email === "string" ? body.email : ""
    if (!email) return c.json(validation("`email` is required."), 422)

    const [person, profile] = await Promise.all([
      d.people.get(c.get("user").userId),
      d.profile.get(tenantId),
    ])

    // ⚠ NOT TO YOURSELF - any address verified on your own account. A transfer
    // hands a domain to another person; colleagues in this workspace are fine.
    if (person.verifiedEmails.includes(email.trim().toLowerCase())) {
      return c.json(
        validation("That is your own address. Offer it to someone else."),
        422,
      )
    }

    const offered = await d.transfers.offer(tenantId, c.req.param("id"), {
      email,
      offeredBy: person.name,
      fromWorkspace: profile?.name ?? "another",
    })

    if (offered.status === "missing")
      return c.json(notFound("No domain with that id."), 404)
    if (offered.status === "rejected") return c.json(validation(offered.reason), 422)

    const { offer } = offered
    let emailed = false
    if (d.transferNotice) {
      try {
        await d.transferNotice.send({
          to: offer.recipient_email,
          offerId: offer.id,
          domain: offer.domain_name,
          offeredBy: offer.offered_by,
          fromWorkspace: offer.from_workspace,
          expiresAt: new Date(offer.expires_at),
        })
        emailed = true
      } catch (error) {
        // ⚠ THE OFFER STANDS. An existing user still finds it on their domains
        // page; the sender is told the email did not go, rather than the whole
        // offer failing over a mail problem.
        d.log.error(
          { err: String(error), offer: offer.id },
          "domain transfer offered, but its email could not be sent",
        )
      }
    }

    return c.json({ ...offer, emailed }, 201)
  })

  app.delete("/domains/:id/transfer", async (c) => {
    if (!d.transfers) return c.json(notWired("Transfers"), 501)
    const { tenantId } = c.get("auth")
    const canceled = await d.transfers.cancel(tenantId, c.req.param("id"))
    return canceled
      ? c.json({ canceled: true })
      : c.json(notFound("There is no open transfer for that domain."), 404)
  })

  /**
   * Offers addressed to the signed-in person, whichever workspace they are in.
   *
   * ⚠ MATCHED ON CLERK'S VERIFIED ADDRESSES, ASKED NOW. Never on anything in the
   * request, and never on an unverified address - see `people`.
   */
  app.get("/transfers", async (c) => {
    if (!d.transfers || !d.people) return c.json(notWired("Transfers"), 501)
    const { tenantId } = c.get("auth")
    const { verifiedEmails } = await d.people.get(c.get("user").userId)
    return c.json({ data: await d.transfers.incoming(tenantId, verifiedEmails) })
  })

  /**
   * One offer, and where it could land.
   *
   * ⚠ THE DESTINATIONS ARE EVERY WORKSPACE THIS PERSON BELONGS TO EXCEPT THE
   * ONE THE DOMAIN IS ALREADY IN - which is what lets somebody in the SAME
   * workspace as the sender take it into one of their others. The sender's
   * tenant id is used to filter and never returned.
   */
  app.get("/transfers/:id", async (c) => {
    if (!d.transfers || !d.people || !d.memberships)
      return c.json(notWired("Transfers"), 501)
    const { tenantId } = c.get("auth")
    const userId = c.get("user").userId
    const { verifiedEmails } = await d.people.get(userId)

    const offer = await d.transfers.find(tenantId, verifiedEmails, c.req.param("id"))
    if (!offer) {
      return c.json(
        notFound(
          "This transfer is not addressed to an email verified on your account, " +
            "or it has expired, been withdrawn or already been answered.",
        ),
        404,
      )
    }

    const { fromTenantId, ...visible } = offer
    const workspaces = (await workspacesOf(userId))
      .filter((w) => w.tenantId !== fromTenantId)
      .map((w) => ({ id: w.id, name: w.name, current: w.tenantId === tenantId }))

    return c.json({ ...visible, workspaces })
  })

  app.post("/transfers/:id/accept", async (c) => {
    if (!d.transfers || !d.people || !d.memberships)
      return c.json(notWired("Transfers"), 501)
    const { tenantId } = c.get("auth")
    const userId = c.get("user").userId
    const body = await readJson(c)
    const workspace = typeof body?.workspace === "string" ? body.workspace : ""

    /*
     * ⚠ NO `workspace` MEANS THIS ONE - the workspace the session already
     * resolved to, which needs no membership lookup. That is onboarding's case:
     * a new account has one workspace and accepts into it.
     *
     * ⚠ A NAMED ONE IS RESOLVED FROM CLERK'S CURRENT MEMBERSHIP, NOT THE BODY.
     * Only an organization this person belongs to right now is accepted, and
     * its tenant comes from the same resolver a session there would use.
     */
    const target = workspace
      ? d.memberships && (await workspacesOf(userId)).find((w) => w.id === workspace)
      : { id: "", name: "", tenantId }
    if (!target) {
      return c.json(validation("You are not a member of that workspace."), 422)
    }

    const { verifiedEmails } = await d.people.get(userId)
    const accepted = await d.transfers.accept({
      tenantId,
      emails: verifiedEmails,
      id: c.req.param("id"),
      toTenantId: target.tenantId,
    })

    switch (accepted.status) {
      case "accepted":
        /*
         * ⚠ EVICTED AFTER THE COMMIT, AND A FAILURE IS LOGGED, NOT RETURNED.
         * A verified key sits in Redis with its scopes baked in for the TTL, so
         * a revoked or narrowed key could still send from the departed domain
         * for up to a minute. The recipient has done nothing wrong and cannot
         * retry the sender's cache, so this is the sender's error to see in
         * the log rather than the recipient's to see on screen.
         */
        if (d.keys?.cache) {
          for (const hash of accepted.keys.secretHashes) {
            try {
              await d.keys.cache.del(cacheKeyFor(hash))
            } catch (error) {
              d.log.error(
                { err: String(error), domain: accepted.domainName },
                "transferred a domain but could not evict a changed key from the cache",
              )
            }
          }
        }
        return c.json({
          domain_id: accepted.domainId,
          domain_name: accepted.domainName,
          workspace: target.id ? { id: target.id, name: target.name } : null,
        })
      case "missing":
        return c.json(notFound("That transfer is no longer open."), 404)
      case "rejected":
        return c.json(validation(accepted.reason), 422)
      case "conflict":
        return c.json(
          {
            statusCode: 409,
            name: "domain_already_exists" as const,
            message: accepted.reason,
          },
          409,
        )
      default:
        return c.json(
          {
            statusCode: 403,
            name: "plan_limit_exceeded" as const,
            message: accepted.reason,
          },
          403,
        )
    }
  })

  app.post("/transfers/:id/decline", async (c) => {
    if (!d.transfers || !d.people) return c.json(notWired("Transfers"), 501)
    const { tenantId } = c.get("auth")
    const { verifiedEmails } = await d.people.get(c.get("user").userId)
    const declined = await d.transfers.decline(
      tenantId,
      verifiedEmails,
      c.req.param("id"),
    )
    return declined
      ? c.json({ declined: true })
      : c.json(notFound("That transfer is no longer open."), 404)
  })

  /**
   * Every workspace this person belongs to, with the tenant behind each.
   *
   * ⚠ RESOLVED THROUGH `tenant_for_principal` WITH EACH ORGANIZATION, the same
   * path a session in that workspace takes, so a domain lands on exactly the
   * tenant switching to that workspace would show.
   */
  async function workspacesOf(
    userId: string,
  ): Promise<{ id: string; name: string; tenantId: string }[]> {
    const orgs = await d.memberships!.list(userId)
    const resolved = await Promise.all(
      orgs.map(async (org) => ({
        ...org,
        tenantId: await d.tenants.resolve({ userId, orgId: org.id }),
      })),
    )
    return resolved.flatMap((w) =>
      w.tenantId ? [{ id: w.id, name: w.name, tenantId: w.tenantId }] : [],
    )
  }

  /**
   * Live DNS for a domain: who hosts it, and what we can currently see.
   *
   * ⚠ IT TAKES A NAME RATHER THAN AN ID, BECAUSE IT IS USED *BEFORE* THE DOMAIN
   * EXISTS. The onboarding flow asks "who is your DNS provider" while the
   * person is still typing the apex, so requiring a `core.domains` row first
   * would mean creating one to find out we cannot help with it - and then
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
       * ordinary outcome of typing a domain that does not exist yet - which is
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

/**
 * A person's verified addresses, remembered for a minute.
 *
 * ⚠ THE ATTENTION MARK IS FETCHED ON EVERY PAGE, AND THIS IS A CLERK API CALL.
 * Uncached it would be one backend request per navigation per person - the
 * fastest route to Clerk's rate limit the console has. A minute is short
 * enough that a newly verified address shows its offers almost at once, and
 * the transfers page itself always asks fresh.
 */
const EMAILS_TTL_MS = 60_000
const emailsCache = new Map<string, { at: number; emails: string[] }>()

async function verifiedEmailsFor(d: ConsoleDeps, userId: string): Promise<string[]> {
  const hit = emailsCache.get(userId)
  if (hit && Date.now() - hit.at < EMAILS_TTL_MS) return hit.emails
  const { verifiedEmails } = await d.people!.get(userId)
  // Bounded: an entry per person who opened the console in the last minute,
  // swept on write so a long-lived pod does not keep everyone it ever saw.
  if (emailsCache.size > 5_000) {
    for (const [k, v] of emailsCache) {
      if (Date.now() - v.at >= EMAILS_TTL_MS) emailsCache.delete(k)
    }
  }
  emailsCache.set(userId, { at: Date.now(), emails: verifiedEmails })
  return verifiedEmails
}
