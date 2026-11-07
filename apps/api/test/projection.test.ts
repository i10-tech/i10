import { describe, expect, it } from "bun:test"
import { projectUser, type ClerkUser } from "../src/projection/clerk-user.js"

const HOSTED = ["i10.tech", "mail.i10.tech"]

function user(over: Partial<ClerkUser> = {}): ClerkUser {
  return {
    id: "user_1",
    first_name: "Alice",
    last_name: "Example",
    updated_at: Date.UTC(2026, 7, 30, 9, 0, 0),
    email_addresses: [],
    ...over,
  }
}

function addr(id: string, email: string, status = "verified") {
  return { id, email_address: email, verification: { status } }
}

describe("projectUser", () => {
  it("projects a hosted address to a mailbox", () => {
    const m = projectUser(
      user({
        email_addresses: [addr("idn_1", "alice@i10.tech")],
        primary_email_address_id: "idn_1",
      }),
      HOSTED,
    )
    expect(m).toEqual({
      clerkUserId: "user_1",
      email: "alice@i10.tech",
      aliases: [],
      displayName: "Alice Example",
      clerkUpdatedAt: new Date(Date.UTC(2026, 7, 30, 9, 0, 0)),
      banned: null,
      locked: null,
      lockedUntil: null,
    })
  })

  // ⚠ CLERK'S verify_password ANSWERS 200 `verified: true` FOR A BANNED USER AND
  // A LOCKED ONE (probed on the dev instance 2026-11-07), so authd refuses them
  // from what is projected here. The payload shapes below are the probe's.
  describe("ban and lock", () => {
    const hosted = {
      email_addresses: [addr("idn_1", "alice@i10.tech")],
      primary_email_address_id: "idn_1",
    }
    const NOW = new Date("2026-11-07T12:00:00Z")

    it("projects a ban", () => {
      const m = projectUser(
        user({ ...hosted, banned: true, locked: false }),
        HOSTED,
        NOW,
      )
      expect(m).toMatchObject({ banned: true, locked: false, lockedUntil: null })
    })

    it("projects a lock with the end Clerk reports, counted from now", () => {
      const m = projectUser(
        user({
          ...hosted,
          banned: false,
          locked: true,
          lockout_expires_in_seconds: 3599,
        }),
        HOSTED,
        NOW,
      )
      expect(m).toMatchObject({
        banned: false,
        locked: true,
        lockedUntil: new Date(NOW.getTime() + 3599_000),
      })
    })

    it("a lock Clerk gives no end for is indefinite", () => {
      const m = projectUser(user({ ...hosted, locked: true }), HOSTED, NOW)
      expect(m).toMatchObject({ locked: true, lockedUntil: null })
    })

    it("an unlocked user carries no end, whatever the payload says", () => {
      const m = projectUser(
        user({ ...hosted, locked: false, lockout_expires_in_seconds: 99 }),
        HOSTED,
        NOW,
      )
      expect(m).toMatchObject({ locked: false, lockedUntil: null })
    })

    // ⚠ UNKNOWN IS NOT "NO": the writer keeps the row's value for null, so a payload
    // that omitted the fields can never lift a ban.
    it("a payload without the fields says nothing, which is not the same as no", () => {
      expect(projectUser(user(hosted), HOSTED, NOW)).toMatchObject({
        banned: null,
        locked: null,
        lockedUntil: null,
      })
    })

    it("an explicit false is a lift", () => {
      expect(
        projectUser(user({ ...hosted, banned: false, locked: false }), HOSTED, NOW),
      ).toMatchObject({ banned: false, locked: false })
    })
  })

  // ⚠ The guard that stops Stalwart swallowing other people's mail. Most users
  // sign up with an address we do not host; projecting it would make Stalwart
  // treat gmail.com as a local domain.
  it("returns null for a user with no hosted address", () => {
    const m = projectUser(
      user({
        email_addresses: [addr("idn_1", "alice@gmail.com")],
        primary_email_address_id: "idn_1",
      }),
      HOSTED,
    )
    expect(m).toBeNull()
  })

  it("ignores unhosted addresses but keeps hosted ones", () => {
    const m = projectUser(
      user({
        email_addresses: [
          addr("idn_1", "alice@gmail.com"),
          addr("idn_2", "alice@i10.tech"),
        ],
        primary_email_address_id: "idn_1", // primary is NOT hosted
      }),
      HOSTED,
    )
    expect(m?.email).toBe("alice@i10.tech")
    expect(m?.aliases).toEqual([])
  })

  it("excludes unverified addresses", () => {
    const m = projectUser(
      user({ email_addresses: [addr("idn_1", "alice@i10.tech", "unverified")] }),
      HOSTED,
    )
    expect(m).toBeNull()
  })

  it("prefers Clerk's primary when it is hosted", () => {
    const m = projectUser(
      user({
        email_addresses: [addr("idn_1", "aaa@i10.tech"), addr("idn_2", "zzz@i10.tech")],
        primary_email_address_id: "idn_2",
      }),
      HOSTED,
    )
    expect(m?.email).toBe("zzz@i10.tech")
    expect(m?.aliases).toEqual(["aaa@i10.tech"])
  })

  // An arbitrary pick would make the mailbox address flap between webhook
  // deliveries, and that address is the user's identity.
  it("picks deterministically when no primary is hosted", () => {
    const addresses = [addr("idn_1", "zzz@i10.tech"), addr("idn_2", "aaa@i10.tech")]
    const forwards = projectUser(user({ email_addresses: addresses }), HOSTED)
    const backwards = projectUser(
      user({ email_addresses: [...addresses].reverse() }),
      HOSTED,
    )
    expect(forwards?.email).toBe("aaa@i10.tech")
    expect(backwards?.email).toBe(forwards?.email)
  })

  it("normalises case and whitespace", () => {
    const m = projectUser(
      user({ email_addresses: [addr("idn_1", "  Alice@I10.Tech  ")] }),
      HOSTED,
    )
    expect(m?.email).toBe("alice@i10.tech")
  })

  it("matches a subdomain only when it is itself hosted", () => {
    expect(
      projectUser(user({ email_addresses: [addr("i", "a@mail.i10.tech")] }), HOSTED),
    ).not.toBeNull()
    // A lookalike must not slip through a suffix comparison.
    expect(
      projectUser(user({ email_addresses: [addr("i", "a@noti10.tech")] }), HOSTED),
    ).toBeNull()
    expect(
      projectUser(user({ email_addresses: [addr("i", "a@evil-i10.tech")] }), HOSTED),
    ).toBeNull()
  })

  it("tolerates a missing name and a missing timestamp", () => {
    const m = projectUser(
      {
        id: "user_2",
        email_addresses: [addr("idn_1", "b@i10.tech")],
        primary_email_address_id: "idn_1",
      },
      HOSTED,
    )
    expect(m?.displayName).toBe("")
    expect(m?.clerkUpdatedAt).toBeNull()
  })

  it("accepts hosted domains written with a leading @", () => {
    const m = projectUser(user({ email_addresses: [addr("i", "a@i10.tech")] }), [
      "@i10.tech",
    ])
    expect(m?.email).toBe("a@i10.tech")
  })
})
