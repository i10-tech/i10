import { describe, expect, it } from "bun:test"
import { polarClient } from "../src/billing/polar.js"

/**
 * A prefilled email Polar refuses never costs the checkout (2026-10-13). Polar
 * answers 422 for the whole checkout when it decides an address cannot receive
 * mail; the email is cosmetic, so the checkout is made again without it.
 */
function recording(answers: Response[]) {
  const bodies: Record<string, unknown>[] = []
  const client = polarClient({
    accessToken: "stub-token-never-sent",
    server: "sandbox",
    fetch: (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
      return answers.shift()!
    }) as unknown as typeof fetch,
  })
  return { client, bodies }
}

const created = () =>
  new Response(
    JSON.stringify({
      id: "co_1",
      url: "https://sandbox.polar.sh/c/co_1",
      expires_at: "x",
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  )

describe("creating a Polar checkout with a prefilled email", () => {
  it("sends the email when Polar takes it", async () => {
    const { client, bodies } = recording([created()])
    await client.createCheckout({ productId: "p", tenantId: "t", email: "a@acme.com" })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ customer_email: "a@acme.com" })
  })

  it("makes the checkout again without it when Polar refuses the address", async () => {
    const refused = new Response(
      JSON.stringify({
        error: "RequestValidationError",
        detail: [{ loc: ["body", "customer_email"], msg: "not a valid email address" }],
      }),
      { status: 422, headers: { "content-type": "application/json" } },
    )
    const { client, bodies } = recording([refused, created()])
    const checkout = await client.createCheckout({
      productId: "p",
      tenantId: "t",
      email: "a@nowhere.test",
    })
    expect(checkout.id).toBe("co_1")
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).not.toHaveProperty("customer_email")
  })

  it("still fails on a 422 that is about something else", async () => {
    const other = new Response(
      JSON.stringify({ detail: [{ loc: ["body", "products"] }] }),
      {
        status: 422,
      },
    )
    const { client } = recording([other])
    await expect(
      client.createCheckout({ productId: "p", tenantId: "t", email: "a@acme.com" }),
    ).rejects.toThrow("422")
  })
})
