# Choosing the MTA, per message

**Decided:** 2026-09-05.

i10 sends mail two ways and they are not the same product. Transactional mail
goes out through the SES **API**, from `apps/api`. Human mail — the mailboxes
Stalwart serves — goes out through Stalwart's own queue, and this document is
about which MTA that queue hands a message to.

---

## The requirement

**The customer publishes one set of records, once. We decide the route.**

Not "the customer picks a plan and gets a matching record set" — that makes a
plan change a DNS change, which is a support conversation and a window in which
nothing verifies. The records are fixed at domain creation and the routing
decision moves underneath them, per message.

---

## BYODKIM, and it was never optional

⚠ **This was already the decision. `core.domains` has carried `dkim_selector`
and `dkim_public_key` since it was written.** Migration 0018 introduced Easy
DKIM against it and 0020/0021 undo that. Recording the reasoning here so the
next person does not make the same trade.

⚠ **It carried a `dkim_private_key_ref` too, and that column was never written.**
It pointed at an external secret store, on the reasoning that the private key
must not be in the table at any price. Sealing with `WEBHOOK_SECRET_KEY` buys
the same property with no second system to run, so the pointer was superseded
before anything used it; 0034 dropped it.

With **Easy DKIM**, Amazon generates the keypair and holds the private half.
Three CNAMEs point at them; they sign. It is less for us to hold and it is
disqualifying: a message routed through our own MTA has **no key to sign
with**. The routing decision cannot exist.

With **BYODKIM**, we generate one 2048-bit RSA pair, publish the public half as
one TXT record, and hand the private half to both SES and Stalwart. One
signature, both routes, one record.

⚠ **The private key is sealed with `WEBHOOK_SECRET_KEY` before it reaches a
row.** `core.domains` already said a backup, a replica or a read-only analytics
grant must never be enough to sign as a customer's domain — sealing is what
makes that true. It is never returned by the API, for the same reason a webhook
signing secret is not.

⚠ **The selector is random, not `i10`.** A fixed selector means one name per
domain, so rotating is a destructive edit of a live record with a window in
which nothing verifies. A random one lets the next key be published beside the
old one and cut over when it resolves.

---

## The six records

| record | name                             | type                          |
| ------ | -------------------------------- | ----------------------------- |
| SPF    | `send.<domain>`                  | MX → SES feedback host        |
| SPF    | `send.<domain>`                  | TXT → `include:amazonses.com` |
| SPF    | `bounce.<domain>`                | MX → `MAIL_BOUNCE_HOST`       |
| SPF    | `bounce.<domain>`                | TXT → `include:_spf.i10.tech` |
| DKIM   | `<selector>._domainkey.<domain>` | TXT                           |
| DMARC  | `_dmarc.<domain>`                | TXT                           |

⚠ **FOUR UNTIL 2026-09-14, AND THE TWO NEW ONES ARE THE DIRECT ROUTE'S RETURN
PATH.** A delegating customer still publishes three NS record sets and nothing
else, because both new names live under `mail.` — which makes delegation
strictly more attractive than it was: three records either way, against six.

⚠ **EACH SPF TXT CARRIES ONE INCLUDE, NOT BOTH.** A return path is only ever
used by the route that owns it, so naming SES in `bounce.`'s record would
authorise Amazon to send as a domain on a path Amazon never touches, and spend
one of the ten lookups to do it.

### SPF names us with an `include:`, never an address

```
send.<domain>    TXT   v=spf1 include:amazonses.com ~all
bounce.<domain>  TXT   v=spf1 include:_spf.i10.tech ~all
```

⚠ **An `ip4:` would pin our infrastructure into records we cannot edit.**
Changing a relay, adding a second, or moving provider would mean asking every
customer to re-publish — and the ones who did not would start failing SPF with
nothing to tell them why. Behind an include it is one record we own.

⚠ **A dedicated subdomain, not the apex.** SPF allows ten DNS lookups per
evaluation, and `i10.tech`'s own record has its own job: who may send as
i10.tech. Conflating them means every customer's SPF inherits every include we
ever add for our own mail, and the limit is reached by a change nobody
connected to customer deliverability. `MAIL_SPF_INCLUDE` is the variable.

### Custom MAIL FROM stays

⚠ **An earlier draft proposed dropping it so one MX could serve both routes.
That was wrong and it is not ours to drop** — it is what gives the SES route an
aligned return path and somewhere for bounces to land.

The apparent conflict is that `send.<domain>`'s MX can only point at one host,
and SES requires its own feedback host there. The answer is a **second return
path**: `bounce.<domain>`, whose MX names our own inbound host and whose TXT
includes `_spf.i10.tech`.

⚠ **AN EARLIER VERSION OF THIS DOCUMENT SAID DIRECT SENDS USE I10'S OWN BOUNCE
DOMAIN AND NEED NO CUSTOMER RECORD. That was true when it was written and the
code has since moved past it** — `dnsRecordsFor` and `delegatedZones` both emit
the `bounce.` pair today. Bouncing to a name on i10.tech would work and would
save the customer two labels, but the envelope domain would then be ours, SPF
would not align with their `From:`, and DMARC would be passing on DKIM alone.
**Decided 2026-09-14: two labels is the price of both.**

⚠ **DMARC therefore passes on SPF _and_ DKIM on both routes.** It needs only
one, and BYODKIM aligns on the customer's domain either way — but a route with
both degrades gracefully when a forwarder breaks one of them.

⚠ **AND THE ENVELOPE SENDER IS VERP, NOT A BARE ADDRESS** —
`bounce+<messageId>@bounce.<domain>`. A DSN then arrives carrying the id of the
message it is about, so correlating a bounce is a parse rather than a heuristic
over `Message-ID` headers that intermediate MTAs are free to mangle.

---

## How the route is chosen

Verified against `stalwartlabs/stalwart` v0.16, 2026-09-05.

- A routing strategy is `Mx` (direct), `Relay` (a smart host — SES SMTP) or
  `Local`. `crates/common/src/config/smtp/queue.rs`.
- `MtaOutboundStrategy.route` is an **expression evaluated per recipient**, not
  a constant — `crates/smtp/src/outbound/delivery.rs:241`.
- It sees `Sender` and `SenderDomain`. `crates/smtp/src/queue/mod.rs:325`.
- Expressions can call `key_get`, `sql_query`, `dns_query` and `counter_get`
  (`crates/common/src/expr/functions/mod.rs`), and the route is awaited — so
  **async lookups work there**.

⚠ **Which means the tier is a live lookup, not a config push.** The expression
asks a `SECURITY DEFINER` function — the same pattern as every other
cross-tenant question in this repo — and a plan change takes effect on the next
message rather than on the next deploy.

⚠ **Relay over SMTP for mailbox mail; the API stays for transactional.**
Stalwart's outbound is SMTP only — there is no HTTP hook — so using the SES API
for mailbox mail would mean taking messages out of Stalwart's queue and
rebuilding queueing, retries and DSN generation that it already does properly.

---

## Delegated subdomains

**Decided and built 2026-09-05.** Opt-in per domain; manual records stay the
default.

A delegating customer adds **three NS record sets and nothing else**:

```
_domainkey.example.com.  NS  ns1.i10.tech.  ns2.i10.tech.
mail.example.com.        NS  ns1.i10.tech.  ns2.i10.tech.
_dmarc.example.com.      NS  ns1.i10.tech.  ns2.i10.tech.
```

We then serve every record that matters and can change any of them — rotate a
DKIM key, move a return path, flip a domain between SES and direct — with no
customer action at all.

⚠ **THREE SUBDOMAINS, NEVER THE APEX.** Taking the whole zone would make i10
responsible for their website, their inbound MX and every other vendor's
verification record: a bad day for our nameserver takes their marketing site
down, not just their mail. It also asks a company to hand its most load-bearing
infrastructure to a mail vendor, which established ones decline.

⚠ **THE RETURN PATHS MOVE UNDER `mail.`** — `send.mail.example.com` and
`bounce.mail.example.com`. Delegating `send.` and `bounce.` separately would be
two more record sets to add and two more chances to add one wrong. SES accepts
any subdomain as its MAIL FROM, so this costs nothing.

⚠ **AND SES MUST BE TOLD THE NAME IT WILL ACTUALLY SEE.** Registering
`send.example.com` while the zone serves `send.mail.example.com` is a MAIL FROM
that never verifies, with records that look correct because they are — under a
different name.

### PowerDNS on the box, over our own Postgres

The zone is **rows we write**, not an API we call: `pdns.domains` and
`pdns.records` live in the `i10` database (0023), and PowerDNS reads them.

⚠ **A SCHEMA, NOT A SEPARATE DATABASE LIKE STALWART'S.** Creating a domain and
publishing its zone have to succeed or fail together, and Postgres cannot span
two databases in one transaction. The trade is that a PowerDNS upgrade may want
columns we did not write — their schema is stable and they publish the ALTERs,
so that is a migration to write rather than a surprise.

⚠ **THE `pdns` ROLE REACHES NOTHING BUT ITS OWN SCHEMA.** It is the one process
here answering unauthenticated queries from the whole internet, and it has no
grant on `core` or `authd`.

### What delegation actually grants us

⚠ **THE SUBTREE, AND NOTHING ELSE.** `mail.example.com. NS ns1.i10.tech.` in the
parent zone means resolvers are referred to us for `mail.example.com` and
everything below it. Queries for the apex, `www.`, `app.`, or their inbound MX
go to **their** nameservers; we are never consulted and cannot answer. Creating
`app.example.com` on a customer's behalf is not something delegation makes
possible.

What it does grant is everything under the delegated names — we could serve
`anything.mail.example.com`. That is inherent to NS delegation: the subtree is
the smallest unit DNS has. Anything narrower means them keeping control and
handing us an API credential to their whole zone instead, which is a strictly
worse trust trade.

⚠ **TWO OF THE THREE NAMES CANNOT HOST ANYTHING.** `_domainkey` and `_dmarc` are
underscore-prefixed, which RFC 1123 excludes from hostnames — no browser
resolves them, no public CA issues for them. Only `mail.` is an ordinary label,
and it has to be: SMTP envelope domains must be valid hostnames, so the return
paths cannot hide behind an underscore.

**A narrower mode is available if that residual still matters:** delegate
`_domainkey` and `_dmarc` only, and leave the return paths as manual records.
DKIM rotation — the thing that actually needs to change without asking — stays
ours, and the delegated surface becomes names that cannot serve a website at
all. The cost is four manual records instead of zero.

### ⚠ Cloudflare cannot host these zones below Enterprise

Verified against their docs, 2026-09-05.

| feature                                                          | plan required                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| **Subdomain setup** (hosting `mail.example.com` as its own zone) | **Enterprise only** — Free, Pro and Business all "No" |
| Zone custom nameservers                                          | Business or Enterprise                                |
| Account custom nameservers                                       | Business (via support) or Enterprise                  |

⚠ **AND THE BLOCKER IS NOT THE BRANDING.** Accepting Cloudflare-branded
nameservers removes the custom-nameserver requirement entirely — but subdomain
zones are a separate Enterprise feature, and that is what this design needs.
Zone custom nameservers would not help either: their names must be subdomains
of the zone itself, so they would be `ns1.<customer>.com`, never `ns1.i10.tech`.

**Route 53 hosts a subdomain zone natively on no particular tier**, at $0.50 per
hosted zone per month plus queries — trivial at ten customers, $500/month at a
thousand. That is the realistic first move off the box.

### ⚠ One machine is the real cost, and it is not hypothetical

A customer publishing records in their own provider keeps resolving whatever
happens to us. **A delegating customer stops resolving at all** — no DKIM, no
SPF, no return path — and their mail fails while their domain looks fine.
Listing two nameserver names that point at one box buys the appearance of
redundancy, not the fact of it.

That is the reason to move this to **Cloudflare** (preferred — their anycast and
edge are the point) or Route 53, not a reason the current shape is fine. The
port is `DnsZones`; the zone contents do not change with the provider.

⚠ **AND THE SOA SERIAL IS A CONSTANT TODAY.** That is safe only because nothing
transfers these zones. The moment a secondary exists — which is how this stops
being a single point of failure — it has to increase on every write.

---

## Open

- [x] **The mailbox lever. Built 2026-09-17.** `core.mailbox_route(sender_domain)`
      (0036) returns the name of a Stalwart route — `mx` or `ses-relay` — and
      `MtaOutboundStrategy.route` calls it with
      `sql_query('i10', 'SELECT core.mailbox_route($1)', [sender_domain])`. The
      expression is evaluated per recipient and awaited, so the tier is a live
      lookup: a plan change takes effect on the next message, not the next
      deploy.
      ⚠ **THE RULE NOW EXISTS TWICE, AND THAT IS UNAVOIDABLE RATHER THAN
      SLOPPY.** Transactional mail is routed in TypeScript because our worker
      owns the message; mailbox mail is submitted straight into Stalwart's queue
      by a person's mail client, so the only place left to decide is Stalwart and
      the only way to ask us is a query. `core.resolve_route` mirrors
      `resolveRoute`, and the case table is asserted in BOTH — `ASSERT`s in the
      migration, which fail the DEPLOY if the SQL is wrong, and the identical
      table in test/domains-route.test.ts. Same order, same values, so they read
      side by side in a diff.
      ⚠ **`sender_domain` IS THE RETURN PATH, NOT THE `From:` HEADER, AND THAT IS
      THE TRAP.** `QueueEnvelope::resolve_variable` maps it to
      `return_path.domain_part()`. This expression sees EVERY message in the
      queue including our own transactional sends, whose envelope is
      `bounce.<domain>` — so without a guard it could re-route a direct-routed
      message onto SES, giving it a return path SES does not own and breaking the
      SPF alignment the whole direct route was built for. The `hosts_mailboxes`
      join is the guard: a `bounce.` subdomain matches no row, a send-only domain
      is not a mailbox domain, and both answer `mx`.
      ⚠ **TWO SWITCHES, NOT ONE.** The transactional route uses the SES API;
      mailbox mail can only use SES SMTP, because Stalwart's outbound has no HTTP
      hook. Different credentials, independently available, so
      `SES_RELAY_ENABLED` is separate from `SES_ENABLED` — and it defaults OFF,
      where `SES_ENABLED` defaults on. Shipping this migration moves no mail.
      ⚠ **AND THE RULE'S OTHER TWO INPUTS ARE ENVIRONMENT VARIABLES A FUNCTION IN
      POSTGRES CANNOT SEE.** `core.routing_settings` is a one-row projection the
      API upserts at boot from `env`. Without it the kill switch would move
      transactional mail and leave human mail pointed at the thing that is down.
      The environment stays the authored source; nobody edits that row by hand.
- [ ] **The `ses-relay` route itself.** Deliberately NOT in `plan.ndjson`: it
      needs SES SMTP credentials that do not exist yet, and a plan referencing a
      missing environment variable is a plan that may not apply. Paste-ready
      block and the exact order of operations are in
      `infra/k8s/i10/stalwart/config/README.md`.
      ⚠ **AN UNKNOWN ROUTE NAME FALLS BACK TO MX**, logging `Smtp(IdNotFound)` —
      `get_route_or_default` in crates/common/src/network/mta.rs. So the failure
      mode of shipping the lever early is mail leaving the way it does today.
- [ ] **`resolveRoute`'s comment and its code disagree, and the code wins.** The
      comment says "free is the DEFAULT... anything we do not recognise as a paid
      plan lands here", warning that otherwise "a plan id renamed in the
      catalogue would start spending SES money on free tenants". The code
      recognises FREE by name and treats everything else as paid — so renaming
      the free plan without moving `METERING_FREE_PLAN_ID` puts every free tenant
      on SES, which is exactly the outcome the comment claims to prevent. Found
      2026-09-17 while mirroring the rule into SQL. The SQL mirrors the CODE, so
      the two levers agree; whether the rule should change is a pricing decision.
- [x] ~~The transactional lever.~~ **Built 2026-09-16.** `stalwartTransport`
      beside `sesTransport`, selected per message from
      `core.domains.transactional_route`. The worker signs with the domain's own
      DKIM key before submitting over SMTP, so one key serves both routes and
      the message a recipient gets does not depend on which MTA carried it.
      ⚠ **THE ROUTE IS PER CLASS, NOT PER DOMAIN, AND ONE COLUMN COULD NOT SAY
      SO.** `delivery_route` was a single value, so it could not express a
      customer whose humans send through our MTA while their API traffic goes
      through SES — which is the control this was built for. Split into
      `transactional_route` and `mailbox_route`, each read by a different
      reader, neither entitled to a different answer for its own class.
      ⚠ **AND METERING NEEDED NOTHING.** `handleBatch` bills on the `sent`
      outcome and never names a provider, so a direct send meters as an `emails`
      unit at the same price the moment the transport returns. Mailbox mail is
      billed by seats and storage and is not a send at all.
- [x] ~~DKIM on the direct route.~~ **Decided 2026-09-14: the transport signs,
      not Stalwart.** `dkim_private_key_sealed` was written at domain creation
      and read by NOTHING — uploaded to SES as BYODKIM and thereafter inert. On
      the direct route nothing would have signed at all.
      ⚠ **UNSIGNED IS NOT A DELIVERABILITY NIT HERE, IT IS A DMARC FAILURE.**
      Both routes now align on SPF as well, so this is no longer load-bearing
      alone — but it was the whole of DMARC on the direct route for as long as
      the return path was ours.
      ⚠ **THE WORKER SIGNS BEFORE SUBMISSION** so Stalwart needs no per-domain
      key and no config push per customer, and the key stays where
      `secrets.open` already lives. Canonicalization is taken from a library:
      relaxed/relaxed folding and body-hash CRLF rules are where hand-rolled
      signers fail silently and late.
      ⚠ **THE LIBRARY IS upyo AS OF 2026-09-17, AFTER mailauth AND THEN
      nodemailer.** mailauth cost 1.4 MB and ten transitive dependencies for one
      function out of a full SPF/DKIM/DMARC/ARC/BIMI suite, and its types
      disagreed with its runtime — passing the options the way `DKIMSignOptions`
      demanded returned `{ signatures: "\r\n", errors: [] }`, no signature and
      no error, and the message went out unsigned. nodemailer replaced it and was
      correct, but it fails a constraint that is not negotiable: it needs
      `node:net` and `node:crypto`, so it can never run in a Worker.
      ⚠ **upyo SIGNS WITH WEB CRYPTO, WHICH IS THE WHOLE REASON.** Only its
      `smtp` package imports `node:` at all — `core`, `mime`, `jmap`, `ses` and
      the rest are edge-safe — so the signer, the SES route and a future JMAP
      transport all run wherever `fetch` does. Stalwart implements JMAP
      `EmailSubmission/set` natively, so the direct route has a path off sockets
      entirely when sending moves to Workers.
      ⚠ **AND IT IMPROVED TWO THINGS BESIDES.** It takes the bare base64 DER the
      column already holds, so the PEM re-armouring step is gone; and it THROWS
      on a key it cannot import, where nodemailer returned the message
      essentially untouched and left a hand-written regex as the only thing
      between an unusable key and mail recorded as signed.
      ⚠ **THE SIGNER IS `@upyo/mime/internal`, A DECLARED SUBPATH WITH A WEAKER
      PROMISE THAN THE ROOT.** The package documents it as "additively
      compatible within a minor release line", so `@upyo/mime` is PINNED EXACTLY
      rather than carried on a caret — a minor bump is the one thing allowed to
      move this surface. The root API is not an option: `composeMessage` signs a
      message it builds itself, and we need the signature over the bytes
      `buildRawMessage` already produced, because the SES route sends those same
      bytes. Composing twice is how a route lever stops being invisible.
      ⚠ **VERIFIED AGAINST AN INDEPENDENT VERIFIER, NOT AGAINST ITSELF.**
      Seventeen message shapes — plain, `multipart/alternative`,
      `multipart/mixed`, unicode subjects and bodies, emoji, 50 recipients,
      custom headers, attachments with non-ASCII and apostrophed filenames — were
      signed and then checked with mailauth's verifier, plus one full SMTP round
      trip against a local server. All `pass`. A signer tested only by its own
      library is a signer tested by nobody.
- [x] **Two latent composer bugs, found because upyo validates the bytes.**
      `sendRaw` is handed the message with no `encoding`, which makes upyo read
      it once to classify it — and that pass enforces CRLF endings, the
      998-octet line limit and the absence of NUL. It immediately refused two
      messages the SES route had been accepting.
      ⚠ **`To:` WAS NEVER FOLDED, AND THE CONTRACT ALLOWS 50 ADDRESSES OF 320
      CHARACTERS.** That is sixteen kilobytes on ONE LINE, against RFC 5322's
      998-octet hard limit. SES took those messages and did whatever it does;
      the direct route refuses them outright — so the same send worked or failed
      depending on the route, which is precisely the difference this design
      exists to prevent. `mime.ts` now folds address lists between addresses,
      unstructured headers at whitespace, and splits over-long RFC 2047
      encoded-words (which are capped at 75 characters and cannot be folded,
      because folding needs whitespace and there is none inside one).
      ⚠ **AND A NON-ASCII ATTACHMENT FILENAME WENT INTO THE HEADERS RAW.**
      `réçu.pdf` put UTF-8 bytes straight into `Content-Type` and
      `Content-Disposition`. Headers are ASCII; upyo classified such a message
      as needing SMTPUTF8 and would refuse it to a server without that
      capability. Now RFC 2047 for the deprecated `name=` and RFC 2231
      (`filename*=UTF-8''…`) for `Content-Disposition` — with `'`, `(`, `)` and
      `*` percent-escaped, since `encodeURIComponent` leaves all four and the
      first two are the delimiters of the syntax itself. An ASCII filename is
      untouched, byte for byte.
      ⚠ **THE ENVELOPE ALSO NEEDED UNWRAPPING, WHICH nodemailer DID FOR US.**
      `RCPT TO` takes a bare addr-spec; `Bob <bob@x.test>` parses as a local part
      of `Bob <bob` and is invalid. Every send with a display name in `to` was
      relying on behaviour the new client does not have — `addressOf` in
      send/address.ts is now the one place that strips it, and an unparseable
      recipient REJECTS the message rather than being quietly dropped from the
      envelope and reported as sent.
- [x] **A 5xx on `AUTH`, `EHLO`, `STARTTLS` or the greeting is deferred, not
      rejected.** A mistyped submission password answers `535` for EVERY
      message, so classifying a hard 5xx as a verdict on the message would burn
      the entire backlog to `failed` within one batch, each row blaming the
      message rather than the credential. Only `MAIL FROM`, `RCPT TO` and `DATA`
      carry a verdict about this message.
      ⚠ **AND `receipt.retryable` IS NOT TRUSTED.** upyo sets it from a
      structured classification when it recognises the failure and from
      SUBSTRING MATCHING ON THE ERROR TEXT when it does not — a fallback that
      ends `{ category: "unknown", retryable: false }`. Taken at face value, an
      expired certificate ("unable to verify the first certificate" matches
      nothing) would be permanent and would destroy every message in the queue.
      The `smtp.` prefix is the discriminator: upyo emits it only from branches
      where it recognised a specific condition, and its guessing fallback
      produces bare codes. Our rule is unchanged — an error we cannot read is
      temporary.
- [x] ~~Automatic failover when SES is unhealthy.~~ **Rejected 2026-09-14 in
      favour of an operator kill switch** (`SES_ENABLED`, an input to
      `resolveRoute`). `Transport` already absorbs a bad SES day: a throttle or
      a 500 returns `deferred` and the message goes back on the queue. A health
      probe only helps in a sustained outage, and it would make the route
      time-varying — so the dashboard, the API and Stalwart could disagree about
      one domain at one moment, which is exactly what `route.ts` exists to
      prevent. It would also move a paying customer onto our IP reputation with
      no human deciding to.
- [ ] The `pdns` ROLE ITSELF, WHICH 0023 NO LONGER CREATES. `CREATE ROLE` needs
      CREATEROLE and the migration connects as `i10`, which does not have it —
      so 0023 failed on its first real run and blocked 0024-0028 behind the
      PreSync hook. Roles are CNPG's job here (`platform-db/cluster.yaml`,
      `managed.roles`), so the role, its Doppler config and its password secret
      arrive with the deployment below, along with the five grants 0023 now
      lists in a comment instead of applying.
- [ ] The PowerDNS deployment: a manifest, the `pdns` role's password, and the
      glue records for `ns1`/`ns2` at the registrar. ⚠ **None of this exists
      yet** — the zones are written and nothing serves them.
- [ ] Moving zones off the box. ⚠ **Cloudflare is not the answer for this, and
      it is verified rather than suspected** — see below.
- [x] ~~`_spf.i10.tech` does not resolve.~~ **Applied and verified
      2026-09-17.** `dig TXT _spf.i10.tech` answers
      `v=spf1 include:amazonses.com a:mail.i10.tech -all`, and
      `mail.i10.tech` resolves to an unproxied address — which is the whole
      point of the `a:` mechanism, since a Cloudflare-proxied name would
      authorise their anycast range to send as every customer.
      ⚠ **THIS WAS THE RELEASE GATE ON THE DIRECT ROUTE.** Until it applied,
      every `bounce.<domain>` TXT included a domain that did not exist, which is
      an SPF **permerror** — strictly worse than publishing nothing.
- [x] ~~Ingesting direct-route DSNs into `core.message_events`.~~ **Done
      2026-09-17, and NOT by parsing DSNs.** Stalwart pushes its own delivery
      outcomes to `/webhooks/stalwart`, signed HMAC-SHA256 over the raw body in
      `X-Signature`. It is the process attempting delivery, so it knows the
      answer before any DSN could be written — and it reports `delivered`, which
      a DSN never does unless success notification was requested. The alternative
      needed an MX for every customer's `bounce.<domain>`, Stalwart configured to
      accept those domains, a mailbox to read and an RFC 3464
      `multipart/report` parser; none of that exists and none of it was needed.
      ⚠ **THE JOIN KEY IS STILL THE VERP ENVELOPE, AND IT ARRIVES FROM THE SPAN
      RATHER THAN THE EVENT.** `delivery.delivered` carries only `spanId`,
      `hostname`, `to`, `code`, `details` and `elapsed`; the envelope sender is
      set on `delivery.attempt-start`, which opens the span. Stalwart's collector
      attaches the open span to every event sharing its id and the webhook
      serializer is built `.with_spans()`, so the span's keys merge into `data`.
      Read out of the source rather than assumed — the alternative, correlating
      outcomes to an earlier `attempt-start` by `queueId`, needs state we would
      have to keep and expire ourselves.
      ⚠ **STALWART'S OWN EVENT `id` IS NOT A DEDUPE KEY, AND USING IT WOULD HAVE
      BEEN THE BUG.** It is `{timestamp}{counter}{typeId}` where the counter is a
      process-global atomic incremented AT SERIALISATION TIME. A failed POST puts
      the same events back on the pending list and the next batch serialises them
      again with fresh values — so the "unique identifier" differs on every
      redelivery, and keying `(source_event_id, occurred_at)` on it would turn
      each retry into a second `email.bounced`, a second suppression and a second
      customer webhook. `sourceEventIdFor` derives a stable key from type,
      timestamp, queue id and recipient, namespaced `stalwart_` so it cannot
      collide with an SNS message id in the same column.
      ⚠ **AND THAT DEDUPE IS A SECURITY CONTROL HERE, NOT TIDINESS.** Stalwart's
      signature covers the body and nothing else — no timestamp, no nonce — so a
      captured request is replayable forever.
      ⚠ **ONE SUPPRESSION PATH, AND ONLY ON A 5xx REFUSAL OF THE RECIPIENT.**
      `delivery.failed` is the retry window expiring (the receiver was down,
      which says nothing about the address) and `delivery.message-rejected` is
      about the message. Both are `email.bounced`; neither suppresses. That is
      the same Permanent/Transient discipline the SES ingest applies, in a
      different vocabulary.
      ⚠ **BOTH ROUTES WRITE THROUGH ONE `ingestEvent`.** The dedupe, the
      suppression write, the endpoint fan-out and the customer payload shape are
      one implementation rather than two that agree today — a customer must not
      be able to tell from a webhook which MTA carried their message.
- [ ] **Asynchronous bounces on the direct route.** A receiver that answers `250`
      and only later decides the mailbox is gone sends a DSN to the envelope
      sender, and we accept no inbound mail for customer `bounce.` domains. Those
      bounces are invisible. This is the half the VERP envelope was originally
      built for and it is still open — it needs the MX, the accepted domains, a
      mailbox and a `multipart/report` parser.
- [ ] **Complaints on the direct route.** Feedback loops arrive as ARF reports by
      mail, not as delivery outcomes. SES subscribes to them on our behalf; our
      own MTA does not, so a direct-routed message can be complained about and
      `email.complained` will never fire. Needs the same inbound path as the item
      above, plus FBL enrolment per sending IP.
- [x] ~~The NetworkPolicy does not admit the API pods on 587.~~ **It never
      needed to. Disproved 2026-09-17.** NetworkPolicies are ADDITIVE, and
      `i10-prod` carries `allow-same-namespace` — `podSelector: {}` with
      `from: namespaceSelector(i10-prod)` — which admits every pod in the
      namespace to every other pod on EVERY port. `allow-public-mail` governs
      only what the INTERNET may reach, because it has no `from` at all.
      Confirmed by probing from a throwaway pod in the namespace: EHLO answered,
      `AUTH PLAIN LOGIN XOAUTH2 OAUTHBEARER` advertised.
- [x] ~~The worker dials 587.~~ **Wrong port, fixed 2026-09-17.** The real
      blocker was never the policy: **Stalwart has no 587 listener.** Its
      `NetworkListener` set is `smtp` on 25, `submissions` on 465, plus IMAP,
      POP3, ManageSieve and HTTP — `ss -ltn` in the pod agrees. A worker pointed
      at 587 gets no connection at all.
      ⚠ **AND 465 IS THE BETTER PORT, NOT A WORKAROUND.** It is implicit TLS
      from the first byte; 587 is cleartext until STARTTLS succeeds. RFC 8314 §3
      prefers the former precisely because there is no plaintext phase to strip,
      so there is no reason to add a listener. `STALWART_SUBMISSION_PORT` now
      defaults to 465 and `submissionConfig` derives the TLS mode from it.
      ⚠ **THE OLD DEFAULT WAS 587, WHICH MEANS THE DEFAULT WAS UNUSABLE.** A
      deployment that set the host, user and password and trusted the rest would
      have had every direct send refused at the socket — `deferred`, in the
      queue, behind an ECONNREFUSED nobody reads.
- [ ] **The submission account's password.** The account exists —
      `submission@i10.tech`, created 2026-09-17 in Stalwart's own store — but it
      has no credential yet, so the worker still cannot authenticate.
      `./bootstrap.sh --set-submission-password` prompts for one, sets it, and
      leaves the four values in the `i10-stalwart-submission` Secret to copy into
      Doppler's `prod_api` config. That config is what `i10-api` syncs and what
      `worker.yaml` already mounts wholesale, so **no manifest change is needed**
      — the same route `STALWART_API_TOKEN` took.
      ⚠ **AN ACCOUNT IN STALWART'S OWN STORE, NOT IN authd, AND THAT IS THE
      POINT.** Every principal authd knows is a Clerk user: `filterLogin` is
      `(objectClass=inetOrgPerson)(mail=?)` over a projection of Clerk, and a
      bind is a `verify_password` call. A machine in there would be an invented
      person — a Clerk user with a password we rotate, visible to the identity
      system that exists for customers, and one Clerk outage away from the send
      worker being unable to send. `metering@i10.tech` set this precedent on
      2026-09-06.
      ⚠ **TWO PERMISSIONS OUT OF 660**, as `Replace` rather than `Inherit`:
      `authenticate` and `emailSend`. The default user role carries the whole
      mailbox surface, none of which a submission client can use. A credential
      that leaks can post mail and cannot read any.
      ⚠ **AND IT IS THE ACCOUNT PASSWORD RATHER THAN AN `AppPassword`, WHICH WAS
      NOT THE FIRST CHOICE.** `AppPassword` carries `allowedIps` and its own
      permission set, both worth having — but an administrator cannot create
      one: `create AppPassword` answers `notFound` with or without an account
      id, because an app password is minted by the holder inside their own
      session, and there is no holder here to log in as. Setting `credentials`
      on the account directly is refused too ("Secondary credentials cannot be
      set directly"). `AccountPassword.secret` is mutable and is what is left, so
      the narrow grant is the control rather than the source address.
- [x] ~~Sender validation would refuse arbitrary customer domains.~~ **Not a
      problem, checked 2026-09-17.** `MtaStageMail.isSenderAllowed` is
      `!is_empty(authenticated_as) || !key_exists('spam-block', sender_domain)`
      and `MtaStageRcpt.allowRelaying` is `!is_empty(authenticated_as)` — so an
      authenticated session may already send as any domain to any recipient. No
      MTA rule changes are needed for the direct route.
- [x] ~~i10's own bounce domain for the direct route.~~ **Superseded
      2026-09-14** — the return path is the customer's `bounce.<domain>`, not a
      name on i10.tech, so that SPF aligns. See "Custom MAIL FROM stays".
- [x] ~~`MAIL_BOUNCE_HOST` pointing at a proxied name.~~ **Fixed 2026-09-14.**
      It defaulted to `mx.i10.tech`, which resolves to Cloudflare's anycast
      proxy and does not carry SMTP — every direct-route bounce would have been
      delivered nowhere. Now `mail.i10.tech`, which is unproxied precisely
      because `spf_include` names it with `a:`.
- [x] ~~Which tier gets which route.~~ **Decided 2026-09-05: free sends direct,
      paid sends through SES**, with a per-domain override for support.
      `resolveRoute` in `src/domains/route.ts`.
      ⚠ **`auto` is stored, not the resolved answer.** Freezing today's policy
      into rows would make a pricing change a backfill.
      ⚠ **Free is the default branch, not a special case** — anything not
      recognised as a paid plan sends direct, so a plan id renamed in the
      catalogue cannot start spending SES money on tenants who pay nothing.
      ⚠ Free traffic on our own IP is still the abuse surface, on an address
      shared with PSL. Revisit when there is volume.
- [x] **A readout for `sent_route`. Added 2026-09-17.** The column had been
      written on every `sent` row since 0033 and read by NOTHING — the only way
      to ask "how much went direct" was to open psql and write the query by
      hand, which is how a column quietly stops being correct.
      `core.route_split_snapshot(from, to)` (0035) returns tenant, day, route and
      count; the reconcile CronJob folds it into one `route split` log line per
      run, which is the surface that needs no auth design and that somebody is
      already looking at. An HTTP endpoint was the alternative and would have
      been dead weight from the first commit.
      ⚠ **IT IS NOT METERING AND MUST NEVER BECOME IT.** `sent_usage_snapshot`
      counts `sent` rows with NO route predicate — one price, both routes, which
      is the whole commercial decision. This asks a different question of the
      same rows: how much SES are we buying, and how much of our own IP
      reputation are we spending. There is a test asserting the billing query
      contains no route predicate, because the day one migrates into the other,
      free-tier mail silently stops being billable.
      ⚠ **AND IT IS OURS, NOT THE CUSTOMER'S.** Publishing the split on the
      customer API would make the route visible in the product — a customer
      would see their mail move to our MTA when their plan changed and would
      reasonably ask to choose. The lever is an operational decision with no
      product surface, so the readout is privileged and stops at the reconciler.
      ⚠ **`unknown` IS A FAULT, NOT A CATEGORY.** Every `sent` row has carried a
      route since 0033, so one without means a write path skipped it. It is
      counted separately and raises in the reconcile job rather than being folded
      into `ses`, where it would add up to a plausible number and never be found.
- [ ] DKIM key rotation. The random selector makes it possible; nothing does it.
