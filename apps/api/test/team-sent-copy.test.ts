import { describe, expect, it } from "bun:test"
import { JmapAsError, type JmapAsClient, type JmapMethod } from "../src/mail/jmap-as.js"
import { teamMail, type SentMessage, type TeamMail } from "../src/mail/team-mail.js"
import { copyTeamSent, type SentCopyStore } from "../src/team-inboxes/sent-copy.js"

/**
 * The server-side Sent copy: what it copies, that it copies each message once,
 * and that "nobody has signed in yet" is not a failure.
 */

const NOW = new Date("2027-03-15T12:00:00Z")
const SUPPORT = { name: "support@acme.test", address: "support@acme.test" }

function memoryStore(
  teams: { name: string; address: string; members: string[] }[],
): SentCopyStore & { ledger: Map<string, Set<string>> } {
  const ledger = new Map<string, Set<string>>()
  return {
    ledger,
    teams: async () =>
      teams.map((t) => ({ ...t, members: t.members.map((address) => ({ address })) })),
    copied: async (name, ids) => new Set(ids.filter((id) => ledger.get(name)?.has(id))),
    record: async (name, ids) => {
      if (ids.length === 0) return
      const seen = ledger.get(name) ?? new Set<string>()
      for (const id of ids) seen.add(id)
      ledger.set(name, seen)
    },
  }
}

const log = { error: () => {} }

function fakeMail(sent: Record<string, SentMessage[]>) {
  const copies: { team: string; from: string; ids: string[] }[] = []
  const asked: { member: string; since: Date }[] = []
  const failures = new Map<string, JmapAsError | Error>()

  const mail: TeamMail = {
    async sentAs(member, _team, since) {
      asked.push({ member: member.address, since })
      const failure = failures.get(`sentAs:${member.address}`)
      if (failure) throw failure
      return sent[member.address] ?? []
    },
    async copyToSent(team, member, messages) {
      const failure = failures.get(`copy:${team.address}`)
      if (failure) throw failure
      copies.push({
        team: team.address,
        from: member.address,
        ids: messages.map((m) => m.messageId),
      })
      return messages.map((m) => m.messageId)
    },
    destroy: async () => true,
  }
  return { mail, copies, asked, failures }
}

describe("copying a member's reply into the team's Sent", () => {
  it("copies what a member sent as the team address", async () => {
    const store = memoryStore([{ ...SUPPORT, members: ["bob@acme.test"] }])
    const m = fakeMail({
      "bob@acme.test": [{ emailId: "e1", messageId: "m1@acme.test" }],
    })

    const result = await copyTeamSent({ store, mail: m.mail, now: () => NOW, log })

    expect(m.copies).toEqual([
      { team: "support@acme.test", from: "bob@acme.test", ids: ["m1@acme.test"] },
    ])
    expect(result).toEqual({ teams: 1, copied: 1, failed: 0 })
  })

  it("copies each message once, however many passes see it", async () => {
    const store = memoryStore([{ ...SUPPORT, members: ["bob@acme.test"] }])
    const m = fakeMail({
      "bob@acme.test": [{ emailId: "e1", messageId: "m1@acme.test" }],
    })
    const run = () => copyTeamSent({ store, mail: m.mail, now: () => NOW, log })

    await run()
    await run()
    const third = await run()

    expect(m.copies).toHaveLength(1)
    expect(third.copied).toBe(0)
  })

  it("copies only the new message when an old one is already recorded", async () => {
    const store = memoryStore([{ ...SUPPORT, members: ["bob@acme.test"] }])
    await store.record("support@acme.test", ["old@acme.test"])
    const m = fakeMail({
      "bob@acme.test": [
        { emailId: "e2", messageId: "new@acme.test" },
        { emailId: "e1", messageId: "old@acme.test" },
      ],
    })

    await copyTeamSent({ store, mail: m.mail, now: () => NOW, log })

    expect(m.copies[0]!.ids).toEqual(["new@acme.test"])
  })

  it("reads every member's Sent, and keeps the teams' ledgers apart", async () => {
    const store = memoryStore([
      { ...SUPPORT, members: ["bob@acme.test", "carol@acme.test"] },
      {
        name: "sales@acme.test",
        address: "sales@acme.test",
        members: ["carol@acme.test"],
      },
    ])
    // The same Message-ID in two teams is two messages: the ledger is per team.
    const m = fakeMail({
      "bob@acme.test": [{ emailId: "b1", messageId: "same@acme.test" }],
      "carol@acme.test": [{ emailId: "c1", messageId: "same@acme.test" }],
    })

    const result = await copyTeamSent({ store, mail: m.mail, now: () => NOW, log })

    expect(m.copies).toEqual([
      { team: "support@acme.test", from: "bob@acme.test", ids: ["same@acme.test"] },
      { team: "sales@acme.test", from: "carol@acme.test", ids: ["same@acme.test"] },
    ])
    expect(result.copied).toBe(2)
  })

  it("looks back over the window, not just since the last run", async () => {
    const store = memoryStore([{ ...SUPPORT, members: ["bob@acme.test"] }])
    const m = fakeMail({})

    await copyTeamSent({
      store,
      mail: m.mail,
      now: () => NOW,
      lookbackMs: 3_600_000,
      log,
    })

    expect(m.asked[0]!.since).toEqual(new Date("2027-03-15T11:00:00Z"))
  })

  it("does not treat a member or team nobody has signed in to yet as a failure", async () => {
    const store = memoryStore([
      { ...SUPPORT, members: ["bob@acme.test", "carol@acme.test"] },
    ])
    const m = fakeMail({
      "bob@acme.test": [{ emailId: "e1", messageId: "m1@acme.test" }],
      "carol@acme.test": [{ emailId: "e2", messageId: "m2@acme.test" }],
    })
    // Bob has never signed in; the team's account does not exist for Carol's copy.
    m.failures.set("sentAs:bob@acme.test", new JmapAsError("no_account", "no account"))
    m.failures.set(
      "copy:support@acme.test",
      new JmapAsError("no_account", "no account"),
    )

    const result = await copyTeamSent({ store, mail: m.mail, now: () => NOW, log })

    expect(result).toEqual({ teams: 1, copied: 0, failed: 0 })
    // Nothing was recorded, so the message is copied once the account exists.
    expect(store.ledger.size).toBe(0)
  })

  it("reports a real failure, records nothing for it, and carries on", async () => {
    const store = memoryStore([
      { ...SUPPORT, members: ["bob@acme.test", "carol@acme.test"] },
    ])
    const m = fakeMail({
      "bob@acme.test": [{ emailId: "e1", messageId: "m1@acme.test" }],
      "carol@acme.test": [{ emailId: "e2", messageId: "m2@acme.test" }],
    })
    m.failures.set("sentAs:bob@acme.test", new JmapAsError("stalwart", "boom"))

    const result = await copyTeamSent({ store, mail: m.mail, now: () => NOW, log })

    expect(result).toEqual({ teams: 1, copied: 1, failed: 1 })
    expect(m.copies.map((c) => c.from)).toEqual(["carol@acme.test"])
    expect([...store.ledger.get("support@acme.test")!]).toEqual(["m2@acme.test"])
  })

  it("does not record a message the server did not confirm", async () => {
    const store = memoryStore([{ ...SUPPORT, members: ["bob@acme.test"] }])
    const m = fakeMail({
      "bob@acme.test": [{ emailId: "e1", messageId: "m1@acme.test" }],
    })
    m.mail.copyToSent = async () => []

    await copyTeamSent({ store, mail: m.mail, now: () => NOW, log })

    expect(store.ledger.size).toBe(0)
  })
})

/**
 * The same flow against the wire: the JMAP the copy sends, with a fake client
 * standing in for `jmapAs`. The shapes are RFC 8620/8621; what Stalwart does with
 * them is the "must probe" list in mail/team-mail.ts.
 */
describe("the JMAP the copy sends", () => {
  type Call = { who: string; from?: string; methods: JmapMethod[] }

  function fakeClient(answers: {
    sent?: unknown[]
    notCreated?: Record<string, { type: string }>
  }) {
    const calls: Call[] = []
    const client: JmapAsClient = {
      async call(mailbox, methods) {
        calls.push({ who: mailbox.address, methods: [...methods] })
        if (methods[0]![0] === "Mailbox/get") {
          return [["Mailbox/get", { list: [{ id: "mb-sent", role: "sent" }] }, "m"]]
        }
        return [
          ["Email/query", { ids: ["e1"] }, "q"],
          ["Email/get", { list: answers.sent ?? [] }, "g"],
        ]
      },
      async callAsGroup(group, methods, options) {
        calls.push({
          who: group.address,
          ...(options?.from ? { from: options.from.address } : {}),
          methods: [...methods],
        })
        if (methods[0]![0] === "Mailbox/get") {
          return [["Mailbox/get", { list: [{ id: "team-sent", role: "sent" }] }, "m"]]
        }
        const create = methods[0]![1].create as Record<string, unknown>
        const created = Object.fromEntries(
          Object.keys(create)
            .filter((k) => !answers.notCreated?.[k])
            .map((k) => [k, { id: `n-${k}` }]),
        )
        return [["Email/copy", { created, notCreated: answers.notCreated ?? {} }, "c"]]
      },
      destroyGroup: async () => true,
    }
    return { client, calls }
  }

  it("asks the member's Sent for mail from the team address, and reads the Message-ID", async () => {
    const { client, calls } = fakeClient({
      sent: [
        { id: "e1", messageId: ["m1@acme.test"] },
        { id: "e2", messageId: [] },
        { id: "e3" },
      ],
    })

    const found = await teamMail(client).sentAs(
      { address: "bob@acme.test" },
      SUPPORT,
      new Date("2027-03-15T00:00:00Z"),
    )

    // A message with no Message-ID has no ledger key, so it is not copied.
    expect(found).toEqual([{ emailId: "e1", messageId: "m1@acme.test" }])
    const query = calls[1]!.methods[0]!
    expect(query[0]).toBe("Email/query")
    expect(query[1].filter).toEqual({
      inMailbox: "mb-sent",
      from: "support@acme.test",
      after: "2027-03-15T00:00:00.000Z",
    })
    expect(calls.every((c) => c.who === "bob@acme.test")).toBe(true)
  })

  it("copies as the team, from the member, into the team's Sent", async () => {
    const { client, calls } = fakeClient({})

    const done = await teamMail(client).copyToSent(
      SUPPORT,
      { address: "bob@acme.test" },
      [
        { emailId: "e1", messageId: "m1@acme.test" },
        { emailId: "e2", messageId: "m2@acme.test" },
      ],
    )

    expect(done).toEqual(["m1@acme.test", "m2@acme.test"])
    const copy = calls.find((c) => c.methods[0]![0] === "Email/copy")!
    expect(copy.who).toBe("support@acme.test")
    expect(copy.from).toBe("bob@acme.test")
    expect(copy.methods[0]![1].create).toEqual({
      c0: { id: "e1", mailboxIds: { "team-sent": true }, keywords: { $seen: true } },
      c1: { id: "e2", mailboxIds: { "team-sent": true }, keywords: { $seen: true } },
    })
  })

  it("counts 'already exists' as copied and anything else as a failure", async () => {
    const exists = fakeClient({ notCreated: { c0: { type: "alreadyExists" } } })
    expect(
      await teamMail(exists.client).copyToSent(SUPPORT, { address: "bob@acme.test" }, [
        { emailId: "e1", messageId: "m1@acme.test" },
      ]),
    ).toEqual(["m1@acme.test"])

    const refused = fakeClient({ notCreated: { c0: { type: "forbidden" } } })
    const error = await teamMail(refused.client)
      .copyToSent(SUPPORT, { address: "bob@acme.test" }, [
        { emailId: "e1", messageId: "m1@acme.test" },
      ])
      .then(
        () => "ok",
        (e: Error) => e.message,
      )
    expect(error).toContain("forbidden")
  })

  it("sends nothing when there is nothing to copy", async () => {
    const { client, calls } = fakeClient({})
    expect(
      await teamMail(client).copyToSent(SUPPORT, { address: "bob@acme.test" }, []),
    ).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
