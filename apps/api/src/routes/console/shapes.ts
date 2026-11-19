import type { Hono } from "hono"
import { MAX_SKELETON_ROWS, type ShapeCounts } from "../../console/queries.js"
import type { ConsoleDeps } from "./deps.js"
import { verifiedEmailsFor } from "./domains.js"

/**
 * Counts for every console list page, for the first-visit skeleton.
 *
 * ⚠ COUNTS ONLY, NEVER ROW DATA. Every count is capped at MAX_SKELETON_ROWS (10),
 * so queries stop after 11 rows rather than scanning whole tables.
 *
 * ⚠ EVERY COUNT IS INDEPENDENT AND PARALLEL. A failed query omits only that key,
 * so a single missing table or failing count falls back to the default skeleton
 * rather than failing the whole call.
 */
export function mountShapes(app: Hono, d: ConsoleDeps): void {
  app.get("/shapes", async (c) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")

    const [dbCountsRes, transfersRes, catalogRes, billingRes] =
      await Promise.allSettled([
        d.queries?.countShapes ? d.queries.countShapes(tenantId) : Promise.resolve({}),
        d.transfers && d.people
          ? verifiedEmailsFor(d, userId).then(async (emails) => {
              const offers = await d.transfers!.incoming(tenantId, emails)
              return Math.min(Math.max(offers.length, 0), MAX_SKELETON_ROWS)
            })
          : Promise.reject(new Error("Transfers not wired")),
        // ⚠ THE CATALOGUE THIS WORKSPACE IS OFFERED, NOT A STATIC LIST: a bespoke
        // plan shows up for its customer only. Its size decides the billing
        // skeleton's card heights.
        d.usage?.catalog
          ? d.usage.catalog(tenantId)
          : Promise.reject(new Error("Catalogue not wired")),
        d.usage?.billing
          ? d.usage.billing(tenantId)
          : Promise.reject(new Error("Billing not wired")),
      ])

    const data: ShapeCounts = {}
    if (dbCountsRes.status === "fulfilled") {
      Object.assign(data, dbCountsRes.value)
    }
    if (transfersRes.status === "fulfilled") {
      data.transfers = transfersRes.value
    }

    // ⚠ A FLAG, NOT A COUNT, AND ABSENT MEANS NOT WIRED: whether the GitHub panel exists at all on the
    // templates page is a property of the deployment.
    if (d.github) data.githubConfigured = 1

    if (catalogRes.status === "fulfilled") {
      const cap = (n: number) => Math.min(Math.max(n, 0), MAX_SKELETON_ROWS)
      data.plans = cap(catalogRes.value.length)
      data.planEntitlements = cap(
        Math.max(0, ...catalogRes.value.map((p) => p.entitlements.length)),
      )

      /*
       * ⚠ THE NOTE UNDER ONE CARD'S BUTTON, AS PlanCards DECIDES IT. The cards
       * share a row height and a note makes its card taller, so the skeleton has
       * to reserve it. Lines are the measured wrap at the usual three-card width
       * (apps/console/lib/shapes/billing.ts keeps the same rule for a revisit).
       */
      if (billingRes.status === "fulfilled") {
        const { subscription: sub, plan } = billingRes.value
        const plans = catalogRes.value
        const scheduled = sub?.scheduled_plan_id
        const card = scheduled
          ? plans.findIndex((p) => p.id === scheduled)
          : sub?.cancel_at_period_end && sub.current_period_end && (plan?.rank ?? 0) > 0
            ? plans.findIndex((p) => p.rank === 0)
            : -1
        if (card >= 0 && card < MAX_SKELETON_ROWS) {
          data.planNoteCard = card
          data.planNoteLines = scheduled ? 3 : 2
        }
      }
    }

    return c.json({ data })
  })
}
