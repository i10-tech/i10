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

## Open

- [ ] The tier → route function itself, and the Stalwart config that calls it.
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
