import { describe, expect, it, mock } from "bun:test"
import type { SESv2Client } from "@aws-sdk/client-sesv2"
import { createApp } from "../src/app.js"
import type { Database } from "../src/db/client.js"
import {
  sesTenantSuppressions,
  type TenantSuppressions,
} from "../src/suppressions/ses.js"
import {
  suppressionsCsv,
  suppressionStore,
  type SuppressionStore,
} from "../src/suppressions/store.js"

/**
 * Per-workspace suppression (#159).
 *
 * ⚠ THE TWO RULES WORTH A TEST ARE THE ONES THAT FAIL SILENTLY. A removal that
 * never reaches SES looks like it worked - the row leaves our list - and the
 * next send is dropped as `OnTenantSuppressionList`. A complaint removed on one
 * click looks like any other removal. Neither produces an error anybody sees.
 */

const TENANT = "0190a3e4-5b6c-7d8e-9f00-112233445566"
const SES_TENANT = `i10-${TENANT}`

const notFound = () =>
  Object.assign(new Error("not on the list"), { name: "NotFoundException" })

/** A client that records each command, answering from `answers` by name. */
const sesClient = (
  answers: Record<string, unknown | ((input: never) => unknown)> = {},
) => {
  const sent: { name: string; input: Record<string, unknown> }[] = []
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      const name = command.constructor.name
      sent.push({ name, input: command.input })
      const raw = answers[name]
      const answer = typeof raw === "function" ? raw(command.input as never) : raw
      if (answer instanceof Error) throw answer
      return answer ?? {}
    },
  } as unknown as SESv2Client
  return { client, sent }
}

describe("sesTenantSuppressions", () => {
  it("deletes the address from the workspace's tenant list", async () => {
    const { client, sent } = sesClient()
    await sesTenantSuppressions(client).release(SES_TENANT, "Bob@Acme.com")

    expect(sent).toEqual([
      {
        name: "DeleteSuppressedDestinationCommand",
        input: { TenantName: SES_TENANT, EmailAddress: "bob@acme.com" },
      },
    ])
  })

  it("treats an address SES does not hold as released", async () => {
    const { client } = sesClient({ DeleteSuppressedDestinationCommand: notFound() })
    await sesTenantSuppressions(client).release(SES_TENANT, "bob@acme.com")
  })

  /**
   * ⚠ SES KEEPS THE CASE IT WAS SENT WITH AND MATCHES EXACTLY; WE LOWERCASE.
   * Without the search, `Bob@Acme.com` stays on SES's list after our row is
   * gone, and every send to it is dropped.
   */
  it("finds and deletes a differently-cased copy since our row was written", async () => {
    const since = new Date("2026-09-20T12:00:00Z")
    const { client, sent } = sesClient({
      DeleteSuppressedDestinationCommand: (input: { EmailAddress: string }) =>
        input.EmailAddress === "Bob@Acme.com" ? {} : notFound(),
      ListSuppressedDestinationsCommand: {
        SuppressedDestinationSummaries: [
          { EmailAddress: "Bob@Acme.com" },
          { EmailAddress: "someone@else.com" },
        ],
      },
    })
    await sesTenantSuppressions(client).release(SES_TENANT, "bob@acme.com", since)

    const list = sent.find((s) => s.name === "ListSuppressedDestinationsCommand")!
    expect(list.input.TenantName).toBe(SES_TENANT)
    expect((list.input.StartDate as Date).getTime()).toBeLessThan(since.getTime())
    expect(
      sent
        .filter((s) => s.name === "DeleteSuppressedDestinationCommand")
        .map((s) => s.input.EmailAddress),
    ).toEqual(["bob@acme.com", "Bob@Acme.com"])
  })

  it("surfaces any other failure, so the caller keeps its row", async () => {
    const { client } = sesClient({
      DeleteSuppressedDestinationCommand: Object.assign(new Error("slow down"), {
        name: "TooManyRequestsException",
      }),
    })
    await expect(
      sesTenantSuppressions(client).release(SES_TENANT, "bob@acme.com"),
    ).rejects.toThrow("slow down")
  })
})

/** A database holding at most one suppression row, recording deletes. */
const fakeDb = (row: { reason: string; createdAt: Date } | null) => {
  const deletes: unknown[] = []
  const tx = {
    execute: async () => [],
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          deletes.push(true)
          return row ? [{ address: "bob@acme.com" }] : []
        },
      }),
    }),
  }
  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Database
  return { db, deletes }
}

describe("suppressionStore.remove", () => {
  const created = new Date("2026-09-20T12:00:00Z")

  it("releases on SES first, then deletes ours", async () => {
    const { db, deletes } = fakeDb({ reason: "hard_bounce", createdAt: created })
    const release = mock<TenantSuppressions["release"]>(async () => {})

    expect(
      await suppressionStore({ db, ses: { release } }).remove(TENANT, "Bob@Acme.com"),
    ).toBe("removed")
    expect(release).toHaveBeenCalledWith(SES_TENANT, "bob@acme.com", created)
    expect(deletes).toHaveLength(1)
  })

  it("refuses a complaint without the explicit confirmation, touching nothing", async () => {
    const { db, deletes } = fakeDb({ reason: "complaint", createdAt: created })
    const release = mock<TenantSuppressions["release"]>(async () => {})
    const store = suppressionStore({ db, ses: { release } })

    expect(await store.remove(TENANT, "bob@acme.com")).toBe("complaint")
    expect(release).not.toHaveBeenCalled()
    expect(deletes).toHaveLength(0)

    expect(await store.remove(TENANT, "bob@acme.com", { confirmComplaint: true })).toBe(
      "removed",
    )
  })

  it("keeps our row when SES cannot be told", async () => {
    const { db, deletes } = fakeDb({ reason: "hard_bounce", createdAt: created })
    const log = { error: mock() }
    const store = suppressionStore({
      db,
      ses: {
        release: async () => {
          throw new Error("SES is down")
        },
      },
      log,
    })

    expect(await store.remove(TENANT, "bob@acme.com")).toBe("unavailable")
    expect(deletes).toHaveLength(0)
    expect(log.error).toHaveBeenCalled()
  })

  it("reports an address that is not suppressed without calling SES", async () => {
    const { db } = fakeDb(null)
    const release = mock<TenantSuppressions["release"]>(async () => {})
    expect(
      await suppressionStore({ db, ses: { release } }).remove(TENANT, "x@y.com"),
    ).toBe("missing")
    expect(release).not.toHaveBeenCalled()
  })
})

describe("suppressionsCsv", () => {
  it("quotes every field and defuses a spreadsheet formula", () => {
    const csv = suppressionsCsv([
      {
        address: '=HYPERLINK("x")@evil.com',
        reason: "manual",
        message_id: null,
        created_at: "2026-09-20T12:00:00.000Z",
      },
    ])
    expect(csv).toBe(
      '"address","reason","message_id","created_at"\r\n' +
        '"\'=HYPERLINK(""x"")@evil.com","manual","","2026-09-20T12:00:00.000Z"\r\n',
    )
  })
})

describe("/suppressions", () => {
  const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"

  const harness = (store: Partial<SuppressionStore> = {}, scopes: string[] = []) => {
    const app = createApp({
      apiKeyAuth: {
        lookup: {
          byHash: async () => ({
            id: "key-1",
            tenantId: TENANT,
            scopes,
            mode: "live",
            revokedAt: null,
            expiresAt: null,
          }),
        },
        cache: { get: async () => null, set: async () => {}, del: async () => {} },
        ttlSeconds: 60,
      },
      suppressions: {
        list: async () => ({ data: [], nextCursor: null }),
        add: async () => {},
        remove: async () => "removed",
        exportAll: async () => [],
        ...store,
      },
    })
    return (path: string, init: RequestInit = {}) =>
      app.request(`/suppressions${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${KEY}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      })
  }

  it("lists the workspace's list in the public shape", async () => {
    const call = harness({
      list: async () => ({
        data: [
          {
            address: "bob@acme.com",
            reason: "hard_bounce",
            message_id: null,
            created_at: "2026-09-20T12:00:00.000Z",
          },
        ],
        nextCursor: "next",
      }),
    })
    const res = await call("")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [
        {
          object: "suppression",
          address: "bob@acme.com",
          reason: "hard_bounce",
          message_id: null,
          created_at: "2026-09-20T12:00:00.000Z",
        },
      ],
      next_cursor: "next",
    })
  })

  /**
   * ⚠ THE LIST IS WORKSPACE-WIDE. A key scoped to one domain reading it sees
   * what other domains' mail bounced, and removing an entry unblocks it for
   * every domain - so every method refuses, reads included.
   */
  it("refuses a domain-restricted key on every method", async () => {
    const call = harness({}, ["domain:acme.com"])
    expect((await call("")).status).toBe(403)
    expect(
      (await call("", { method: "POST", body: JSON.stringify({ address: "a@b.com" }) }))
        .status,
    ).toBe(403)
    expect((await call("/a%40b.com", { method: "DELETE" })).status).toBe(403)
  })

  it("asks for confirmation before removing a complaint, and passes it through", async () => {
    const remove = mock<SuppressionStore["remove"]>(async (_t, _a, opts) =>
      opts?.confirmComplaint ? "removed" : "complaint",
    )
    const call = harness({ remove })

    const refused = await call("/bob%2Bnews%40acme.com", { method: "DELETE" })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { name: string }).name).toBe(
      "confirmation_required",
    )

    const confirmed = await call("/bob%2Bnews%40acme.com?confirm=complaint", {
      method: "DELETE",
    })
    expect(confirmed.status).toBe(200)
    expect(remove).toHaveBeenLastCalledWith(TENANT, "bob+news@acme.com", {
      confirmComplaint: true,
    })
  })

  it("says 503 and changes nothing when SES could not be updated", async () => {
    const call = harness({ remove: async () => "unavailable" })
    expect((await call("/a%40b.com", { method: "DELETE" })).status).toBe(503)
  })
})
