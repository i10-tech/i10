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

- [ ] **The mailbox lever: Stalwart's `MtaOutboundStrategy` expression and the
      `SECURITY DEFINER` function it calls**, plus the SES SMTP credentials for
      the relay. ⚠ **Deferred 2026-09-14** — it also needs per-domain
      provisioning into Stalwart, which nothing does, and that arrives with
      `hosts_mailboxes`. `core.domains.mailbox_route` is stored and rendered in
      the meantime and **read by nothing**, exactly as `delivery_route` was.
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
      ⚠ **AND mailauth@5's TYPES DISAGREE WITH ITS RUNTIME, WHICH COST A ROUND
      OF THIS.** `DKIMSignOptions` requires `signingDomain`, `selector` and
      `privateKey` at the top level and marks `signatureData` optional. Passing
      them the way the types demand returns `{ signatures: "\r\n", errors: [] }`
      — no signature, no error — and the message goes out unsigned. The call
      uses `signatureData` with a cast, and `signMessage` rejects a
      whitespace-only signature rather than a falsy one, because the empty
      answer is `"\r\n"` and a truthy-check misses it.
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
- [ ] **⚠ `_spf.i10.tech` DOES NOT RESOLVE, AND IT IS A RELEASE GATE.** The
      `spf_include` resource exists in `infra/tofu/stacks/dns/main.tf` and has
      never been applied — `variables.tf`'s validation message says so outright.
      Until it is, every `bounce.<domain>` TXT includes a domain that does not
      exist, which is an SPF **permerror**: strictly worse than publishing
      nothing. Nothing may route direct before this applies.
- [ ] **Ingesting direct-route DSNs into `core.message_events`.** The envelope
      sender is already VERP — `bounce+<messageId>@bounce.<domain>` — so the id
      comes back on the DSN and correlating one is a parse. What does not exist
      is anything receiving them: Stalwart accepts no inbound for customer
      `bounce.` domains, and nothing parses a DSN into an event.
      ⚠ **UNTIL THIS LANDS, A DIRECT-ROUTED MESSAGE HAS NO `delivered`,
      `bounced` OR `complained`** — `core.message_events` is written only by the
      SES ingest. `ses_unconfirmed_snapshot` no longer reports those rows as
      discrepancies (0033), so the silence is at least not also an alarm, but a
      customer watching webhooks sees a message that stops at `sent`.
- [ ] **Stalwart's submission account and the NetworkPolicy to reach it.** The
      worker dials `STALWART_SUBMISSION_HOST`; nothing creates the credential it
      authenticates with, and `infra/k8s/i10/stalwart/networkpolicy.yaml` does
      not admit the API pods on 587. Without both, every direct send answers
      `deferred` and waits in the queue — which is the designed failure, not a
      silent one.
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
- [ ] DKIM key rotation. The random selector makes it possible; nothing does it.
