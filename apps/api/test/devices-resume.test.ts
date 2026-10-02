import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import { resume, type ResumeClerk, type ResumeUser } from "../src/devices/resume.js"
import type { DeviceRow, DeviceStore, Found } from "../src/devices/store.js"
import { isPresentable } from "../src/devices/store.js"
import { clerkFreshAuth } from "../src/middleware/session.js"

/**
 * Pressing a saved account (#192).
 *
 * ⚠ THE FAILURE TO WATCH IS LETTING SOMEBODY IN, so most of these pin the
 * cases that must NOT produce a ticket: a sign-out, a copied cookie, a banned
 * account, and an account whose passkey should be asked for instead.
 */

const PRESENTED = {
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
  secret: "s".repeat(43),
}
const ROW: DeviceRow = { id: PRESENTED.id, userId: "user_1", sessionId: "sess_1" }

const PLAIN: ResumeUser = {
  banned: false,
  locked: false,
  hasPasskey: false,
  twoFactor: false,
}

function harness(opts: {
  found?: Found
  user?: ResumeUser | null
  session?: string | null
  ticketFails?: boolean
}) {
  const calls = {
    revoked: [] as string[],
    rotated: [] as string[],
    resumes: 0,
    tickets: 0,
  }
  const store = {
    find: async () => opts.found ?? { kind: "ok", row: ROW },
    rotate: async (id: string) => {
      calls.rotated.push(id)
      return "new-secret"
    },
    recordResume: async () => {
      calls.resumes += 1
    },
    revoke: async (id: string) => {
      calls.revoked.push(id)
    },
  } as unknown as DeviceStore
  const clerk: ResumeClerk = {
    user: async () => (opts.user === undefined ? PLAIN : opts.user),
    sessionStatus: async () => (opts.session === undefined ? "expired" : opts.session),
    signInToken: async () => {
      if (opts.ticketFails) throw new Error("clerk down")
      calls.tickets += 1
      return "ticket_1"
    },
  }
  return { store, clerk, calls }
}

describe("resume", () => {
  it("expired session, no 2FA: straight in, and the secret rotates", async () => {
    const h = harness({})
    expect(await resume(PRESENTED, h)).toEqual({
      outcome: "ticket",
      ticket: "ticket_1",
      secret: "new-secret",
      secondFactor: false,
    })
    expect(h.calls.rotated).toEqual([ROW.id])
    expect(h.calls.resumes).toBe(1)
  })

  it("expired session with 2FA and no passkey: a ticket, flagged for the code", async () => {
    const h = harness({ user: { ...PLAIN, twoFactor: true } })
    expect(await resume(PRESENTED, h)).toMatchObject({
      outcome: "ticket",
      secondFactor: true,
    })
  })

  it("expired session with 2FA and a passkey: the passkey wins", async () => {
    const h = harness({ user: { ...PLAIN, twoFactor: true, hasPasskey: true } })
    expect(await resume(PRESENTED, h)).toEqual({ outcome: "passkey" })
    expect(h.calls.tickets).toBe(0)
  })

  for (const status of ["ended", "removed", "revoked", "replaced", null]) {
    it(`session ${String(status)}: never a ticket`, async () => {
      const withPasskey = harness({
        session: status,
        user: { ...PLAIN, hasPasskey: true },
      })
      expect(await resume(PRESENTED, withPasskey)).toEqual({ outcome: "passkey" })

      const without = harness({ session: status })
      expect(await resume(PRESENTED, without)).toEqual({ outcome: "signin" })
      expect(without.calls.tickets).toBe(0)
    })
  }

  it("no session on record counts as signed out", async () => {
    const h = harness({ found: { kind: "ok", row: { ...ROW, sessionId: null } } })
    expect(await resume(PRESENTED, h)).toEqual({ outcome: "signin" })
  })

  it("a copied cookie revokes the row", async () => {
    const h = harness({ found: { kind: "copied", row: ROW } })
    expect(await resume(PRESENTED, h)).toEqual({ outcome: "forget" })
    expect(h.calls.revoked).toEqual([ROW.id])
  })

  it("a second tab racing the first is neither trusted nor punished", async () => {
    const h = harness({ found: { kind: "raced", row: ROW } })
    expect(await resume(PRESENTED, h)).toEqual({ outcome: "signin" })
    expect(h.calls.revoked).toEqual([])
  })

  it("a deleted or banned user is forgotten", async () => {
    expect(await resume(PRESENTED, harness({ user: null }))).toEqual({
      outcome: "forget",
    })
    expect(
      await resume(PRESENTED, harness({ user: { ...PLAIN, banned: true } })),
    ).toEqual({
      outcome: "forget",
    })
  })

  it("a locked account goes to the ordinary flow", async () => {
    expect(
      await resume(PRESENTED, harness({ user: { ...PLAIN, locked: true } })),
    ).toEqual({
      outcome: "signin",
    })
  })

  it("Clerk failing to mint leaves the secret alone", async () => {
    const h = harness({ ticketFails: true })
    await expect(resume(PRESENTED, h)).rejects.toThrow()
    expect(h.calls.rotated).toEqual([])
  })
})

describe("what counts as a presented device", () => {
  it("needs a uuid and a plausible secret", () => {
    expect(isPresentable(PRESENTED)).toBe(true)
    expect(isPresentable({ ...PRESENTED, id: "dev_1" })).toBe(false)
    expect(isPresentable({ ...PRESENTED, secret: "short" })).toBe(false)
    expect(isPresentable(null)).toBe(false)
  })
})

describe("the routes", () => {
  it("answer 501 when not configured", async () => {
    const res = await createApp().request("/devices/resume", { method: "POST" })
    expect(res.status).toBe(501)
  })

  it("refuse to remember without an auth origin", async () => {
    const h = harness({})
    const app = createApp({ devices: { store: h.store, clerk: h.clerk } })
    const res = await app.request("/devices/remember", { method: "POST", body: "{}" })
    expect(res.status).toBe(501)
  })

  it("an outage on resume is a 503, never a forget", async () => {
    const h = harness({ ticketFails: true })
    const app = createApp({ devices: { store: h.store, clerk: h.clerk } })
    const res = await app.request("/devices/resume", {
      method: "POST",
      body: JSON.stringify(PRESENTED),
    })
    expect(res.status).toBe(503)
  })

  it("remember binds the verified session, not anything in the body", async () => {
    let got: unknown
    const store = {
      remember: async (input: unknown) => {
        got = input
        return { id: PRESENTED.id, secret: "fresh" }
      },
    } as unknown as DeviceStore
    const app = createApp({
      devices: {
        store,
        clerk: harness({}).clerk,
        identify: async () => ({
          status: "signed-in",
          userId: "user_1",
          sessionId: "sess_9",
        }),
      },
    })
    const res = await app.request("/devices/remember", {
      method: "POST",
      body: JSON.stringify({
        prior: [PRESENTED, { id: "x", secret: "y" }],
        userId: "user_evil",
      }),
    })
    expect(res.status).toBe(200)
    expect(got).toEqual({ userId: "user_1", sessionId: "sess_9", prior: [PRESENTED] })
  })
})

describe("step-up after a resume", () => {
  // A stand-in for `authenticateRequest`: always signed in, `has()` always
  // passes, `fva` as given - the shape a resumed no-2FA session has.
  const clerkWith = (fva: [number, number]) =>
    ({
      authenticateRequest: async () => ({
        isAuthenticated: true,
        toAuth: () => ({ userId: "user_1", sessionClaims: { fva }, has: () => true }),
      }),
    }) as unknown as Parameters<typeof clerkFreshAuth>[0]

  const request = new Request("https://api.test/")

  it("is stale when the first factor was the resume", async () => {
    const read = clerkFreshAuth(clerkWith([0, -1]), { resumedNear: async () => true })
    expect(await read(request)).toEqual({ status: "stale" })
  })

  it("is fresh once the person proved something for real", async () => {
    const read = clerkFreshAuth(clerkWith([0, -1]), { resumedNear: async () => false })
    expect(await read(request)).toEqual({ status: "fresh" })
  })

  it("trusts a second factor the resumed session went on to pass", async () => {
    let asked = false
    const read = clerkFreshAuth(clerkWith([0, 0]), {
      resumedNear: async () => {
        asked = true
        return true
      },
    })
    expect(await read(request)).toEqual({ status: "fresh" })
    expect(asked).toBe(false)
  })

  it("an unreachable database is unknown, not fresh", async () => {
    const read = clerkFreshAuth(clerkWith([0, -1]), {
      resumedNear: async () => {
        throw new Error("db down")
      },
    })
    expect(await read(request)).toEqual({ status: "unknown" })
  })
})
