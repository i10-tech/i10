import type { Context, Hono } from "hono"
import {
  createTeamInboxSchema,
  mailboxAddressSchema,
  setTeamInboxMembersSchema,
} from "@repo/contracts"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import type { TeamInboxOutcome } from "../../team-inboxes/service.js"

/**
 * Team inboxes: shared addresses the workspace's people read and send from.
 *
 * ⚠ THE VISIBILITY RULE LIVES IN `team-inboxes/service.ts`, NOT HERE. This file
 * turns a session into a `Viewer` and an outcome into a status; it decides
 * nothing about who may see what, so there is one place to read and one to test.
 * In short: owners and admins manage every team inbox of the workspace, and a
 * member sees only the ones they are in, read-only.
 *
 * ⚠ THE ADDRESS IS THE IDENTIFIER, in the path and in the bodies; a Clerk user
 * id never appears (see packages/contracts/src/team-inbox.ts).
 */

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const noTeam = validation("Team inboxes need a team workspace.")

const NOT_FOUND = notFound("No such team inbox.")

export function mountTeamInboxes(app: Hono, d: ConsoleDeps): void {
  const viewerOf = (c: Context) => ({
    tenantId: c.get("auth").tenantId,
    userId: c.get("user").userId,
    orgId: c.get("user").orgId,
  })

  /** A path address, or nothing when it could not be one. */
  const addressOf = (raw: string | undefined) => {
    const parsed = mailboxAddressSchema.safeParse(raw ?? "")
    return parsed.success ? parsed.data : null
  }

  const answer = (c: Context, outcome: TeamInboxOutcome) => {
    switch (outcome.status) {
      case "ok":
        return c.json(outcome.inbox)
      case "forbidden":
        return c.json(forbidden("Only an admin can manage team inboxes."), 403)
      case "no_org":
        return c.json(noTeam, 422)
      case "missing":
        return c.json(NOT_FOUND, 404)
      case "conflict":
        return c.json(
          {
            statusCode: 409,
            name: "team_inbox_already_exists" as const,
            message: outcome.reason,
          },
          409,
        )
      default:
        return c.json(validation(outcome.reason), 422)
    }
  }

  /** The inboxes this person may see: all of them for an admin, their own otherwise. */
  app.get("/team-inboxes", async (c) => {
    if (!d.teamInboxes) return c.json(notWired("Team inboxes"), 501)
    return c.json({ data: await d.teamInboxes.list(viewerOf(c)) })
  })

  app.post("/team-inboxes", async (c) => {
    if (!d.teamInboxes) return c.json(notWired("Team inboxes"), 501)
    const parsed = createTeamInboxSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid request."),
        422,
      )
    }

    const outcome = await d.teamInboxes.create(viewerOf(c), {
      address: parsed.data.address,
      displayName: parsed.data.display_name,
      members: parsed.data.members,
    })
    if (outcome.status === "ok") return c.json(outcome.inbox, 201)
    return answer(c, outcome)
  })

  /**
   * ⚠ "NOT FOUND" FOR A MEMBER OF THE WORKSPACE WHO IS NOT IN THIS INBOX, AS FOR
   * AN ADDRESS THAT DOES NOT EXIST. A 403 would confirm it is there.
   */
  app.get("/team-inboxes/:address", async (c) => {
    if (!d.teamInboxes) return c.json(notWired("Team inboxes"), 501)
    const address = addressOf(c.req.param("address"))
    if (!address) return c.json(NOT_FOUND, 404)

    const inbox = await d.teamInboxes.get(viewerOf(c), address)
    return inbox ? c.json(inbox) : c.json(NOT_FOUND, 404)
  })

  app.put("/team-inboxes/:address/members", async (c) => {
    if (!d.teamInboxes) return c.json(notWired("Team inboxes"), 501)
    const address = addressOf(c.req.param("address"))
    if (!address) return c.json(NOT_FOUND, 404)

    const parsed = setTeamInboxMembersSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid request."),
        422,
      )
    }

    return answer(
      c,
      await d.teamInboxes.setMembers(viewerOf(c), address, parsed.data.members),
    )
  })

  app.delete("/team-inboxes/:address", async (c) => {
    if (!d.teamInboxes) return c.json(notWired("Team inboxes"), 501)
    const address = addressOf(c.req.param("address"))
    if (!address) return c.json(NOT_FOUND, 404)

    const outcome = await d.teamInboxes.remove(viewerOf(c), address)
    if (outcome === "forbidden") {
      return c.json(forbidden("Only an admin can manage team inboxes."), 403)
    }
    return outcome === "ok" ? c.body(null, 204) : c.json(NOT_FOUND, 404)
  })
}
