import type { Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { asId, notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import {
  MANAGE_MEMBERS,
  addAccessDomain,
  allowAddress,
  answerJoinRequest,
  autoJoin,
  dismissAccessSuggestion,
  joinNow,
  listAccess,
  offersFor,
  removeAccessDomain,
  removeTeamMember,
  requestToJoin,
  setAccessRules,
  verifyAccessDomain,
} from "../../console/team-domains.js"

/**
 * Team access (#326): access domains and their rules, requests to join, the
 * removed and block lists - and the person's side of it, which works with no
 * workspace at all (see WITHOUT_WORKSPACE in routes/console.ts).
 *
 * ⚠ EVERY ADMIN ROUTE ASKS CLERK FOR THE PERMISSION, through
 * console/team-domains.ts, rather than trusting the console to hide buttons.
 * And every person route decides from their VERIFIED addresses, read here
 * from Clerk, never from the body.
 */

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const noTeam = validation("Team access needs a team workspace.")

/** A newly signed-up person is auto-joined by onboarding too, for a day. */
const ARRIVAL_WINDOW_MS = 24 * 60 * 60 * 1000

export function mountTeam(app: Hono, d: ConsoleDeps): void {
  // ── Access domains ─────────────────────────────────────────────────────────

  /** This workspace's access domains, and the /domains names it could add. */
  app.get("/team/access-domains", async (c) => {
    if (!d.teamDomains) return c.json({ data: [], verified: [], suggested: [] })
    const { tenantId } = c.get("auth")
    const listed = await listAccess(d.teamDomains, tenantId)
    return c.json({
      data: listed.domains,
      verified: listed.verified,
      suggested: listed.suggested,
    })
  })

  app.post("/team/access-domains", async (c) => {
    if (!d.teamDomains) return c.json(notWired("Team access domains"), 501)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    const body = await readJson(c)
    const name = typeof body?.name === "string" ? body.name : ""
    const source = body?.source === "txt" ? "txt" : "domains"
    if (!name) return c.json(validation("`name` is required."), 422)
    const made = await addAccessDomain(d.teamDomains, {
      tenantId,
      userId,
      orgId,
      name,
      source,
    })
    switch (made.outcome) {
      case "ok":
        return c.json({ id: made.id }, made.existed ? 200 : 201)
      case "forbidden":
        return c.json(forbidden("Only an admin can change access domains."), 403)
      case "no_org":
        return c.json(noTeam, 422)
      case "personal":
        return c.json(
          validation(
            "A Personal workspace is just for you. Turn it into a team first.",
          ),
          422,
        )
      case "free_mail":
        return c.json(
          validation(
            "That is an email provider anyone can sign up with, so it can't be an access domain.",
          ),
          422,
        )
      case "invalid":
        return c.json(validation("That is not a domain name."), 422)
      default:
        return c.json(validation("Verify that domain on the Domains page first."), 422)
    }
  })

  app.post("/team/access-domains/:id/verify", async (c) => {
    if (!d.teamDomains) return c.json(notWired("Team access domains"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("No such access domain."), 404)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    const outcome = await verifyAccessDomain(d.teamDomains, {
      tenantId,
      userId,
      orgId,
      id,
    })
    if (outcome === "forbidden")
      return c.json(forbidden("Only an admin can change access domains."), 403)
    if (outcome === "no_org") return c.json(noTeam, 422)
    if (outcome === "missing") return c.json(notFound("No such access domain."), 404)
    // ⚠ 200 WITH A VERDICT: "not there yet" is an answer, not an error.
    return c.json({ proven: outcome === "proven", reason: outcome })
  })

  app.put("/team/access-domains/:id/rules", async (c) => {
    if (!d.teamDomains) return c.json(notWired("Team access domains"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("No such access domain."), 404)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    const body = await readJson(c)
    const saved = await setAccessRules(d.teamDomains, {
      tenantId,
      userId,
      orgId,
      id,
      rules: body?.rules,
    })
    if (saved.outcome === "ok") return c.json({ rules: saved.rules })
    if (saved.outcome === "invalid") return c.json(validation(saved.error), 422)
    if (saved.outcome === "forbidden")
      return c.json(forbidden("Only an admin can change access rules."), 403)
    if (saved.outcome === "no_org") return c.json(noTeam, 422)
    return c.json(notFound("No such access domain."), 404)
  })

  app.delete("/team/access-domains/:id", async (c) => {
    if (!d.teamDomains) return c.json(notWired("Team access domains"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("No such access domain."), 404)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    const outcome = await removeAccessDomain(d.teamDomains, {
      tenantId,
      userId,
      orgId,
      id,
    })
    if (outcome === "ok") return c.body(null, 204)
    if (outcome === "forbidden")
      return c.json(forbidden("Only an admin can change access domains."), 403)
    if (outcome === "no_org") return c.json(noTeam, 422)
    return c.json(notFound("No such access domain."), 404)
  })

  /** "Not now" on the suggestion card, for the whole workspace. */
  app.post("/team/access-suggestions/dismiss", async (c) => {
    if (!d.teamDomains) return c.json(notWired("Team access domains"), 501)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    const body = await readJson(c)
    const name = typeof body?.name === "string" ? body.name : ""
    if (!name) return c.json(validation("`name` is required."), 422)
    const outcome = await dismissAccessSuggestion(d.teamDomains, {
      tenantId,
      userId,
      orgId,
      name,
    })
    if (outcome === "forbidden")
      return c.json(forbidden("Only an admin can change access domains."), 403)
    if (outcome === "no_org") return c.json(noTeam, 422)
    return c.json({ ok: true })
  })

  // ── Members, requests and the lists ────────────────────────────────────────

  /** How each member got in through an access domain, for the members list. */
  app.get("/team/joins", async (c) => {
    if (!d.teamDomains) return c.json({ data: [] })
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.teamDomains.store.joins(tenantId) })
  })

  /** Unanswered requests to join this workspace. */
  app.get("/team/join-requests", async (c) => {
    if (!d.teamDomains) return c.json({ data: [] })
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.teamDomains.store.pending(tenantId) })
  })

  app.post("/team/join-requests/:id", async (c) => {
    if (!d.teamDomains) return c.json(notWired("Join requests"), 501)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    const body = await readJson(c)
    const outcome = await answerJoinRequest(d.teamDomains, {
      tenantId,
      userId,
      orgId,
      id: c.req.param("id"),
      accept: body?.accept === true,
      block: body?.block === true,
    })
    if (outcome === "ok") return c.json({ ok: true })
    if (outcome === "full")
      return c.json(
        {
          statusCode: 409,
          name: "workspace_full",
          message:
            "This workspace is full. Remove a member or withdraw an invitation first.",
        },
        409,
      )
    if (outcome === "forbidden")
      return c.json(forbidden("Only an admin can answer requests to join."), 403)
    if (outcome === "no_org") return c.json(noTeam, 422)
    return c.json(notFound("That request was already answered."), 404)
  })

  /**
   * Removes a member, onto the removed list or (`block`) the block list.
   *
   * ⚠ BEHIND `requireFreshAuth`, like every other delete a person cannot undo
   * from the same screen.
   */
  app.post("/team/members/:userId/remove", requireFreshAuth, async (c) => {
    if (!d.teamDomains) return c.json(notWired("Removing members"), 501)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    const body = await readJson(c)
    const outcome = await removeTeamMember(d.teamDomains, {
      tenantId,
      userId,
      orgId,
      memberUserId: c.req.param("userId"),
      block: body?.block === true,
    })
    if (outcome === "ok") return c.json({ ok: true })
    if (outcome === "self")
      return c.json(
        validation("Leave the workspace instead of removing yourself."),
        422,
      )
    if (outcome === "forbidden")
      return c.json(forbidden("Only an admin can remove members."), 403)
    if (outcome === "no_org") return c.json(noTeam, 422)
    return c.json(notWired("Removing members"), 501)
  })

  /** The removed and block lists. Admins only: they name people. */
  app.get("/team/exclusions", async (c) => {
    if (!d.teamDomains) return c.json({ data: [] })
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    if (!orgId || !(await d.teamDomains.can(userId, orgId, MANAGE_MEMBERS)))
      return c.json({ data: [] })
    return c.json({ data: await d.teamDomains.store.exclusions(tenantId) })
  })

  /** "Allow" or "Allow and invite" an address on either list. */
  app.post("/team/exclusions/allow", async (c) => {
    if (!d.teamDomains) return c.json(notWired("Block lists"), 501)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    const body = await readJson(c)
    const email = typeof body?.email === "string" ? body.email.trim() : ""
    if (!email.includes("@")) return c.json(validation("`email` is required."), 422)
    const outcome = await allowAddress(d.teamDomains, {
      tenantId,
      userId,
      orgId,
      email,
      invite: body?.invite === true,
      ...(typeof body?.role === "string" ? { role: body.role } : {}),
    })
    if (outcome === "ok") return c.json({ ok: true })
    if (outcome === "forbidden")
      return c.json(forbidden("Only an admin can change who may join."), 403)
    if (outcome === "no_org") return c.json(noTeam, 422)
    return c.json(notWired("Invitations"), 501)
  })

  // ── The person's side, with or without a workspace ─────────────────────────

  const verifiedOf = async (userId: string) => {
    const person = await d.people?.get(userId).catch(() => null)
    return {
      emails: person?.verifiedEmails ?? [],
      createdAt: person?.createdAt ?? null,
    }
  }

  /**
   * Workspaces offered to the signed-in person: those whose rules cover one
   * of their VERIFIED addresses, which they are not already in.
   */
  app.get("/me/join-suggestions", async (c) => {
    if (!d.teamDomains || !d.people) return c.json({ data: [] })
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const { emails } = await verifiedOf(userId)
    if (emails.length === 0) return c.json({ data: [] })
    const memberOf = await d.teamDomains.memberOrgIds(userId)
    const found = await offersFor(d.teamDomains, {
      currentTenantId: tenantId,
      userId,
      emails,
      exceptOrgIds: memberOf,
    })
    const faces = await d.teamDomains.describe(found.map((s) => s.clerkOrgId))
    return c.json({
      data: found.flatMap((s) => {
        const face = faces[s.clerkOrgId]
        if (!face) return []
        return [
          {
            tenant_id: s.tenantId,
            name: face.name,
            image_url: face.imageUrl,
            domain: s.email.split("@")[1] ?? "",
            mode: s.mode,
            requested: s.requested,
          },
        ]
      }),
    })
  })

  app.post("/me/join-requests", async (c) => {
    if (!d.teamDomains || !d.people) return c.json(notWired("Join requests"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const body = await readJson(c)
    const target = typeof body?.tenant_id === "string" ? body.tenant_id : ""
    if (!target) return c.json(validation("Which workspace?"), 422)
    const { emails } = await verifiedOf(userId)
    const outcome = await requestToJoin(d.teamDomains, {
      currentTenantId: tenantId,
      userId,
      emails,
      tenantId: target,
    })
    if (outcome === "not_suggested")
      return c.json(validation("That workspace is not suggested to you."), 422)
    return c.json({ requested: true }, outcome === "created" ? 201 : 200)
  })

  /** Join now, where the rule for this person is auto-join. */
  app.post("/me/joins", async (c) => {
    if (!d.teamDomains || !d.people) return c.json(notWired("Joining"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const body = await readJson(c)
    const target = typeof body?.tenant_id === "string" ? body.tenant_id : ""
    if (!target) return c.json(validation("Which workspace?"), 422)
    const { emails } = await verifiedOf(userId)
    const joined = await joinNow(d.teamDomains, {
      currentTenantId: tenantId,
      userId,
      emails,
      tenantId: target,
    })
    if (joined.outcome === "joined")
      return c.json({ joined: true, organization_id: joined.orgId }, 201)
    if (joined.outcome === "full") return c.json({ joined: false, full: true }, 202)
    return c.json(
      validation("You can't join that workspace directly. Ask to join instead."),
      422,
    )
  })

  /**
   * What happened at sign-up: workspaces they were auto-joined to, and full
   * ones that took a request instead - for "You joined Acme" on onboarding.
   *
   * ⚠ IT ALSO RUNS AUTO-JOIN, FOR SOMEBODY WHO SIGNED UP IN THE LAST DAY. The
   * `user.created` webhook is the trigger, and Svix may still be retrying it
   * when they land here; asking again is safe because auto-join is
   * idempotent. An older account is only told, never joined - that would turn
   * auto-join into "joins whenever you open onboarding".
   */
  app.post("/me/arrivals", async (c) => {
    if (!d.teamDomains || !d.people) return c.json({ data: [] })
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const { emails, createdAt } = await verifiedOf(userId)
    const since = new Date(Date.now() - ARRIVAL_WINDOW_MS)
    if (createdAt !== null && createdAt >= since.getTime() && emails.length > 0) {
      await autoJoin(d.teamDomains, { currentTenantId: tenantId, userId, emails })
    }
    const arrived = await d.teamDomains.store.arrivals(userId, since)
    const memberOf = await d.teamDomains.memberOrgIds(userId)
    const orgOf = new Map(
      (
        await d.teamDomains.store.accessFor({
          currentTenantId: tenantId,
          userId,
          emails,
        })
      ).domains.map((dom) => [dom.tenantId, dom.clerkOrgId]),
    )
    const faces = await d.teamDomains.describe(
      arrived.flatMap((a) => (orgOf.has(a.tenantId) ? [orgOf.get(a.tenantId)!] : [])),
    )
    return c.json({
      data: arrived.flatMap((a) => {
        const orgId = orgOf.get(a.tenantId)
        const face = orgId ? faces[orgId] : undefined
        if (!orgId || !face) return []
        // Joined, and still a member: Continue opens it.
        if (a.outcome === "joined" && !memberOf.includes(orgId)) return []
        return [
          {
            organization_id: orgId,
            name: face.name,
            image_url: face.imageUrl,
            outcome: a.outcome,
            via: a.via,
          },
        ]
      }),
    })
  })
}
