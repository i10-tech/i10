import { feature, plan, planFeature } from "atmn"

/**
 * i10's entitlement catalogue, in version control.
 *
 * ⚠ THE DASHBOARD IS NOT THE SOURCE OF TRUTH — THIS FILE IS. Autumn's UI can
 * create the same objects, and a catalogue edited by clicking is one nobody can
 * review, diff or roll back. `atmn push` reconciles the instance to this file;
 * anything changed in the UI is overwritten by the next push, which is the
 * behaviour we want rather than a hazard to work around.
 *
 * ⚠ AND THE IDS ARE A CONTRACT WITH RUNNING CODE. `emails.id` is what
 * `AUTUMN_FEATURE_ID` names, what `check` asks about and what `track` deducts
 * from — apps/api/src/send/autumn.ts sends it on every call. Renaming it here
 * does not fail: `check` answers `allowed: false` for a feature the customer
 * does not have, our client reads that as `exceeded`, and every customer gets a
 * 429 with "you have used your sending allowance". Add features; never rename.
 *
 * Push with:
 *   atmn push            # sandbox
 *   atmn push -p         # production
 */

/**
 * One unit is one accepted message.
 *
 * ⚠ `consumable`, SO A BALANCE IS DRAWN DOWN AND RESET RATHER THAN COUNTED
 * UPWARD. That is what makes `check` able to answer "no" — a non-consumable
 * meter records usage and never refuses, which would leave quota enforcement
 * with nothing to read and every plan effectively unlimited.
 *
 * ⚠ AND IT IS COUNTED AT SEND, NOT AT ACCEPT. apps/api records usage after SES
 * takes the message, so a message rejected for a malformed address is never
 * billed — see the note on `recordSent` in send/metering.ts.
 */
export const emails = feature({
  id: "emails",
  name: "Emails",
  type: "metered",
  consumable: true,
})

/**
 * The free tier.
 *
 * ⚠ IT HAS TO EXIST AND IT HAS TO BE THE DEFAULT. A tenant with no plan is a
 * customer Autumn has no entitlement for, and `check` refuses — so without a
 * free plan attached at signup, the first send by every new account is a 429.
 * The reconciler's `missingCustomers()` exists to find the tenants this did not
 * reach.
 *
 * The daily-reset shape is deliberate: a monthly free allowance is a customer
 * who exhausts it on day one and cannot evaluate the product until next month.
 */
export const free = plan({
  id: "free",
  name: "Free",
  items: [
    planFeature({
      feature_id: emails.id,
      included: 100,
      reset: { interval: "day" },
    }),
  ],
})

/**
 * The paid tier.
 *
 * ⚠ THE PRICE IS HERE FOR AUTUMN'S ARITHMETIC, NOT TO CHARGE ANYONE. Polar is
 * the payment rail and the state of record for subscriptions; Autumn is
 * attached with `no_billing_changes: true`, so it never creates a Stripe
 * subscription and never takes money. What the amount does is let Autumn reason
 * about upgrades and proration if that is ever wanted — and it must stay in
 * step with the Polar product by hand, because nothing reconciles the two
 * numbers.
 *
 * ⚠ KEEP IT EQUAL TO THE POLAR PRICE. They are two systems with one number
 * between them and no link; a customer seeing one figure at checkout and
 * another in the dashboard is a support ticket that starts as a trust problem.
 */
export const pro = plan({
  id: "pro",
  name: "Pro",
  price: { amount: 2000, interval: "month" },
  items: [
    planFeature({
      feature_id: emails.id,
      included: 50_000,
      reset: { interval: "month" },
    }),
  ],
})
