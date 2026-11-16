import { describe, expect, it, mock } from "bun:test"
import type { ClerkClient } from "@clerk/backend"
import { clerkAddressRemoval } from "../src/mailboxes/clerk.js"

/**
 * Taking a deleted mailbox's addresses off the person's Clerk user: only the ones
 * named, the primary moved first, the last one never removed, and every step safe to
 * repeat after a crash.
 */

interface Email {
  id: string
  emailAddress: string
  verification: { status: string } | null
}

const email = (id: string, address: string, verified = true): Email => ({
  id,
  emailAddress: address,
  verification: { status: verified ? "verified" : "unverified" },
})

function clerkWith(
  user: { emailAddresses: Email[]; primaryEmailAddressId: string | null } | "gone",
  over: { deleteFails?: number } = {},
) {
  const calls: string[] = []
  let failures = over.deleteFails ?? 0
  const client = {
    users: {
      getUser: async () => {
        if (user === "gone")
          throw Object.assign(new Error("not found"), { status: 404 })
        return user
      },
      updateUser: mock(
        async (_id: string, patch: { primaryEmailAddressID: string }) => {
          calls.push(`primary:${patch.primaryEmailAddressID}`)
          if (user !== "gone") user.primaryEmailAddressId = patch.primaryEmailAddressID
        },
      ),
    },
    emailAddresses: {
      deleteEmailAddress: mock(async (id: string) => {
        if (failures > 0) {
          failures--
          throw Object.assign(new Error("boom"), { status: 500 })
        }
        calls.push(`delete:${id}`)
        if (user !== "gone")
          user.emailAddresses = user.emailAddresses.filter((e) => e.id !== id)
      }),
    },
  } as unknown as ClerkClient
  return { removal: clerkAddressRemoval(client), calls }
}

describe("removing a mailbox's addresses from Clerk", () => {
  it("removes only the addresses named, whatever their case", async () => {
    const { removal, calls } = clerkWith({
      primaryEmailAddressId: "e1",
      emailAddresses: [
        email("e1", "ada@gmail.test"),
        email("e2", "Ada@Acme.test"),
        email("e3", "other@acme.test"),
      ],
    })
    expect(await removal.remove("user_ada", ["ada@acme.test"])).toEqual({ kept: [] })
    expect(calls).toEqual(["delete:e2"])
  })

  it("moves the primary to another verified address first, never to an unverified one", async () => {
    const { removal, calls } = clerkWith({
      primaryEmailAddressId: "e2",
      emailAddresses: [
        email("e1", "typed@gmail.test", false),
        email("e2", "ada@acme.test"),
        email("e3", "ada@gmail.test"),
      ],
    })
    expect(await removal.remove("user_ada", ["ada@acme.test"])).toEqual({ kept: [] })
    expect(calls).toEqual(["primary:e3", "delete:e2"])
  })

  it("leaves an address that is the person's only sign-in address, and says so", async () => {
    const { removal, calls } = clerkWith({
      primaryEmailAddressId: "e1",
      emailAddresses: [
        email("e1", "ada@acme.test"),
        email("e2", "ada@gmail.test", false),
      ],
    })
    expect(await removal.remove("user_ada", ["ada@acme.test"])).toEqual({
      kept: ["ada@acme.test"],
    })
    expect(calls).toEqual([])
  })

  it("is done when the address or the user is already gone", async () => {
    expect(
      await clerkWith({
        primaryEmailAddressId: "e1",
        emailAddresses: [email("e1", "ada@gmail.test")],
      }).removal.remove("user_ada", ["ada@acme.test"]),
    ).toEqual({ kept: [] })
    expect(
      await clerkWith("gone").removal.remove("user_ada", ["ada@acme.test"]),
    ).toEqual({ kept: [] })
  })

  it("repeats safely after a failure part way", async () => {
    const world = clerkWith(
      {
        primaryEmailAddressId: "e3",
        emailAddresses: [
          email("e1", "ada@acme.test"),
          email("e2", "ada.alias@acme.test"),
          email("e3", "ada@gmail.test"),
        ],
      },
      { deleteFails: 1 },
    )
    const both = ["ada@acme.test", "ada.alias@acme.test"]
    await world.removal.remove("user_ada", both).then(
      () => {
        throw new Error("expected the first run to fail")
      },
      () => {},
    )
    expect(await world.removal.remove("user_ada", both)).toEqual({ kept: [] })
    expect(world.calls).toEqual(["delete:e1", "delete:e2"])
  })
})
