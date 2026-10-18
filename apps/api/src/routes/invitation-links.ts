import { Hono } from "hono"
import { openInvitation, type MembersDeps } from "../console/members.js"

/**
 * Where the link in our invitation email lands, by way of the console's
 * `/invite/:id` (#327).
 *
 * ⚠ UNAUTHENTICATED, AND IT ANSWERS ABOUT ONE ROW: the one whose id the email
 * carries (`app.invitation_id`, see `member_invitations`). It hands back
 * Clerk's accept link while the invitation is in time, and past its expiry
 * revokes it there and then - "opening an invite link" is one of the seat
 * uses that check the clock first.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createInvitationLinks(deps?: MembersDeps) {
  const app = new Hono()
  app.get("/:id", async (c) => {
    const id = c.req.param("id")
    if (!deps || !UUID.test(id)) return c.json({ outcome: "missing" }, 404)
    const opened = await openInvitation(deps, id)
    if (opened.outcome === "open") return c.json({ outcome: "open", url: opened.url })
    const status =
      opened.outcome === "missing" ? 404 : opened.outcome === "full" ? 409 : 410
    return c.json({ outcome: opened.outcome }, status)
  })
  return app
}
