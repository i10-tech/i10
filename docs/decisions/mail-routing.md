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

⚠ **This was already the decision. `core.domains` has carried `dkim_selector`,
`dkim_public_key` and `dkim_private_key_ref` since it was written.** Migration
0018 introduced Easy DKIM against it and 0020/0021 undo that. Recording the
reasoning here so the next person does not make the same trade.

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

## The four records

| record | name                             | type                   |
| ------ | -------------------------------- | ---------------------- |
| SPF    | `send.<domain>`                  | MX → SES feedback host |
| SPF    | `send.<domain>`                  | TXT                    |
| DKIM   | `<selector>._domainkey.<domain>` | TXT                    |
| DMARC  | `_dmarc.<domain>`                | TXT                    |

### SPF names us with an `include:`, never an address

`v=spf1 include:amazonses.com include:_spf.i10.tech ~all`

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
and SES requires its own feedback host there. Direct sends therefore do **not**
use the customer's return path: they use i10's own bounce domain as the envelope
sender, which needs no record in the customer's DNS at all.

⚠ **DMARC still passes on both routes**, because it needs SPF _or_ DKIM
aligned and BYODKIM aligns on the customer's domain either way. The SES route
has both.

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

- [ ] The tier → route function itself, and the Stalwart config that calls it.
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
- [ ] i10's own bounce domain for the direct route, and ingesting those bounces
      into `core.message_events` the way SES's already are.
- [x] ~~Which tier gets which route.~~ **Decided 2026-09-05: free sends direct,
      paid sends through SES**, with a per-domain override for support.
      `resolveRoute` in `src/domains/route.ts`; `core.domains.delivery_route`
      holds `auto | ses | direct`.
      ⚠ **`auto` is stored, not the resolved answer.** Freezing today's policy
      into rows would make a pricing change a backfill.
      ⚠ **Free is the default branch, not a special case** — anything not
      recognised as a paid plan sends direct, so a plan id renamed in the
      catalogue cannot start spending SES money on tenants who pay nothing.
      ⚠ Free traffic on our own IP is still the abuse surface, on an address
      shared with PSL. Revisit when there is volume.
- [ ] DKIM key rotation. The random selector makes it possible; nothing does it.
