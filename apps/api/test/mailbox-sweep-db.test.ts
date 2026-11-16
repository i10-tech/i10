import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { memoryStore } from "../src/content/object-store.js"
import type { Database } from "../src/db/client.js"
import { mailboxSweepStore, sweepMailboxJobs } from "../src/mailboxes/sweep.js"

/**
 * The hourly mailbox job sweep (#392) against a real database as `i10_api`,
 * with no tenant set: `core.mailbox_jobs_lost` and `core.mailbox_archives_due`
 * behind `mailboxSweepStore`, and the per-row writes under each tenant. Rows
 * are written by the owner so their clocks can be set back.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/<scratch> bun test test/mailbox-sweep-db.test.ts
 *
 * ⚠ THE SWEEP WALKS EVERY ROW IN THE DATABASE, other test files' included, so
 * these assert on this file's own rows and objects, never on whole-run counts.
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const live = crypto.randomUUID()
const softDeleted = crypto.randomUUID()
const gone = crypto.randomUUID()
const ours = [live, softDeleted, gone]

interface JobRow {
  id: string
  status: string
  object_key: string | null
  error_code: string | null
}

/** A job row, and its object in `objects` when it has a key. */
async function job(
  objects: ReturnType<typeof memoryStore>,
  tenantId: string,
  spec: {
    type: "export" | "import"
    status: string
    key?: string
    /** How long ago it last moved, as a Postgres interval. */
    quiet?: string
    /** An export's `expires_at`, from now. */
    expires?: string
  },
): Promise<string> {
  const key = spec.key ? `${tenantId}/${spec.key}` : null
  const [row] = await owner<{ id: string }[]>`
    insert into core.mailbox_jobs
      (tenant_id, mailbox_address, type, status, requested_by, object_key, updated_at, expires_at)
    values (${tenantId}, 'a@x.test', ${spec.type}, ${spec.status}, 'u', ${key},
            now() - ${spec.quiet ?? "0 seconds"}::interval,
            ${spec.expires ? owner`now() + ${spec.expires}::interval` : null})
    returning id`
  if (key) objects.objects.set(key, new Uint8Array([1]))
  return row!.id
}

async function rowOf(id: string): Promise<JobRow | null> {
  const [row] = await owner<JobRow[]>`
    select id, status, object_key, error_code from core.mailbox_jobs where id = ${id}`
  return row ?? null
}

const sweep = (objects: ReturnType<typeof memoryStore> | null) =>
  sweepMailboxJobs({ store: mailboxSweepStore(database), objects })

suite("mailbox job sweep", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle({ client: db }) as unknown as Database
    for (const id of ours)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                  values (${id}, ${`x-${id.slice(0, 8)}`}, 'T', ${`owner-${id}`})`
    await owner`update core.tenants set status = 'deleted' where id = ${softDeleted}`
  })
  afterAll(async () => {
    await owner`delete from core.mailbox_jobs where tenant_id = any(${ours})`
    await owner`delete from core.tenants where id = any(${ours})`
    await owner.end()
    await db.end()
  })

  it("answers where reading core.mailbox_jobs with an empty tenant throws", async () => {
    await job(memoryStore(), live, { type: "export", status: "completed" })
    // The production shape: a pooled session whose tenant reverted to "".
    const read = (query: string) =>
      db
        .begin(async (tx) => {
          await tx`select set_config('app.tenant_id', '', true)`
          return tx.unsafe(query)
        })
        .then(
          () => "",
          (err: unknown) => String(err),
        )
    expect(await read("select id from core.mailbox_jobs")).toContain(
      'invalid input syntax for type uuid: ""',
    )
    expect(
      await read(
        "select job_id from core.mailbox_jobs_lost(null, interval '3 hours', 500)",
      ),
    ).toBe("")
    expect(
      await read(
        "select job_id from core.mailbox_archives_due(null, interval '1 day', interval '6 hours', 500)",
      ),
    ).toBe("")
  })

  it("fails lost jobs and deletes what is due, in live, deleted and gone workspaces", async () => {
    const objects = memoryStore()
    const live1 = {
      expired: await job(objects, live, {
        type: "export",
        status: "completed",
        key: "exports/expired",
        expires: "-1 hour",
      }),
      unexpired: await job(objects, live, {
        type: "export",
        status: "completed",
        key: "exports/unexpired",
        expires: "6 days",
      }),
      abandoned: await job(objects, live, {
        type: "import",
        status: "awaiting_upload",
        key: "imports/abandoned",
        quiet: "25 hours",
      }),
      uploading: await job(objects, live, {
        type: "import",
        status: "awaiting_upload",
        key: "imports/uploading",
        quiet: "1 hour",
      }),
      failed: await job(objects, live, {
        type: "import",
        status: "failed",
        key: "imports/failed",
      }),
      lost: await job(objects, live, {
        type: "import",
        status: "running",
        key: "imports/lost",
        quiet: "4 hours",
      }),
      running: await job(objects, live, {
        type: "import",
        status: "running",
        key: "imports/running",
        quiet: "1 hour",
      }),
    }
    const deleted = {
      export: await job(objects, softDeleted, {
        type: "export",
        status: "completed",
        key: "exports/fresh",
        expires: "6 days",
      }),
      inWindow: await job(objects, softDeleted, {
        type: "import",
        status: "awaiting_upload",
        key: "imports/in-window",
        quiet: "1 hour",
      }),
      pastWindow: await job(objects, softDeleted, {
        type: "import",
        status: "awaiting_upload",
        key: "imports/past-window",
        quiet: "7 hours",
      }),
    }
    const handDeleted = {
      export: await job(objects, gone, {
        type: "export",
        status: "completed",
        key: "exports/fresh",
        expires: "6 days",
      }),
      pastWindow: await job(objects, gone, {
        type: "import",
        status: "awaiting_upload",
        key: "imports/past-window",
        quiet: "7 hours",
      }),
      inWindow: await job(objects, gone, {
        type: "import",
        status: "awaiting_upload",
        key: "imports/in-window",
        quiet: "1 hour",
      }),
      running: await job(objects, gone, {
        type: "export",
        status: "running",
        quiet: "1 hour",
      }),
      done: await job(objects, gone, { type: "import", status: "completed" }),
    }
    // An ops flush. With no foreign key, the job rows outlive the tenant row.
    await owner`delete from core.tenants where id = ${gone}`
    expect(
      (await owner`select 1 from core.mailbox_jobs where tenant_id = ${gone}`).length,
    ).toBe(5)

    const counts = await sweep(objects)
    expect(counts.failed).toBe(0)
    expect(counts.lost).toBeGreaterThanOrEqual(1)

    expect([...objects.objects.keys()].sort()).toEqual(
      [
        `${live}/exports/unexpired`,
        `${live}/imports/uploading`,
        `${live}/imports/running`,
        `${softDeleted}/imports/in-window`,
        `${gone}/imports/in-window`,
      ].sort(),
    )

    // Live workspace: keys cleared where objects went, rows kept.
    for (const id of [live1.expired, live1.abandoned, live1.failed])
      expect((await rowOf(id))?.object_key).toBeNull()
    expect((await rowOf(live1.unexpired))?.object_key).toBe(`${live}/exports/unexpired`)
    expect(await rowOf(live1.lost)).toMatchObject({
      status: "failed",
      error_code: "worker_lost",
      object_key: null,
    })
    expect(await rowOf(live1.running)).toMatchObject({
      status: "running",
      error_code: null,
      object_key: `${live}/imports/running`,
    })

    // Deleted workspace: the export at once, the upload after its window; rows kept.
    expect((await rowOf(deleted.export))?.object_key).toBeNull()
    expect((await rowOf(deleted.pastWindow))?.object_key).toBeNull()
    expect((await rowOf(deleted.inWindow))?.object_key).toBe(
      `${softDeleted}/imports/in-window`,
    )

    // Tenant row gone: rows deleted once nothing is left, except a live job
    // and an upload still inside its window.
    for (const id of [handDeleted.export, handDeleted.pastWindow, handDeleted.done])
      expect(await rowOf(id)).toBeNull()
    expect((await rowOf(handDeleted.inWindow))?.object_key).toBe(
      `${gone}/imports/in-window`,
    )
    expect((await rowOf(handDeleted.running))?.status).toBe("running")

    // A second run finds nothing more of ours to do.
    const before = await owner`
      select id, status, object_key, updated_at from core.mailbox_jobs
       where tenant_id = any(${ours}) order by id`
    const deletes: string[] = []
    const watched = Object.assign(memoryStore(), {
      objects: objects.objects,
      async delete(key: string) {
        deletes.push(key)
        objects.objects.delete(key)
      },
    })
    await sweep(watched)
    expect(deletes.filter((k) => ours.some((t) => k.startsWith(t)))).toEqual([])
    expect([
      ...(await owner`
      select id, status, object_key, updated_at from core.mailbox_jobs
       where tenant_id = any(${ours}) order by id`),
    ]).toEqual([...before])
  })

  it("keeps going past a row that fails, and tries it again next run", async () => {
    const objects = memoryStore()
    const first = await job(objects, live, {
      type: "export",
      status: "completed",
      key: "exports/stuck",
      expires: "-1 hour",
    })
    const second = await job(objects, live, {
      type: "export",
      status: "completed",
      key: "exports/next",
      expires: "-1 hour",
    })
    const flaky = Object.assign(memoryStore(), {
      objects: objects.objects,
      async delete(key: string) {
        if (key === `${live}/exports/stuck`) throw new Error("R2 is down")
        objects.objects.delete(key)
      },
    })

    expect((await sweep(flaky)).failed).toBeGreaterThanOrEqual(1)
    expect((await rowOf(first))?.object_key).toBe(`${live}/exports/stuck`)
    expect((await rowOf(second))?.object_key).toBeNull()

    await sweep(objects)
    expect((await rowOf(first))?.object_key).toBeNull()
    expect(objects.objects.size).toBe(0)
  })

  it("still fails lost jobs with no content store, and leaves archives alone", async () => {
    const objects = memoryStore()
    const lost = await job(objects, live, {
      type: "import",
      status: "running",
      key: "imports/lost-no-store",
      quiet: "4 hours",
    })
    await sweep(null)
    expect(await rowOf(lost)).toMatchObject({
      status: "failed",
      error_code: "worker_lost",
      object_key: `${live}/imports/lost-no-store`,
    })
  })
})
