import { describe, expect, it } from "bun:test"
import { ACME, GLOBEX, as, people, world } from "./team-inbox-fixtures.js"

/**
 * Team inboxes (B8): who can see and change which, how membership follows the
 * workspace, and what deleting one takes with it.
 */

async function withSupport() {
  const w = world()
  const made = await w.service.create(as("alice"), {
    address: "support@acme.test",
    members: ["bob@acme.test", "carol@acme.test"],
  })
  expect(made.status).toBe("ok")
  return w
}

describe("who sees which team inbox", () => {
  it("shows an admin every team inbox of the workspace", async () => {
    const w = await withSupport()
    await w.service.create(as("alice"), {
      address: "sales@acme.test",
      members: ["carol@acme.test"],
    })

    const listed = await w.service.list(as("alice"))
    expect(listed.map((i) => i.address).sort()).toEqual([
      "sales@acme.test",
      "support@acme.test",
    ])
  })

  it("shows a member only the inboxes they are in", async () => {
    const w = await withSupport()
    await w.service.create(as("alice"), {
      address: "sales@acme.test",
      members: ["carol@acme.test"],
    })

    expect((await w.service.list(as("bob"))).map((i) => i.address)).toEqual([
      "support@acme.test",
    ])
    expect((await w.service.list(as("carol"))).map((i) => i.address).sort()).toEqual([
      "sales@acme.test",
      "support@acme.test",
    ])
  })

  it("shows a workspace member who is in no inbox nothing", async () => {
    const w = await withSupport()
    expect(await w.service.list(as("dave"))).toEqual([])
  })

  it("answers 'not found' to a non-member rather than 'forbidden'", async () => {
    const w = await withSupport()
    expect(await w.service.get(as("dave"), "support@acme.test")).toBeNull()
    expect(await w.service.get(as("dave"), "nobody@acme.test")).toBeNull()
    expect((await w.service.get(as("bob"), "support@acme.test"))?.address).toBe(
      "support@acme.test",
    )
    expect((await w.service.get(as("alice"), "support@acme.test"))?.members).toEqual([
      { address: "bob@acme.test" },
      { address: "carol@acme.test" },
    ])
  })

  it("never shows one workspace another's inboxes", async () => {
    const w = await withSupport()
    expect(await w.service.list(as("zed", GLOBEX))).toEqual([])
    expect(await w.service.get(as("zed", GLOBEX), "support@acme.test")).toBeNull()
    expect(
      await w.service.setMembers(as("zed", GLOBEX), "support@acme.test", [
        "zed@globex.test",
      ]),
    ).toEqual({ status: "missing" })
    expect(await w.service.remove(as("zed", GLOBEX), "support@acme.test")).toBe(
      "missing",
    )
    expect(w.rows).toHaveLength(1)
  })
})

describe("who may change a team inbox", () => {
  it("refuses a member every write and changes nothing", async () => {
    const w = await withSupport()

    expect(
      await w.service.create(as("bob"), {
        address: "sales@acme.test",
        members: ["bob@acme.test"],
      }),
    ).toEqual({ status: "forbidden" })
    expect(
      await w.service.setMembers(as("bob"), "support@acme.test", ["bob@acme.test"]),
    ).toEqual({ status: "forbidden" })
    expect(await w.service.remove(as("bob"), "support@acme.test")).toBe("forbidden")

    expect(w.rows).toHaveLength(1)
    expect(w.rows[0]!.members).toHaveLength(2)
    expect(w.destroyed).toEqual([])
  })

  it("needs a team workspace", async () => {
    const w = world()
    expect(
      await w.service.create(
        { tenantId: ACME.tenantId, userId: people.alice.userId },
        { address: "support@acme.test", members: ["bob@acme.test"] },
      ),
    ).toEqual({ status: "no_org" })
  })
})

describe("creating one", () => {
  it("stores it under the whole address, owned by the workspace", async () => {
    const w = await withSupport()
    expect(w.rows[0]).toMatchObject({
      name: "support@acme.test",
      address: "support@acme.test",
      tenantId: ACME.tenantId,
    })
  })

  it("refuses a domain the workspace has not verified", async () => {
    const w = world()
    const outcome = await w.service.create(as("alice"), {
      address: "support@globex.test",
      members: ["bob@acme.test"],
    })
    expect(outcome).toMatchObject({ status: "rejected" })
    expect(w.rows).toHaveLength(0)
  })

  it("refuses an address that is already a mailbox, an alias or an inbox", async () => {
    const w = await withSupport()
    for (const address of ["bob@acme.test", "alias@acme.test", "support@acme.test"]) {
      expect(
        await w.service.create(as("alice"), { address, members: ["carol@acme.test"] }),
      ).toMatchObject({ status: "conflict" })
    }
    expect(w.rows).toHaveLength(1)
  })

  it("answers a conflict when somebody takes the address mid-request", async () => {
    const w = world()
    w.store.addressTaken = async () => false
    await w.service.create(as("alice"), {
      address: "support@acme.test",
      members: ["bob@acme.test"],
    })
    expect(
      await w.service.create(as("alice"), {
        address: "support@acme.test",
        members: ["carol@acme.test"],
      }),
    ).toMatchObject({ status: "conflict" })
  })

  it("only lets in people who are in the workspace and have an active mailbox", async () => {
    const w = world()
    const create = (member: string) =>
      w.service.create(as("alice"), { address: "support@acme.test", members: [member] })

    // A mailbox on the workspace's domain whose owner is not in its organization.
    expect(await create("erin@acme.test")).toMatchObject({
      status: "rejected",
      reason: "erin@acme.test is not a member of this workspace.",
    })
    // In the workspace, but suspended.
    expect(await create("idle@acme.test")).toMatchObject({ status: "rejected" })
    // No such mailbox at all.
    expect(await create("ghost@acme.test")).toMatchObject({ status: "rejected" })
    expect(w.rows).toHaveLength(0)
  })
})

describe("membership follows the workspace", () => {
  it("replaces the set when an admin changes it", async () => {
    const w = await withSupport()
    const outcome = await w.service.setMembers(as("alice"), "support@acme.test", [
      "carol@acme.test",
      "dave@acme.test",
    ])
    expect(outcome).toMatchObject({ status: "ok" })
    expect(w.rows[0]!.members.map((m) => m.address)).toEqual([
      "carol@acme.test",
      "dave@acme.test",
    ])

    // The one who was added now sees it; the one who was dropped no longer does.
    expect((await w.service.list(as("dave"))).map((i) => i.address)).toEqual([
      "support@acme.test",
    ])
    expect(await w.service.list(as("bob"))).toEqual([])
  })

  it("refuses to add someone who is not in the workspace, keeping the old set", async () => {
    const w = await withSupport()
    const outcome = await w.service.setMembers(as("alice"), "support@acme.test", [
      "erin@acme.test",
    ])
    expect(outcome).toMatchObject({ status: "rejected" })
    expect(w.rows[0]!.members.map((m) => m.address)).toEqual([
      "bob@acme.test",
      "carol@acme.test",
    ])
  })

  it("answers 'missing' for an inbox that does not exist", async () => {
    const w = world()
    expect(
      await w.service.setMembers(as("alice"), "nope@acme.test", ["bob@acme.test"]),
    ).toEqual({ status: "missing" })
  })

  it("takes a removed workspace member out of every inbox, and only theirs", async () => {
    const w = await withSupport()
    await w.service.create(as("alice"), {
      address: "sales@acme.test",
      members: ["bob@acme.test", "carol@acme.test"],
    })

    const changed = await w.service.onMemberRemoved(ACME.tenantId, people.bob.userId)

    expect(changed.sort()).toEqual(["sales@acme.test", "support@acme.test"])
    expect(await w.service.list(as("bob"))).toEqual([])
    expect((await w.service.list(as("carol"))).map((i) => i.address).sort()).toEqual([
      "sales@acme.test",
      "support@acme.test",
    ])
  })

  it("leaves another workspace's inboxes alone", async () => {
    const w = await withSupport()
    expect(await w.service.onMemberRemoved(GLOBEX.tenantId, people.bob.userId)).toEqual(
      [],
    )
    expect(w.rows[0]!.members).toHaveLength(2)
  })

  it("is harmless to repeat", async () => {
    const w = await withSupport()
    await w.service.onMemberRemoved(ACME.tenantId, people.bob.userId)
    expect(await w.service.onMemberRemoved(ACME.tenantId, people.bob.userId)).toEqual(
      [],
    )
  })
})

/**
 * ⚠ THE DIRECTORY ROW ALONE DOES NOT TAKE ACCESS AWAY (probed on prod: still
 * there after 15 minutes), so every removal revokes in Stalwart first and only
 * then changes the rows.
 */
describe("removing a member revokes their access in Stalwart", () => {
  it("revokes exactly the people an admin dropped from the set", async () => {
    const w = await withSupport()
    await w.service.setMembers(as("alice"), "support@acme.test", [
      "carol@acme.test",
      "dave@acme.test",
    ])
    expect(w.revoked).toEqual([
      { team: "support@acme.test", members: ["bob@acme.test"] },
    ])
  })

  it("revokes nobody when the set only grows", async () => {
    const w = await withSupport()
    await w.service.setMembers(as("alice"), "support@acme.test", [
      "bob@acme.test",
      "carol@acme.test",
      "dave@acme.test",
    ])
    expect(w.revoked).toEqual([])
  })

  it("keeps the old set when the revoke fails, so the change can be retried", async () => {
    const w = await withSupport()
    w.failRevoke.on = true
    const outcome = await w.service
      .setMembers(as("alice"), "support@acme.test", ["carol@acme.test"])
      .then(
        () => "ok",
        () => "threw",
      )
    expect(outcome).toBe("threw")
    expect(w.rows[0]!.members.map((m) => m.address)).toEqual([
      "bob@acme.test",
      "carol@acme.test",
    ])
  })

  it("revokes a removed workspace member from every inbox they were in", async () => {
    const w = await withSupport()
    await w.service.create(as("alice"), {
      address: "sales@acme.test",
      members: ["bob@acme.test"],
    })
    await w.service.onMemberRemoved(ACME.tenantId, people.bob.userId)
    expect(w.revoked.map((r) => r.team).sort()).toEqual([
      "sales@acme.test",
      "support@acme.test",
    ])
    expect(w.revoked.every((r) => r.members.join() === "bob@acme.test")).toBe(true)
  })

  it("keeps a removed workspace member's rows when the revoke fails", async () => {
    const w = await withSupport()
    w.failRevoke.on = true
    const outcome = await w.service
      .onMemberRemoved(ACME.tenantId, people.bob.userId)
      .then(
        () => "ok",
        () => "threw",
      )
    expect(outcome).toBe("threw")
    expect(w.rows[0]!.members.map((m) => m.address)).toContain("bob@acme.test")
  })
})

describe("deleting one", () => {
  it("destroys the account before the rows, then nobody can reach it", async () => {
    const w = await withSupport()

    expect(await w.service.remove(as("alice"), "support@acme.test")).toBe("ok")

    expect(w.destroyed).toEqual(["support@acme.test"])
    expect(w.rows).toHaveLength(0)
    expect(await w.service.list(as("alice"))).toEqual([])
    expect(await w.service.list(as("bob"))).toEqual([])
    expect(await w.service.get(as("bob"), "support@acme.test")).toBeNull()
  })

  it("keeps the rows when the account could not be destroyed, so it can be retried", async () => {
    const w = await withSupport()
    w.failDestroy.on = true

    const failed = await w.service.remove(as("alice"), "support@acme.test").then(
      () => "ok",
      (e: Error) => e.message,
    )
    expect(failed).toBe("stalwart is down")
    expect(w.rows).toHaveLength(1)
    expect((await w.service.list(as("bob"))).length).toBe(1)

    w.failDestroy.on = false
    expect(await w.service.remove(as("alice"), "support@acme.test")).toBe("ok")
    expect(w.rows).toHaveLength(0)
  })

  it("answers 'missing' twice", async () => {
    const w = await withSupport()
    await w.service.remove(as("alice"), "support@acme.test")
    expect(await w.service.remove(as("alice"), "support@acme.test")).toBe("missing")
  })

  it("lets the address be made again with nobody from before in it", async () => {
    const w = await withSupport()
    await w.service.remove(as("alice"), "support@acme.test")
    await w.service.create(as("alice"), {
      address: "support@acme.test",
      members: ["dave@acme.test"],
    })
    expect(await w.service.list(as("bob"))).toEqual([])
    expect((await w.service.list(as("dave"))).length).toBe(1)
  })

  it("deletes every inbox of a workspace that is gone, and no other's", async () => {
    const w = await withSupport()
    await w.service.create(as("alice"), {
      address: "sales@acme.test",
      members: ["carol@acme.test"],
    })

    const gone = await w.service.onWorkspaceDeleted(ACME.tenantId)

    expect(gone.sort()).toEqual(["sales@acme.test", "support@acme.test"])
    expect(w.destroyed.sort()).toEqual(["sales@acme.test", "support@acme.test"])
    expect(w.rows).toHaveLength(0)
  })
})
