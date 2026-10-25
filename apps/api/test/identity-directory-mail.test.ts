import { describe, expect, it } from "bun:test"
import {
  aliasesOf,
  chooseNext,
  runDeletion,
  runDue,
  setGroupMail,
  suspendMailbox,
} from "../src/identity/directory-mail.js"
import { TENANT } from "./identity-fakes.js"
import { LEAVER, MANAGER, memoryMail } from "./identity-mail-fakes.js"

/**
 * What happens to a mailbox once its person is switched off, and the lists
 * (#344 slice B, sso.md 2.8). Every refusal is proved before the thing that
 * works; `memoryMail` answers authd's two questions the way its SQL and bind do.
 */

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date("2026-10-21T10:00:00Z")
const ADMIN = "user_admin"

function world(
  over: Parameters<typeof memoryMail>[0] = {},
  manager: "none" | "good" | Record<string, unknown> = "none",
) {
  const m = memoryMail({ members: [MANAGER], ...over })
  m.setNow(T0)
  m.give(LEAVER, "ada@acme.test")
  m.give(MANAGER, "grace@acme.test")
  if (manager === "good")
    m.managers.set(LEAVER, {
      status: "found",
      clerkUserId: MANAGER,
      active: true,
      address: "grace@acme.test",
      suspended: false,
    })
  else if (manager !== "none") m.managers.set(LEAVER, manager as never)
  return m
}
const suspend = (m: ReturnType<typeof memoryMail>) =>
  suspendMailbox(m.deps, {
    tenantId: TENANT,
    clerkUserId: LEAVER,
    actorUserId: null,
    cause: "scim",
  })
const row = (m: ReturnType<typeof memoryMail>) => m.rows.get(`${TENANT}/${LEAVER}`)!

describe("forward to the manager: refused unless the manager is an active member on a hosted domain", () => {
  const found = (over: Record<string, unknown>) => ({
    status: "found" as const,
    clerkUserId: MANAGER,
    active: true,
    address: "grace@acme.test",
    suspended: false,
    ...over,
  })
  const cases: [string, Record<string, unknown> | "none", string, string[]][] = [
    ["the directory names no manager", "none", "no_manager", []],
    [
      "the manager id does not resolve to a person",
      found({ clerkUserId: null }),
      "no_manager",
      [],
    ],
    [
      "the manager is the leaver themself",
      found({ clerkUserId: LEAVER }),
      "no_manager",
      [],
    ],
    [
      "the manager is not active in a directory",
      found({ active: false }),
      "manager_not_active",
      [],
    ],
    [
      "the manager's own mailbox is suspended",
      found({ suspended: true }),
      "manager_not_active",
      [],
    ],
    [
      "the manager is not a member of the workspace",
      found({}),
      "manager_not_member",
      ["nobody"],
    ],
    ["the manager has no mailbox", found({ address: null }), "manager_not_hosted", []],
    [
      "the manager's address is on a domain the workspace does not host",
      found({ address: "grace@elsewhere.test" }),
      "manager_not_hosted",
      [],
    ],
  ]
  for (const [name, manager, reason, members] of cases)
    it(`${name}: the mailbox is suspended and kept, and the audit log says why`, async () => {
      const m = world({ default: { action: "forward_manager", days: null } })
      if (manager === "none") m.managers.delete(LEAVER)
      else m.managers.set(LEAVER, manager as never)
      if (members.length) m.members.clear()
      expect(await suspend(m)).toBe("suspended")
      expect(row(m)).toMatchObject({
        state: "suspended",
        next: "keep",
        targetUserId: null,
      })
      expect(m.canLogin(LEAVER)).toBe(false)
      expect(m.delivers("ada@acme.test")).toBe(true)
      expect(m.events.find((e) => e.type === "mailbox.suspended")?.data).toMatchObject({
        next: "keep",
        forwardRefused: reason,
      })
    })

  it("an active member on a hosted domain is the target", async () => {
    const m = world({ default: { action: "forward_manager", days: null } }, "good")
    await suspend(m)
    expect(row(m)).toMatchObject({ next: "forward_manager", targetUserId: MANAGER })
    expect(m.canLogin(LEAVER)).toBe(false)
  })
})

describe("delegate to a named member", () => {
  it("is refused for a person who is not a member, has no mailbox, or is the leaver", async () => {
    const m = world()
    await suspend(m)
    m.give("user_nomail_member", "x@acme.test")
    m.accounts.delete("user_nomail_member")
    m.members.add("user_nomail_member")
    for (const [id, reason] of [
      ["user_stranger", "delegate_not_member"],
      ["user_nomail_member", "delegate_no_mailbox"],
      [LEAVER, "delegate_is_self"],
    ] as const) {
      expect(
        await chooseNext(m.deps, {
          tenantId: TENANT,
          clerkUserId: LEAVER,
          actorUserId: ADMIN,
          choice: { next: "delegate", delegateUserId: id },
        }),
      ).toEqual({ outcome: "refused", reason })
    }
    expect(row(m).next).toBe("keep")
    expect(m.types().filter((t) => t === "mailbox.choice_refused")).toHaveLength(3)
  })

  it("names a member who has a mailbox, and audits it", async () => {
    const m = world()
    await suspend(m)
    expect(
      await chooseNext(m.deps, {
        tenantId: TENANT,
        clerkUserId: LEAVER,
        actorUserId: ADMIN,
        choice: { next: "delegate", delegateUserId: MANAGER },
      }),
    ).toEqual({ outcome: "ok", next: "delegate" })
    expect(row(m)).toMatchObject({ next: "delegate", targetUserId: MANAGER })
    expect(m.events.find((e) => e.type === "mailbox.next_chosen")).toMatchObject({
      actorUserId: ADMIN,
      data: { from: "keep", next: "delegate", targetUserId: MANAGER },
    })
  })
})

describe("the admin's pick is only for a suspended mailbox", () => {
  it("refuses to decide for a live one, and says so in the audit log", async () => {
    const m = world()
    m.rows.set(`${TENANT}/${LEAVER}`, {
      tenantId: TENANT,
      clerkUserId: LEAVER,
      address: "ada@acme.test",
      state: "active",
      suspendedAt: null,
      next: "keep",
      targetUserId: null,
      deleteAfterDays: null,
      deleteAt: null,
    })
    expect(
      await chooseNext(m.deps, {
        tenantId: TENANT,
        clerkUserId: LEAVER,
        actorUserId: ADMIN,
        choice: { next: "delete", days: 30 },
      }),
    ).toEqual({ outcome: "not_suspended" })
    expect(row(m).next).toBe("keep")
    expect(m.types()).toContain("mailbox.choice_refused")
  })
})

describe("delete after N days: never early, never while a directory says active", () => {
  const pick = (m: ReturnType<typeof memoryMail>, days: number) =>
    chooseNext(m.deps, {
      tenantId: TENANT,
      clerkUserId: LEAVER,
      actorUserId: ADMIN,
      choice: { next: "delete", days },
    })

  it("refuses fewer than 7 or more than 365 days", async () => {
    const m = world()
    await suspend(m)
    expect(await pick(m, 6)).toEqual({ outcome: "bad_days" })
    expect(await pick(m, 366)).toEqual({ outcome: "bad_days" })
    expect(await pick(m, 7.5)).toEqual({ outcome: "bad_days" })
    expect(row(m).next).toBe("keep")
    expect(m.scheduled).toEqual([])
  })

  it("refuses to schedule deletion of somebody a directory still says is active", async () => {
    const m = world({ directoryActive: [LEAVER] })
    await suspend(m)
    expect(await pick(m, 30)).toEqual({ outcome: "still_active" })
    expect(row(m).next).toBe("keep")
  })

  it("deletes NOTHING before the date, however the job or the clock behaves", async () => {
    const m = world()
    await suspend(m)
    await pick(m, 7)
    expect(row(m).deleteAt?.getTime()).toBe(T0.getTime() + 7 * DAY)
    expect(m.scheduled).toHaveLength(1)
    // The job fires early (groupMQ floors time; a promotion tick can run it first).
    m.setNow(new Date(T0.getTime() + 7 * DAY - 1000))
    const early = await runDeletion(m.deps, {
      tenantId: TENANT,
      clerkUserId: LEAVER,
      dueAt: T0.getTime() + 7 * DAY,
    })
    expect(early).toEqual({ outcome: "early", ms: 1000 })
    expect(m.accounts.has(LEAVER)).toBe(true)
    expect(m.delivers("ada@acme.test")).toBe(true)
    // And the store's own check refuses a caller whose clock runs ahead.
    expect(
      await m.store.remove(TENANT, LEAVER, new Date(T0.getTime() + 6 * DAY), {
        type: "x",
      }),
    ).toBe("not_due")
    expect(m.accounts.has(LEAVER)).toBe(true)
    expect(await runDue(m.deps, TENANT)).toBe(0)
  })

  it("holds the deletion while another enabled directory still says the person is active", async () => {
    const m = world()
    await suspend(m)
    await pick(m, 7)
    m.setNow(new Date(T0.getTime() + 8 * DAY))
    m.active.add(LEAVER)
    expect(
      await runDeletion(m.deps, {
        tenantId: TENANT,
        clerkUserId: LEAVER,
        dueAt: T0.getTime() + 7 * DAY,
      }),
    ).toEqual({ outcome: "held_active" })
    expect(m.accounts.has(LEAVER)).toBe(true)
    expect(m.types()).toContain("mailbox.deletion_held")
    expect(await runDue(m.deps, TENANT)).toBe(0)
  })

  it("deletes on the date, audited, and a plan that changed since makes the job a no-op", async () => {
    const m = world()
    await suspend(m)
    await pick(m, 7)
    m.setNow(new Date(T0.getTime() + 7 * DAY))
    expect(
      await runDeletion(m.deps, {
        tenantId: TENANT,
        clerkUserId: LEAVER,
        dueAt: T0.getTime() + 7 * DAY,
      }),
    ).toEqual({ outcome: "deleted" })
    expect(m.accounts.has(LEAVER)).toBe(false)
    expect(m.delivers("ada@acme.test")).toBe(false)
    expect(m.types()).toContain("mailbox.deleted")

    const kept = world()
    await suspend(kept)
    await pick(kept, 7)
    await chooseNext(kept.deps, {
      tenantId: TENANT,
      clerkUserId: LEAVER,
      actorUserId: ADMIN,
      choice: { next: "keep" },
    })
    kept.setNow(new Date(T0.getTime() + 30 * DAY))
    expect(
      await runDeletion(kept.deps, {
        tenantId: TENANT,
        clerkUserId: LEAVER,
        dueAt: T0.getTime() + 7 * DAY,
      }),
    ).toEqual({ outcome: "not_scheduled" })
    expect(kept.accounts.has(LEAVER)).toBe(true)
  })

  it("a default of 'delete after' is a date, not an event: suspension itself deletes nothing", async () => {
    const m = world({ default: { action: "delete_after", days: 30 } })
    expect(await suspend(m)).toBe("suspended")
    expect(m.accounts.has(LEAVER)).toBe(true)
    expect(row(m).deleteAt?.getTime()).toBe(T0.getTime() + 30 * DAY)
    expect(m.canLogin(LEAVER)).toBe(false)
  })

  it("a lost job deletes LATE through the backup run, never early", async () => {
    const m = world({ default: { action: "delete_after", days: 7 } })
    m.fail.scheduling = true
    expect(await suspend(m)).toBe("suspended")
    expect(m.scheduled).toEqual([])
    m.setNow(new Date(T0.getTime() + 6 * DAY))
    expect(await runDue(m.deps, TENANT)).toBe(0)
    m.setNow(new Date(T0.getTime() + 7 * DAY + 1))
    expect(await runDue(m.deps, TENANT)).toBe(1)
    expect(m.accounts.has(LEAVER)).toBe(false)
  })
})

describe("suspending", () => {
  it("is idempotent: a retried deprovision does not restart the deletion clock", async () => {
    const m = world({ default: { action: "delete_after", days: 7 } })
    await suspend(m)
    const first = row(m).deleteAt
    m.setNow(new Date(T0.getTime() + 3 * DAY))
    expect(await suspend(m)).toBe("already")
    expect(row(m).deleteAt).toEqual(first)
  })

  it("does nothing for a person this workspace gave no mailbox", async () => {
    const m = world()
    m.accounts.delete(LEAVER)
    expect(await suspend(m)).toBe("no_mailbox")
    expect(m.types()).not.toContain("mailbox.suspended")
  })

  it("does not touch a mailbox another workspace owns", async () => {
    const m = world()
    m.accounts.get(LEAVER)!.tenantId = "22222222-2222-4222-8222-222222222222"
    expect(await suspend(m)).toBe("no_mailbox")
    expect(m.accounts.get(LEAVER)!.suspended).toBe(false)
  })
})

describe("aliases", () => {
  const hostedBy = async (d: string) => (d === "acme.test" ? TENANT : null)
  it("keeps only addresses on the workspace's hosted domains, counts the rest, and never the primary", async () => {
    const r = await aliasesOf(
      TENANT,
      {
        emails: [
          { value: "ada@acme.test" },
          { value: "A.L@acme.test" },
          { value: "a.l@acme.test" },
          { value: "ada@gmail.com" },
          { value: "ada@acme.test.evil.example" },
          { value: 7 },
          { value: "nonsense" },
        ],
      },
      "ada@acme.test",
      hostedBy,
    )
    expect(r).toEqual({ keep: ["a.l@acme.test"], ignored: 4 })
  })
  it("ignores everything when a directory sends no list at all", async () => {
    expect(await aliasesOf(TENANT, {}, "ada@acme.test", hostedBy)).toEqual({
      keep: [],
      ignored: 0,
    })
  })
})

describe("directory groups as lists", () => {
  const GROUP = "55555555-5555-4555-8555-555555555555"
  const DIR = "66666666-6666-4666-8666-666666666666"
  function groupWorld(displayName = "Engineering") {
    const m = memoryMail()
    m.groups.set(GROUP, { displayName, mailAddress: null, mailKind: null })
    return m
  }
  const enable = (m: ReturnType<typeof memoryMail>, address: string) =>
    setGroupMail(
      { store: m.store, record: m.deps.record },
      {
        tenantId: TENANT,
        directoryId: DIR,
        groupId: GROUP,
        actorUserId: ADMIN,
        mail: { address, kind: "list" },
      },
    )

  it("never makes a list at an address off a hosted domain", async () => {
    const m = groupWorld()
    expect(await enable(m, "eng@elsewhere.test")).toBe("address_not_hosted")
    expect(m.groups.get(GROUP)!.mailAddress).toBeNull()
    expect(m.types()).toContain("directory.group_mail_refused")
  })

  it("never makes a list for a group whose NAME is an address off a hosted domain", async () => {
    const m = groupWorld("all@elsewhere.test")
    expect(await enable(m, "eng@acme.test")).toBe("name_not_hosted")
    expect(m.groups.get(GROUP)!.mailAddress).toBeNull()
  })

  it("never makes a list at a malformed address or one that is already a mailbox", async () => {
    const m = groupWorld()
    m.give(LEAVER, "ada@acme.test")
    expect(await enable(m, "not an address")).toBe("invalid_address")
    expect(await enable(m, "ada@acme.test")).toBe("taken")
    expect(m.groups.get(GROUP)!.mailAddress).toBeNull()
  })

  it("makes a list on a hosted domain, audited with the actor", async () => {
    const m = groupWorld("eng@acme.test")
    expect(await enable(m, "ENG@acme.test")).toBe("ok")
    expect(m.groups.get(GROUP)).toMatchObject({
      mailAddress: "eng@acme.test",
      mailKind: "list",
    })
    expect(
      m.events.find((e) => e.type === "directory.group_mail_enabled"),
    ).toMatchObject({
      actorUserId: ADMIN,
      data: { address: "eng@acme.test", kind: "list" },
    })
  })

  it("opting out needs no domain check", async () => {
    const m = groupWorld()
    m.hosted.clear()
    expect(
      await setGroupMail(
        { store: m.store, record: m.deps.record },
        {
          tenantId: TENANT,
          directoryId: DIR,
          groupId: GROUP,
          actorUserId: ADMIN,
          mail: null,
        },
      ),
    ).toBe("ok")
  })
})
