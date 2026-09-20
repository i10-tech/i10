/*
 * Proxies the API's public checkout-status endpoint.
 *
 * ⚠ WHY A PROXY AND NOT A DIRECT BROWSER CALL. api.i10.tech sends no CORS
 * headers, and it should not start doing so for one status page — every origin
 * it allows is a decision that outlives the reason for it. Going through this
 * route keeps the poll same-origin, so there is nothing to allow.
 *
 * ⚠ IT ADDS NO CREDENTIAL, AND MUST NOT. The upstream route is deliberately
 * unauthenticated and grants nothing; attaching an API key here would turn a
 * page anyone may open into one holding a key that can send mail.
 */

import { PREVIEW, previewCheckoutStatus } from "@/lib/preview"

const API = process.env.I10_BASE_URL ?? "https://api.i10.tech"

/**
 * Polar checkout ids are UUIDs. Checked before interpolation so a crafted
 * parameter cannot walk the path — `..%2F` and friends reach a different
 * upstream route otherwise.
 */
const CHECKOUT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ checkoutId: string }> },
) {
  const { checkoutId } = await params

  if (!CHECKOUT_ID.test(checkoutId)) {
    return Response.json({ status: "unknown", plan: null }, { status: 200 })
  }

  /*
   * ⚠ A FIXTURE HERE, EVEN THOUGH PREVIEW REFUSES TO START A CHECKOUT. Reading
   * what became of one is not taking money, and its outcomes are five pieces of
   * copy — success, still settling, closed, declined, expired — that were
   * otherwise impossible to look at without a Polar account. `PREVIEW` folds to
   * `false` at build time in production, so this branch is deleted rather than
   * merely unreachable. See lib/preview.ts.
   */
  if (PREVIEW) {
    return Response.json(previewCheckoutStatus(checkoutId), { status: 200 })
  }

  try {
    const upstream = await fetch(`${API}/checkout-status/${checkoutId}`, {
      // The whole point is to observe a row that changes; a cached answer would
      // show "setting up your plan" for as long as the cache lived.
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    })

    return Response.json(await upstream.json(), { status: upstream.status })
  } catch {
    // ⚠ 503 RATHER THAN A VERDICT. The API being unreachable says nothing about
    // whether the customer paid, and the page keeps polling through it instead
    // of telling somebody who just paid that something failed.
    return Response.json({ status: "unavailable", plan: null }, { status: 503 })
  }
}
