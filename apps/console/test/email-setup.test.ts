import { describe, expect, test } from "bun:test"
import { emailSetup, focusDomain } from "../lib/email-setup"
import type { DomainMailboxes, DomainSummary } from "../lib/types"

function domain(
  name: string,
  mailboxes?: Partial<DomainMailboxes>,
  extra: Partial<DomainSummary> = {},
): DomainSummary {
  return {
    object: "domain",
    id: `id-${name}`,
    name,
    status: "pending",
    created_at: "2026-11-01T00:00:00.000Z",
    region: "us-east-1",
    delegated: false,
    ...(mailboxes
      ? {
          mailboxes: {
            enabled: false,
            owned: false,
            sending: false,
            receiving: false,
            catch_all: null,
            count: 0,
            ...mailboxes,
          },
        }
      : {}),
    ...extra,
  }
}

const states = (setup: ReturnType<typeof emailSetup>) =>
  setup.steps.map((step) => step.state)

describe("emailSetup", () => {
  test("no domain yet: step one is to add one, the rest wait", () => {
    const setup = emailSetup([], 0)
    expect(states(setup)).toEqual(["todo", "todo", "todo", "todo"])
    expect(setup.steps[0]?.action).toEqual({
      label: "Add a domain",
      href: "/domains/new",
    })
    expect(setup.steps[1]?.action).toBeNull()
    expect(setup.steps[2]?.action).toBeNull()
    expect(setup.canCreate).toBe(false)
    expect(setup.done).toBe(0)
  })

  test("a domain added but not proven points at that domain", () => {
    const setup = emailSetup([domain("acme.dev", { owned: false })], 0)
    expect(setup.steps[0]?.state).toBe("todo")
    expect(setup.steps[0]?.status).toContain("acme.dev")
    expect(setup.steps[0]?.action?.href).toBe("/domains/id-acme.dev")
    expect(setup.steps[1]?.state).toBe("todo")
  })

  test("proven but hosting off: step two says where to turn it on", () => {
    const setup = emailSetup([domain("acme.dev", { owned: true })], 0)
    expect(states(setup)).toEqual(["done", "todo", "todo", "todo"])
    expect(setup.steps[1]?.action?.label).toBe("Turn it on")
    expect(setup.steps[1]?.status).toContain("Configuration")
    expect(setup.canCreate).toBe(false)
  })

  test("hosting on, records missing: mail still goes to the old provider", () => {
    const setup = emailSetup(
      [domain("acme.dev", { owned: true, enabled: true, receiving: false })],
      0,
    )
    expect(states(setup)).toEqual(["done", "done", "todo", "todo"])
    expect(setup.steps[2]?.status).toBe(
      "Mail for acme.dev still goes to your old provider.",
    )
    expect(setup.steps[2]?.action?.href).toBe("/domains/id-acme.dev")
    expect(setup.canCreate).toBe(true)
    expect(setup.done).toBe(2)
  })

  test("the create step has no link: the card renders the dialog there", () => {
    const setup = emailSetup([domain("acme.dev", { owned: true, enabled: true })], 0)
    expect(setup.steps[3]?.state).toBe("todo")
    expect(setup.steps[3]?.status).toBe("No mailbox yet.")
    expect(setup.steps[3]?.action).toBeNull()
  })

  test("records in place and a mailbox made: everything done", () => {
    const setup = emailSetup(
      [domain("acme.dev", { owned: true, enabled: true, receiving: true })],
      2,
    )
    expect(states(setup)).toEqual(["done", "done", "done", "done"])
    expect(setup.steps[3]?.status).toBe("You have 2 mailboxes.")
    expect(setup.done).toBe(4)
  })

  test("a step whose data is missing is unknown, never ticked", () => {
    // The API's mailbox view is absent: ownership cannot be told.
    const noView = emailSetup([domain("acme.dev")], 0)
    expect(noView.steps[0]?.state).toBe("unknown")
    expect(noView.steps[1]?.state).toBe("unknown")

    // An older answer with no `receiving`.
    const withoutReceiving = domain("acme.dev", { owned: true, enabled: true })
    delete (withoutReceiving.mailboxes as Partial<DomainMailboxes>).receiving
    const noReceiving = emailSetup([withoutReceiving], 0)
    expect(noReceiving.steps[2]?.state).toBe("unknown")
    expect(noReceiving.steps[2]?.status).toContain("cannot tell")
  })

  test("a failed read of the domains is unknown, not 'no domain'", () => {
    const setup = emailSetup(null, 0)
    expect(setup.steps[0]?.state).toBe("unknown")
    expect(setup.steps[0]?.action?.href).toBe("/domains")
    expect(setup.domain).toBeNull()
  })

  test("domains another workspace took are not the one followed", () => {
    const setup = emailSetup(
      [
        domain(
          "old.acme.net",
          { owned: false },
          { displaced_at: "2026-10-01T00:00:00Z" },
        ),
      ],
      0,
    )
    expect(setup.domain).toBeNull()
    expect(setup.steps[0]?.status).toContain("Another workspace")
    expect(setup.steps[0]?.action?.href).toBe("/domains/new")
  })

  test("DKIM waits are only raised once hosting is on and sending is not ready", () => {
    expect(
      emailSetup([domain("a.dev", { owned: true, enabled: true, sending: false })], 0)
        .sendingWaiting,
    ).toBe(true)
    expect(
      emailSetup([domain("a.dev", { owned: true, enabled: true, sending: true })], 0)
        .sendingWaiting,
    ).toBe(false)
    expect(emailSetup([domain("a.dev", { owned: false })], 0).sendingWaiting).toBe(
      false,
    )
  })
})

describe("focusDomain", () => {
  test("follows the domain furthest along, and keeps list order on a tie", () => {
    const proven = domain("a.dev", { owned: true })
    const hosting = domain("b.dev", { owned: true, enabled: true })
    const receiving = domain("c.dev", { owned: true, enabled: true, receiving: true })
    expect(focusDomain([proven, hosting, receiving])?.name).toBe("c.dev")
    expect(focusDomain([hosting, proven])?.name).toBe("b.dev")
    expect(focusDomain([proven, domain("z.dev", { owned: true })])?.name).toBe("a.dev")
  })

  test("a receiving flag without hosting does not count", () => {
    const stale = domain("a.dev", { owned: true, enabled: false, receiving: true })
    const hosting = domain("b.dev", { owned: true, enabled: true })
    expect(focusDomain([stale, hosting])?.name).toBe("b.dev")
  })

  test("none at all is null", () => {
    expect(focusDomain([])).toBeNull()
  })
})
