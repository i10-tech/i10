/*
 * Moves a domain we already own from SES's Easy DKIM onto our own key.
 *
 * ⚠ THIS EXISTS BECAUSE `POST /domains` CANNOT DO IT, AND WOULD BREAK MAIL IF
 * IT TRIED. Two reasons, both fatal for a domain that is already live:
 *
 *   1. `domainStore.create` calls SES BEFORE inserting the row, and
 *      `core.domains.name` is UNIQUE. i10.tech already has a row from migration
 *      0029, so the insert loses to the constraint and returns `conflict` — but
 *      SES has ALREADY been switched to a freshly generated key, and that key
 *      is discarded with the failed transaction. Every message after that
 *      moment is signed with a key nobody holds and no DNS record publishes.
 *
 *   2. It writes `hosts_mailboxes: false`. For i10.tech that is not merely
 *      wrong, it is what `core.mailbox_domains()` reads — the projection would
 *      stop treating i10.tech as a mailbox domain and Stalwart would stop
 *      accepting our own mail.
 *
 * ⚠ AND THE ORDER OF OPERATIONS IS THE ENTIRE POINT OF THE TWO PHASES. The
 * domains API publishes the SES identity first and hands the customer records
 * to publish afterwards, which is right for a domain that is not sending yet.
 * A live domain has to go the other way: the public key must be resolvable
 * BEFORE SES starts signing with the private half, or every message sent in the
 * gap fails DKIM.
 *
 *   phase 1  `pnpm --filter @i10/api adopt-dkim <domain>`
 *            Generates the keypair, seals it into the existing row, and prints
 *            the TXT record. SES is NOT touched: mail keeps flowing on Easy
 *            DKIM exactly as before.
 *
 *   phase 2  `pnpm --filter @i10/api adopt-dkim <domain> --flip`
 *            Refuses unless the TXT record resolves and matches the stored key,
 *            then switches SES to that key.
 *
 * Afterwards, delete the three `*.dkim.amazonses.com` CNAMEs — they are Easy
 * DKIM's and nothing signs with them any more.
 */
import { resolveTxt } from "node:dns/promises"
import {
  PutEmailIdentityDkimSigningAttributesCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2"
import { eq } from "drizzle-orm"
import { createDb } from "../src/db/client.js"
import { domains } from "../src/db/core.js"
import { dkimRecordValue, generateDkimKeypair } from "../src/domains/dkim.js"
import { secretBox } from "../src/webhooks/signing.js"

const name = process.argv[2]?.trim().toLowerCase()
const flip = process.argv.includes("--flip")

if (!name) {
  console.error("usage: adopt-dkim <domain> [--flip]")
  process.exit(1)
}

/**
 * ⚠ THE OWNER ROLE, NOT `i10_api`, AND `core.domains` IS WHY. Migration 0002
 * puts a `tenant_isolation` policy on it that reads
 * `current_setting('app.tenant_id')` with no `missing_ok` — so a connection
 * that has not set a tenant does not quietly see zero rows, it ERRORS. This
 * script cannot set one either: it has to read the row before it knows which
 * tenant owns it. Policies do not apply to a table's owner, which is exactly
 * why `migrate.ts` connects this way, and this is migration-shaped work.
 *
 * ⚠ AND `loadEnv()` IS DELIBERATELY NOT USED. It demands the whole server's
 * configuration — Redis, Clerk, the mail hostnames — none of which this needs.
 * Requiring them would mean nobody could run a one-domain fix without standing
 * up the entire environment.
 */
const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL
const sealingKey = process.env.WEBHOOK_SECRET_KEY
const region = process.env.AWS_REGION ?? "eu-central-1"

if (!url) {
  console.error("MIGRATE_DATABASE_URL (or DATABASE_URL) is required")
  process.exit(1)
}
if (!sealingKey) {
  console.error("WEBHOOK_SECRET_KEY is required — the private key is sealed with it.")
  process.exit(1)
}

const { sql, db } = createDb(url)
const secrets = secretBox(sealingKey)

const [row] = await db.select().from(domains).where(eq(domains.name, name)).limit(1)

if (!row) {
  console.error(
    `no core.domains row for ${name}. This adopts an EXISTING domain; a new one goes through POST /domains.`,
  )
  process.exit(1)
}

if (!flip) {
  // ⚠ REFUSES TO REGENERATE OVER A KEY THAT IS ALREADY THERE. Running phase 1
  // twice would replace the stored key while SES may already be signing with
  // the first one, which is the outage this script exists to avoid.
  if (row.dkimSelector) {
    console.error(
      `${name} already has selector ${row.dkimSelector}. Re-run with --flip, or clear the row deliberately.`,
    )
    process.exit(1)
  }

  const keypair = generateDkimKeypair()

  await db
    .update(domains)
    .set({
      dkimSelector: keypair.selector,
      dkimPublicKey: keypair.publicKey,
      dkimPrivateKeySealed: secrets.seal(keypair.privateKey),
    })
    .where(eq(domains.name, name))

  console.log(
    `\nStored a new key for ${name}. SES is untouched and still signing as before.`,
  )
  console.log(`\nPublish this, then wait for it to resolve everywhere:\n`)
  console.log(`  ${keypair.selector}._domainkey.${name}   TXT`)
  console.log(`  ${dkimRecordValue(keypair.publicKey)}\n`)
  console.log(`Then: adopt-dkim ${name} --flip\n`)
  await sql.end({ timeout: 5 })
  process.exit(0)
}

if (!row.dkimSelector || !row.dkimPublicKey) {
  console.error(`${name} has no stored key. Run phase 1 first.`)
  process.exit(1)
}

// ⚠ THE PUBLISHED RECORD IS CHECKED AGAINST THE STORED KEY, NOT MERELY FOR
// EXISTENCE. A record for the right selector carrying somebody else's key — a
// stale one, a half-finished paste — would pass a presence check and fail every
// signature afterwards.
const host = `${row.dkimSelector}._domainkey.${name}`
let published: string
try {
  const chunks = await resolveTxt(host)
  published = chunks.map((parts) => parts.join("")).join("")
} catch {
  console.error(`${host} does not resolve yet. Publish it and wait, then re-run.`)
  process.exit(1)
}

if (!published.includes(row.dkimPublicKey)) {
  console.error(`${host} resolves but does not carry the stored key. Not flipping.`)
  process.exit(1)
}

const ses = new SESv2Client({ region })
await ses.send(
  new PutEmailIdentityDkimSigningAttributesCommand({
    EmailIdentity: name,
    // The whole point: Amazon stops holding the key and starts using ours.
    SigningAttributesOrigin: "EXTERNAL",
    SigningAttributes: {
      DomainSigningSelector: row.dkimSelector,
      DomainSigningPrivateKey: secrets.open(row.dkimPrivateKeySealed!),
    },
  }),
)

// ⚠ `sends` BECOMES TRUE ONLY NOW, AND 0029 EXPLAINS WHY IT WAS FALSE. That
// migration set it false because the row had no SES identity of ours, no
// selector and no key — the `domains.sending` feature means exactly those
// things. It has them from this moment, so the level is finally honest. It does
// consume one of the i10 tenant's sending-domain allowances.
await db.update(domains).set({ sends: true }).where(eq(domains.name, name))

console.log(`\n${name} now signs with our own key (${row.dkimSelector}).`)
console.log(`Send a test message and confirm DKIM passes before deleting the`)
console.log(`three *.dkim.amazonses.com CNAMEs.\n`)

await sql.end({ timeout: 5 })
