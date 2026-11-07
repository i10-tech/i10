import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { publishRoutingSettings } from "../src/domains/routing-settings.js"

/**
 * The Stalwart mailbox lookup against a real database. It proves the settings
 * publisher stores two `MAIL_DOMAINS` values as `text[]`, then exercises the
 * SECURITY DEFINER function against its actual domain lookup.
 *
 *   MAILBOX_ROUTE_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/i10_mailroute bun test test/mailbox-route-db.test.ts
 */
const URL = process.env.MAILBOX_ROUTE_TEST_DATABASE_URL
const suite = URL ? describe : describe.skip
const RUN = crypto.randomUUID().slice(0, 8)
const tenantId = crypto.randomUUID()
const ownDomains = [`i10-${RUN}.tech`, `i10-${RUN}.email`]
const hostedAuto = `auto-${RUN}.test`
const hostedDirect = `direct-${RUN}.test`
const hostedSes = `ses-${RUN}.test`
const sendingOnly = `send-${RUN}.test`

let owner: ReturnType<typeof postgres>
let db: Database
let previousSettings: {
  sesEnabled: boolean
  sesRelayEnabled: boolean
  mailDomains: string[]
}

async function route(senderDomain: string) {
  const [row] = await owner`select core.mailbox_route(${senderDomain}) as route`
  return row?.route
}

suite("mailbox routing in Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = drizzle(owner, { schema }) as unknown as Database

    const [settings] = await owner`
      select ses_enabled, ses_relay_enabled, mail_domains
        from core.routing_settings
       where id
    `
    if (!settings) throw new Error("core.routing_settings is missing its one row")
    previousSettings = {
      sesEnabled: settings.ses_enabled,
      sesRelayEnabled: settings.ses_relay_enabled,
      mailDomains: settings.mail_domains,
    }

    await owner`
      insert into core.tenants (id, slug, name, owner_clerk_user_id)
      values (${tenantId}, ${`mailbox-route-${RUN}`}, 'Mailbox route', ${`route-${RUN}`})
    `
    // The route must not consult this free assignment. It is present to prove a
    // hosted domain on the free plan still reaches SES.
    await owner`
      insert into core.plan_assignments (tenant_id, plan_id, anchor)
      values (${tenantId}, 'free', now())
    `
    await owner`
      insert into core.domains (tenant_id, name, hosts_mailboxes, mailbox_route)
      values
        (${tenantId}, ${hostedAuto}, true, 'auto'),
        (${tenantId}, ${hostedDirect}, true, 'direct'),
        (${tenantId}, ${hostedSes}, true, 'ses'),
        (${tenantId}, ${sendingOnly}, false, 'auto')
    `
    await publishRoutingSettings(db, {
      sesEnabled: true,
      sesRelayEnabled: true,
      mailDomains: ownDomains,
    })
  })

  afterAll(async () => {
    if (previousSettings) await publishRoutingSettings(db, previousSettings)
    if (owner) {
      await owner`delete from core.tenants where id = ${tenantId}`
      await owner.end()
    }
  })

  it("routes both own domains from MAIL_DOMAINS, including mixed case", async () => {
    const [settings] =
      await owner`select mail_domains from core.routing_settings where id`
    expect(settings?.mail_domains).toEqual(ownDomains)
    expect(await route(ownDomains[0]!.toUpperCase())).toBe("ses-relay")
    expect(await route(ownDomains[1]!)).toBe("ses-relay")
  })

  it("routes a hosted mailbox domain on the free plan through SES", async () => {
    expect(await route(hostedAuto)).toBe("ses-relay")
  })

  it("keeps a direct mailbox override direct", async () => {
    expect(await route(hostedDirect)).toBe("mx")
  })

  it("does not relay a sending-only or outside return-path domain", async () => {
    expect(await route(sendingOnly)).toBe("mx")
    expect(await route(`outside-${RUN}.test`)).toBe("mx")
  })

  it("honors the relay switch even for an own domain", async () => {
    await publishRoutingSettings(db, {
      sesEnabled: true,
      sesRelayEnabled: false,
      mailDomains: ownDomains,
    })
    expect(await route(ownDomains[0]!)).toBe("mx")
    await publishRoutingSettings(db, {
      sesEnabled: true,
      sesRelayEnabled: true,
      mailDomains: ownDomains,
    })
  })

  it("honors the SES kill switch even for an ses override", async () => {
    await publishRoutingSettings(db, {
      sesEnabled: false,
      sesRelayEnabled: true,
      mailDomains: ownDomains,
    })
    expect(await route(hostedSes)).toBe("mx")
  })
})
