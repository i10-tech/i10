import { describe, expect, it } from "bun:test"
import { broadcastJourney, domainJourney, emailJourney } from "@/lib/journey"

const at = (minutes: number) =>
  new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString()
const labels = (steps: { label: string; state: string }[]) =>
  steps.map((s) => `${s.label}:${s.state}`)

describe("emailJourney", () => {
  it("follows the trip, folds repeated opens into one step with a count, and orders by the trip", () => {
    const steps = emailJourney({
      created_at: at(0),
      scheduled_at: null,
      status: "sent",
      events: [
        { type: "delivered", occurred_at: at(1) },
        // A provider clock a moment off: Delivered stamped before Sent, drawn after it.
        { type: "sent", occurred_at: at(2) },
        { type: "opened", occurred_at: at(5) },
        { type: "opened", occurred_at: at(6) },
        { type: "opened", occurred_at: at(9) },
        { type: "clicked", occurred_at: at(7) },
      ],
    })
    expect(labels(steps)).toEqual([
      "Queued:done",
      "Sent:done",
      "Delivered:done",
      "Opened:done",
      "Clicked:done",
    ])
    expect(steps.find((s) => s.key === "opened")).toMatchObject({ count: 3, at: at(5) })
  })

  it("expects delivery while in flight, and nothing after a bounce", () => {
    expect(
      labels(
        emailJourney({
          created_at: at(0),
          scheduled_at: null,
          status: "sent",
          events: [{ type: "sent", occurred_at: at(1) }],
        }),
      ),
    ).toEqual(["Queued:done", "Sent:done", "Delivered:current"])
    expect(
      labels(
        emailJourney({
          created_at: at(0),
          scheduled_at: null,
          status: "sent",
          events: [
            { type: "sent", occurred_at: at(1) },
            { type: "bounced", occurred_at: at(2) },
          ],
        }),
      ),
    ).toEqual(["Queued:done", "Sent:done", "Bounced:done"])
    expect(
      labels(
        emailJourney({
          created_at: at(0),
          scheduled_at: null,
          status: "queued",
          events: [],
        }),
      ),
    ).toEqual(["Queued:done", "Sent:pending", "Delivered:pending"])
  })

  it("ends a canceled email at Canceled", () => {
    const steps = emailJourney({
      created_at: at(0),
      scheduled_at: at(60),
      status: "canceled",
      events: [],
    })
    expect(steps.map((s) => s.label)).toEqual(["Queued", "Scheduled", "Canceled"])
  })
})

describe("domainJourney", () => {
  const records = (...statuses: string[]) => statuses.map((status) => ({ status }))

  it("is three steps done once verified, with the verification time", () => {
    const steps = domainJourney({
      status: "verified",
      created_at: at(0),
      verified_at: at(7),
      records: records("verified", "verified"),
    })
    expect(labels(steps)).toEqual([
      "Created:done",
      "Records validated:done",
      "Verified:done",
    ])
    expect(steps[2]!.at).toBe(at(7))
  })

  it("says partially verified when some records are still missing", () => {
    const steps = domainJourney({
      status: "verified",
      created_at: at(0),
      records: records("verified", "pending"),
    })
    expect(steps[2]!.label).toBe("Partially verified")
  })

  it("counts the records found while pending, and shows the last check", () => {
    const steps = domainJourney({
      status: "pending",
      created_at: at(0),
      dns_checked_at: at(3),
      records: records("verified", "verified", "pending"),
    })
    expect(labels(steps)).toEqual([
      "Created:done",
      "2 of 3 records found:current",
      "Verifying domain:pending",
    ])
    expect(steps[1]).toMatchObject({ at: at(3), note: "Last checked" })
  })

  it("is checking DNS, not idle, before any record is found", () => {
    const steps = domainJourney({
      status: "not_started",
      created_at: at(0),
      records: records("pending", "pending"),
    })
    expect(labels(steps)).toEqual([
      "Created:done",
      "Checking DNS:current",
      "Verifying domain:pending",
    ])
  })

  it("moves the step in progress to verifying once every record is found", () => {
    const steps = domainJourney({
      status: "pending",
      created_at: at(0),
      records: records("verified", "verified"),
    })
    expect(labels(steps)).toEqual([
      "Created:done",
      "Records validated:done",
      "Verifying domain:current",
    ])
  })

  it("names a failure and a displaced domain", () => {
    expect(
      domainJourney({
        status: "failed",
        created_at: at(0),
        records: records("failed"),
      })[2]!.label,
    ).toBe("Failed")
    expect(
      domainJourney({
        status: "failed",
        created_at: at(0),
        displaced_at: at(9),
        records: records("verified"),
      })[2]!.label,
    ).toBe("Verified elsewhere")
  })
})

describe("broadcastJourney", () => {
  it("goes from created through sending to sent", () => {
    expect(
      labels(
        broadcastJourney({
          status: "sent",
          created_at: at(0),
          scheduled_at: null,
          sent_at: at(5),
          recipient_count: 3,
        }),
      ),
    ).toEqual(["Created:done", "Sending:done", "Sent:done"])
    expect(
      labels(
        broadcastJourney({
          status: "scheduled",
          created_at: at(0),
          scheduled_at: at(60),
          sent_at: null,
          recipient_count: null,
        }),
      ),
    ).toEqual(["Created:done", "Scheduled:current", "Sending:pending", "Sent:pending"])
  })
})
