# Metering, and getting off Autumn

**Decided:** 2026-09-04. **Status:** steps 2–4 shipped. Autumn still runs and
is no longer wired to anything.

⚠ **The pricing model was added on 2026-09-05 and the sequence below predates
it.** Steps 1–7 describe a transactional product on a fixed allowance. Included
usage with billed overage, and human mail's seats and storage, are in "What we
sell, and who computes the money" — and they need a second feature kind that
`packages/metering` does not have. Nothing shipped is wrong; it is half a
product.

The reasoning below is preserved as it was argued, not rewritten as work lands
— the sequence at the bottom is the only part that tracks state. Autumn keeps
running until the current end-to-end pass is finished.

---

## Why

The box is a **CX33: 4 vCPU / 8 GB**, shared with PSL. i10's own requests are
about **3.6 GiB of the 8**, and the largest single line is Autumn:

|                                                     | requests     |
| --------------------------------------------------- | ------------ |
| Autumn (server + 2 workers + dashboard + ElasticMQ) | **~1.3 GiB** |
| Stalwart + Bulwark                                  | ~830 MiB     |
| CNPG + Redis                                        | 640 MiB      |
| api, worker, web, console, docs                     | ~830 MiB     |

⚠ **This is not a load problem.** Every i10 workload is `replicas: 1` and KEDA
sits at zero. The memory is consumed by control planes and self-hosted vendor
software, not by users. Distribution does not fix a tenancy problem.

### Why Autumn specifically

From `infra/autumn/server.Dockerfile`, measured on this cluster: four worker
processes hold 1875 MiB, one holds 630 MiB — about **470 MB per process**, and
that baseline is Autumn's module graph: Stripe, Drizzle, ioredis,
OpenTelemetry, Sentry, Better Auth, DuckDB, S3, Svix.

Line that up against what i10 already owns:

| Autumn carries   | i10 already has                               |
| ---------------- | --------------------------------------------- |
| Stripe           | **Polar** — and `no_billing_changes: true`    |
| Better Auth      | **Clerk**                                     |
| Svix             | our own `apps/api/src/webhooks/` with signing |
| Sentry + OTel    | `apps/api/src/observability.ts`               |
| DuckDB, S3       | not used at all                               |
| Drizzle, ioredis | already ours                                  |

We pay 470 MB per process for a second copy of our entire stack, to use the
~2% of it that decrements an integer. Stripe alone is **403 files and 15,081
references** — it is not a dependency we can prune, it is what Autumn _is_.

**Decision: replace it with our own, and do not move to hosted Autumn.**

---

## Licensing

**Autumn is Apache-2.0.** Verified against the repo, 2026-09-04. Permissive,
commercial use fine, no copyleft, no non-compete, and it carries an explicit
patent grant — which makes it _safer_ to borrow from than MIT.

⚠ **Contrast with Bulwark in this same repo, which is AGPL-3.0.** The two are
handled completely differently. Do not carry a habit from one to the other.

Obligations when we copy their code:

1. Retain their copyright notices in anything derived from their source.
2. Put a prominent notice on files we changed, saying we changed them.
3. Ship the Apache-2.0 text, and their `NOTICE` file if the repo has one.

Do this **at copy time**. All borrowed logic lands in one package with one
`NOTICE`, which is the whole reason the package boundary is worth having here.

---

## What we take from Autumn

The guiding sentence is **"how does Autumn do it?"** — with one amendment:

> **Match their semantics, not their structure.**

Their structure is shaped by being Stripe-native, multi-tenant, and at a scale
we do not have. Copying structure reimports the weight we are shedding. Copy
the decisions; let structure follow our own constraints.

⚠ **A choice we cannot explain is a flag to dig, not to copy.** A subtle
ordering we adopt without understanding is a bug we own and cannot debug.

What is actually worth taking — the domain logic, not the plumbing:

- **Balance draw-down for consumable features** — the ordering that makes
  concurrent decrements safe.
- **Reset-boundary arithmetic** — daily and monthly, and what happens at the
  boundary when a request is in flight.
- **Plan/entitlement resolution** — which allowance applies to this customer
  right now, including mid-cycle plan change.
- **Idempotent event tracking** — their dedup semantics. We already depend on
  this at `apps/api/src/send/autumn.ts` (`track` keyed on `messageId`).
- **The aggregate query shape** behind `events.aggregate`.

---

## Shape

### A package, not an app

**`packages/metering`** — pure domain logic, zero I/O. Balance arithmetic,
reset boundaries, entitlement resolution, dedup rules. Runs on Node, on
Workers, and in tests with no infrastructure.

⚠ **The reason is portability, not taste.** Written inside `apps/api` against
`pg` and `ioredis`, none of it runs on Workers and the work is done twice. The
runtime constraint forces the shape we wanted anyway.

- **Storage behind a port.** Postgres adapter now, DO-storage adapter later.
  The core never knows which.
- **Surfaces on top.** API routes now, a Worker later — same package
  underneath. There is never a Node sidecar service.
- The seam already exists: `Metering` in `apps/api/src/send/metering.ts`.
  `AutumnClient` is one implementation; we are writing the second.

### ElasticMQ: dropped

We already run Redis and groupmq/BullMQ, with two deliberately-configured
clients holding opposite failure policies (`apps/api/src/cache/redis.ts`).
ElasticMQ means operating an SQS emulator to speak a protocol nothing else in
our stack uses.

Autumn moved to SQS because they are AWS-native and did not want to run Redis
for their SaaS — a decision that suits _their_ deployment and leaks downstream
to self-hosters. Our situation is the inverse.

⚠ It is also a dead end in both directions: at the edge there is no SQS _and_
no Redis. The analog there is Cloudflare Queues.

**TODO:** confirm Autumn's actual migration reason from their commit history
rather than taking this inference. It is a "how does Autumn do it?" question.

---

## The three tiers

```
DO (gate)  →  Postgres (ledger, source of truth)  →  Polar meters (billing)
```

|                    | job                                             | consistency             | freshness  |
| ------------------ | ----------------------------------------------- | ----------------------- | ---------- |
| **Durable Object** | the gate: check, decrement, reset               | strong, single-threaded | instant    |
| **Postgres**       | the ledger: aggregates, history, reconciliation | exact                   | seconds    |
| **Polar**          | invoicing, tax, dunning, customer portal        | Polar's                 | per period |

### ⚠ The gate is approximate. The ledger is exact.

This is a **semantic commitment, made now**, and it is the one that cannot be
retrofitted. Near the limit the gate may be slightly permissive; the ledger is
the one that is exactly right.

Everything downstream depends on it. If any code, test, or customer-facing
promise assumes the gate is exact at the boundary, sharding breaks it later and
we find out via a support ticket.

### Write-behind, never write-through

⚠ **Synchronous write-through puts an edge→Hetzner round trip inside the gate**
and destroys the entire reason the counter is at the edge.

Instead:

- The DO holds balance, allowance, reset boundary, **and a buffer of unflushed
  events**.
- Flush on whichever comes first: N events or T seconds — plus always at the
  reset boundary. `alarm()` drives it, the same primitive that does the reset.
- A flush is a batch write, which is the shape `batchTrack` already has.
- A failed flush leaves the buffer intact and retries on the next alarm. DO
  storage is durable, so an evicted object does not lose it.

**Reconciliation drops from _the sync mechanism_ to _the backstop_.**
`apps/api/src/send/reconcile.ts` was always shaped for this; it just points
somewhere else.

### `messageId` is the dedup key, everywhere

The buffer entry, the Postgres row, and Polar's `external_id` all key on the
same `messageId` we already generate.

⚠ **This is the property the whole design rests on.** It is what makes every
leg independently retryable, which is what makes buffering at the edge safe.
It is the single highest-value thing to take from Autumn.

---

## Polar

### Ownership

- **Polar owns**: money, subscription state, checkout, the customer portal.
- **Metering owns**: the counter and the gate.
- **The port between them is narrow**: "what is this tenant entitled to right
  now", plus webhooks telling us when that changed.

**Why we still build a counter when Polar has meters:** Polar's meters are for
_billing_; ours is for _gating_. Billing tolerates seconds and runs monthly.
The gate sits inside `POST /emails` and needs single-digit milliseconds. A
payment provider's API structurally cannot serve the second job — which is the
entire reason Autumn exists as a category.

⚠ **Strictly one direction.** Polar's meter is a _downstream consumer_ of our
ledger, never an input to the gate. Anything that reads a balance back from
Polar to decide whether to send reintroduces the latency coupling and the
split-brain this design exists to avoid.

### Verified against `polarsource/polar`, 2026-09-04

**Ingest IS idempotent** — the docs page never says so, which is why it looked
like a gap.

- `EventCreateBase.external_id` — our own identifier for the event.
- `models/event.py`: unique index `ix_events_organization_id_external_id` on
  **(organization_id, external_id)**.
- `repository.insert_batch()`:
  `.on_conflict_do_nothing(index_elements=["organization_id","external_id"])`
- `service.ingest()` returns `{inserted, duplicates}` — so a retry is
  **observable**, not silent.

⚠ **`external_id` is NULLABLE, so dedup is opt-in.** Omit it and every retry
double-counts, with no error anywhere. Always set it, to the `messageId`.

**Backfill works. Correction does not.**

- `timestamp` can be backdated — their docs bless it for batched ingestion and
  replaying from your own queue. Flush lag is fine for _history_.
- ⚠ **But Polar attributes an event to a billing period by when Polar received
  it, not by the supplied `timestamp`.** Events are immutable — no edit, no
  delete. Their stated policy: Polar never issues retroactive invoices or
  credits for late events.

Two consequences:

1. ⚠ **The buffer must never straddle a period boundary.** Seconds of lag
   mid-month is harmless; seconds of lag across month-end moves revenue into
   the next month, permanently. Needs a hard flush before the cutoff and a
   check that the buffer is actually empty at that moment.
2. ⚠ **The reconciler cannot auto-correct a closed period** — the API will not
   accept it. A closed-period discrepancy alerts a human. That is a different
   code path from the mid-period case.

### Provider-agnostic

Do it, but for the right reason. **Not** "we might add Stripe someday" — that
is speculative. The reason is **blast radius and testability**: the port means
`packages/metering` has zero knowledge of Polar, so it runs in tests and on
Workers without Polar's SDK anywhere near it. Same constraint that makes the
package work at all.

⚠ Autumn's failure here is instructive and is not "they had no interface" — it
is that Stripe leaked into 403 files anyway. What enforces this is the package
boundary, not discipline.

---

## What we sell, and who computes the money

**Added 2026-09-05.** Everything above this line was argued for a product that
sends transactional email on a fixed allowance. That is half of i10, and the
half with the simpler billing. This section is the other half and the pricing
model both halves actually use.

### The model

**A plan paid upfront that includes an allowance, plus billed overage the
customer opts into.** Resend's shape, and deliberately so — it is what the
market already understands.

|                      | transactional                | human mail               |
| -------------------- | ---------------------------- | ------------------------ |
| paid upfront         | $20/mo                       | $/mo                     |
| includes             | 50,000 emails, N domains     | N seats, N GB, N domains |
| beyond the allowance | $0.90 / 1,000                | per seat, per GB         |
| at renewal           | $20 again, allowance refills | same                     |

⚠ **DOMAINS ARE IN THE TABLE BUT NOT IN THE OVERAGE ROW, AND THAT IS THE
POINT.** A plan grants 3 domains and the fourth is refused — nobody sells a
fourth domain for $0.30. It is a metered feature with a hard cap sitting beside
one that bills past its cap, which is why the overage policy cannot live where
the first draft of this section put it. See below.

⚠ **OVERAGE IS OFF BY DEFAULT AND THE CUSTOMER TURNS IT ON.** Until they do,
the allowance is a hard stop and the answer at the limit is a 429. That switch
is the entire difference between "your sends stopped" and "you owe us $27 you
did not expect", and it belongs to the customer rather than to us.

⚠ **AND IT IS A LIMIT, NOT A PREPAID BUCKET.** A customer who sends 50 emails
on the $20 plan pays $20, not forty cents. The upfront price buys a ceiling and
they are never billed below it — which is why the meter's job is not to price
usage but to decide, per unit, whether it falls inside the ceiling.

**PAYG is the same mechanism with the allowance set to zero.** No upfront
charge, every unit billable — for enterprises later. That it needs no new
machinery is the strongest evidence the shape above is the right one, and it is
worth protecting: any design where PAYG is a second code path is wrong.

### Polar computes the money, and it already can

Verified against `polarsource/polar`, 2026-09-05:

- **Meter** — filters and aggregates the events we ingest.
- **Metered price** — a subscription price computed from a meter.
- **Meter Credits benefit** — _"the customer will be credited the amount of
  units specified in the benefit at the beginning of every subscription cycle
  period."_

A $20 product carrying a flat price, a metered price at $0.90/1,000 and a
credits benefit of 50,000 units **is** the row in the table above. Usage draws
the credits down first; only the remainder is billed.

⚠ **SO WE DO NOT WRITE THE OVERAGE ARITHMETIC, AND WE MUST NOT.** Rounding,
tiering, currency, tax and the invoice line all belong to the party that sends
the invoice. What we own is the count that goes in — and the gate, which is a
product decision about whether to accept a send, not a pricing one.

⚠ **WHICH MEANS THE INGEST SHIPS EVERY UNIT, NOT ONLY THE BILLABLE ONES.**
**Built 2026-09-05** (`src/metering/ingest.ts`). The tempting design is to
compute the included/billable split ourselves and send only the remainder; it
is wrong twice. The credits benefit already draws the allowance down before the
metered price charges anything, so splitting here reimplements arithmetic Polar
owns — and a customer who enables overage next month would have a meter that
never saw the usage before it. `overage` is therefore a GATE outcome only: it
decides whether to accept the send, and it computes no money.

The flush is `POST /v1/events/ingest`, keyed on `external_id` = our message id,
addressed by `external_customer_id` = our tenant id (which Polar already echoes
on every subscription webhook). It runs as a leg of the reconcile CronJob and is
bounded per pass; `core.meter_events.ingested_at` is the per-row watermark, so
an interrupted flush resumes rather than skipping.

⚠ **POLAR FIRST, THE WATERMARK SECOND.** Marking before posting loses units on
any failure. Posting before marking can only re-send, and their ingest answers
`inserted` / `duplicates` — so a retry costs a request and bills nobody twice.
Only one of the two orders can lose revenue.

### ⚠ The gate must mirror the credits, not the plan's headline number

This is the sharp edge of the whole section, and it is a customer-trust
failure rather than an accounting one.

Our gate decides what a customer is told is included. Polar's credits decide
what they are actually billed for. If those two numbers disagree, the customer
is charged for units our own dashboard called free — and they find out on an
invoice, which is the worst possible place.

Whether they disagree at a mid-cycle plan change turns out to be **our choice,
not Polar's policy** — and the wrong choice is the default one.

#### Traced through `polarsource/polar`, 2026-09-05

`subscription/service.py::update_product` calls `enqueue_benefits_grants`
unconditionally after a product change. That function diffs:

```python
granted_benefit_ids = {g.benefit_id for g in existing_grants if g.is_granted}
grant_benefit_ids   = [b.id for b in product.benefits
                       if b.id not in granted_benefit_ids and ...]
outdated_grants     = await repository.list_outdated_grants(product, **scope)
revoke_benefit_ids.extend(g.benefit_id for g in outdated_grants)
```

and `grant_benefit` returns early on `elif grant.is_granted:` — the strategy is
never invoked for a benefit already held.

For a Meter Credits benefit the two strategy methods are
(`benefit/strategies/meter_credit/service.py`):

- `grant` → posts a **`+units`** event on the meter, immediately.
- `revoke` → posts **`-last_credited_units`** — the whole original grant, not
  the unused remainder.

So there are two behaviours, and they are selected by how the products are
built:

**Each plan carries its OWN credits benefit.** The old benefit is outdated →
revoked → `−50,000`. The new one is not yet granted → granted → `+100,000`.
A customer who had used 45,000 goes `5,000 → −45,000 → 55,000`.

⚠ **THAT IS EXACTLY `draw({allowance: 100_000, used: 45_000})`.** Ceiling
raised, usage kept, boundary unmoved — the model we want, and the same number
our gate computes, by construction rather than by correction.

**Both plans SHARE one credits benefit.** It is already granted, so it is
neither revoked nor re-granted, and nothing happens until the next cycle. The
customer keeps 5,000 credits while our gate offers 55,000 — and is billed
overage on 50,000 units the dashboard called included.

⚠ **SO: EVERY PLAN GETS ITS OWN METER CREDITS BENEFIT. NEVER SHARE ONE.** It
looks like harmless deduplication in the Polar dashboard — one "50,000 emails"
benefit reused across products — and it is the difference between the two
paragraphs above. Nothing in Polar's UI will warn about it.

⚠ **AND `rollover` MUST BE OFF.** `revoke` claws back `last_credited_units`,
which with rollover on is not the plan's headline number, and the cancellation
above stops being exact.

⚠ **THE ANSWER IS NOT TO READ POLAR ON THE SEND PATH.** That is precisely the
mistake removed by replacing Autumn, and re-introducing it for a different
vendor would not be an improvement. Mirror the rule, reconcile the number, and
make the reconciler carry the included figure as a third quantity beside what
we sent and what we counted.

### What this changes in `packages/metering`

**1. `draw()` needs a third outcome.** Today: `allowed` | `exceeded`. Needed:
`allowed` | `overage` | `exceeded`.

⚠ **AND THE OVERAGE POLICY IS PER-ENTITLEMENT, NOT PER-TENANT.** The obvious
design — one "allow overage" column on the tenant — is wrong the moment
`domains` exists beside `emails`: the same tenant must be able to bill past
50,000 emails and be refused a fourth domain. So the plan's grant for a feature
says whether that feature may be exceeded at all, and the tenant's switch only
turns it on where the plan already permits it. A tenant switch alone would
either sell domains nobody priced or hard-stop sends the customer asked to be
billed for.

**2. A batch splits across the line — and this is NOT the partial-acceptance
decision `balance.ts` already refuses.** Five hundred requested with three
hundred included remaining is still accepted **whole**; answering a single
`POST /emails` with "some of these were accepted" remains data loss dressed as
a quota error. What changes is that its units attribute as 300 included and 200
billable. **Acceptance is all-or-nothing; attribution is not.**

**3. ⚠ "The gate is approximate" now costs a different person, and the earlier
argument for tolerating it no longer holds unamended.** When the gate could
only refuse, a permissive gate cost _us_ unbilled revenue and the reconciler
swept it up. With overage enabled the gate never refuses — so a permissive gate
means the **customer pays** for our imprecision.

The tiering is still right, and this is an argument for it rather than against:
the gate decides whether to send, the ledger decides what is owed, and no
invoice is ever computed from the approximate number. But "approximate" now
needs a stated bound rather than a shrug, and it has to be stated **before**
sharding, because sharding is what makes the gate loose.

### Storage: the admin API, not their tables

**Decided 2026-09-05.** Verified against `stalwartlabs/stalwart` v0.16.

`crates/jmap/src/registry/get.rs` exposes **`UsedDiskQuota`** as a property of
the registry's objects, and it is served by two different calls:

- `get_used_quota_account(...)` — one mailbox's usage.
- `get_used_quota_tenant(...)` — **an entire tenant's, aggregated by Stalwart.**

⚠ **SO THE ADMIN API ANSWERS THE QUESTION WE ACTUALLY HAVE**, which is a
per-tenant total, rather than the one we would have had to assemble from parts.
That settles it in favour of the API: reading their tables would mean
re-deriving a number they already compute, against a pre-1.0 schema their
release notes change, from a database our connection cannot even reach.

⚠ **AND IT IS NOT THE PER-ACCOUNT PATH, WHICH WE STRUCTURALLY CANNOT USE.**
Stalwart also reports usage through JMAP `Quota/get` and IMAP `GETQUOTA`
(`crates/jmap/src/quota/get.rs`, `crates/imap/src/op/quota.rs`) — both
authenticated **as the account**. We never hold a user's password; the whole
authd bind-delegation design exists so that we do not. Anything built on those
two would have required us to start.

**Reading their schema stays the documented fallback**, and it becomes the right
answer only if the admin API turns out to miss something or to cost too much to
poll. It is a decision to revisit with a reason, not a preference to act on.

⚠ **THE TENANT CALL IS ENTERPRISE, SO WE SUM ACCOUNTS.** Confirmed 2026-09-05:
`validate_tenant_quota` in `crates/jmap/src/registry/mapping/principal.rs` is
`#[cfg(feature = "enterprise")]` under their SEL licence, and we run the
community image (`stalwartlabs/stalwart:v0.16.19-alpine`).
`get_used_quota_account` is not gated, so the sampler asks per mailbox and
groups by `authd.accounts.tenant_id` — which is what writing that column
bought.

**Built 2026-09-05.** `src/mail/storage.ts` samples on the reconcile job's
cadence and writes `core.tenant_storage`; `storage.bytes` in
`src/metering/levels.ts` reads that. ⚠ **Not read on the request path** — a
mailbox quota check is Stalwart's own business, and ours is for limits and
billing, where a figure minutes old is fine and a synchronous call to another
service is not.

⚠ **BYTES, NOT GIGABYTES, ON BOTH SIDES.** Rounding to GB forces a choice
between a ceiling — one byte past ten gigabytes reads as eleven and refuses —
and a floor, which hands out up to a gigabyte free. Neither is defensible on a
cap, and with both sides exact there is nothing to round.

⚠ **A TENANT WITH ONE UNREADABLE MAILBOX GETS NO WRITE AT ALL.** A partial sum
is a number that looks right and is silently low, which on a cap lets them past
their limit and on billing under-charges — both invisibly. The previous sample
stands instead: stale and honest.

⚠ **AND THAT SERVER IS NOT REACHABLE FROM OUTSIDE THE CLUSTER, BY DESIGN.**
Probed 2026-09-05: `/jmap`, `/.well-known/jmap` and `/api/schema` all answer
**404** on `mail.i10.tech`, because `ingressroute.yaml` routes only autoconfig,
autodiscover and MTA-STS to the pod — and the network policy's own comment says
8080 is omitted "because the management API belongs behind Traefik". `i10-prod`
is an allowed source namespace, so the reconcile job reaches it in-cluster at
`http://i10-stalwart:8080`.

#### The wire shape, verified 2026-09-06

**Probed against the running server on psl-vps**, which is the only place it
can be probed. The guessed version of `src/mail/stalwart.ts` was wrong in four
independent ways, every one of which would have failed every call:

| Guessed                                          | Actual                                                         |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `Account/get`                                    | **`x:Account/get`** — the registry's whole namespace is `x:`   |
| `using: [… "urn:stalwart:params:jmap:registry"]` | **`["urn:ietf:params:jmap:core"]`** and nothing else           |
| `ids: ["user@domain"]`                           | ids are **opaque** (`"b"`); the address is a property          |
| one call per mailbox                             | `x:Account/query` then `x:Account/get` — **two calls per run** |

⚠ **THE SESSION ADVERTISES NO VENDOR CAPABILITY AT ALL** — seventeen
`urn:ietf:…` URIs, authenticated or anonymous, and no Stalwart URI. Since a
conforming server MUST reject a request naming a capability it did not
advertise, `using` carries core alone even though the method is an extension.
`Account/get` under core answers `unknownMethod`; `x:Account/get` returns the
object.

⚠ **AND A JMAP ERROR ARRIVES AS AN HTTP 200.** `unknownMethod` comes back with
`error` in the slot where the method name goes. Checking `response.ok` alone —
which the first version did — reads that as an empty success, and every mailbox
silently becomes zero. The adapter now inspects the method response tag.

⚠ **`x:Account` IS A UNION AND THE `Group` VARIANT HAS NO `usedDiskQuota`
FIELD.** Not null, absent: a group is a delivery target with no store. The
first version's "a missing property is a failure" rule — right for a `User` —
would have aborted a whole tenant's sample over a mailing list. Groups
contribute 0.

⚠ **AND THE SESSION'S OWN `apiUrl` MUST BE IGNORED.** It advertises
`https://mail.i10.tech/jmap/`, the public hostname, which 404s at Traefik. A
conforming JMAP client follows `apiUrl`; ours cannot. `STALWART_URL` stays the
in-cluster service.

`/api/principal`, `/api/settings`, `/metrics` and every other REST path answer
404 — there is no REST management API in v1.0.0, only this registry.
`/api/schema` does exist in-cluster and is 940 KB of UI descriptors, which is
where the `x:` prefix was found.

The fallback, if the `x:` namespace is renamed by a release: `Principal/get`
(advertised, RFC) resolves an address to an id, and `urn:ietf:params:jmap:quota`
is advertised too — but `Quota/get` is scoped to the authenticated account, so
it only helps if an admin session may name another `accountId`. Untested.

⚠ **A BUMP OF THE STALWART IMAGE IS A REASON TO RE-RUN THE PROBE.** A vendor
extension carries no compatibility promise. The adapter throws on anything it
does not recognise and never returns 0, so a rename fails loudly and leaves the
previous figures standing rather than zeroing everybody's usage.

### Human mail: the second feature kind

⚠ **`packages/metering` currently models one kind of feature.** Autumn draws
the line we need and names our exact examples:

> **Consumable**: features that can be used up and replenished... For example,
> credits, API requests.
> **Non-consumable**: features that are used persistently. For example, seats,
> storage, workspaces.
>
> ...reset cycles for `consumable` features, and proration behavior for
> `non-consumable` features.

`emails` is consumable — that is what `windowFor()` and `core.meter_events`
were built for. **Domains, seats and storage are not**, which means three of the
four things we meter are the kind the package does not model, and the one it
does model is the exception. Three things break:

- **There is no reset cycle.** Asking when a seat refills is a category error.
- **"Used" is a level, not a sum** — `count(*)` over `core.domains`, a count of
  `authd.accounts`, bytes from Stalwart — read from elsewhere rather than
  accumulated here.
- **A domain can be removed, and an append-only table cannot go down.** This is
  the one that actually breaks: domains are deleted, mailboxes are deleted,
  folders are emptied.

⚠ **THE LEVEL COUNTS WHAT EXISTS, NOT WHAT IS VERIFIED OR ACTIVE.** An
unverified domain holds a slot and a deactivated mailbox still holds its
storage; counting only the working ones lets a tenant park fifty pending
domains against a limit of three. The row is the thing being limited.

⚠ **WHICH IS A DIFFERENT QUESTION FROM WHAT A DOMAIN MAY DO, AND THE TWO MUST
NOT COLLAPSE.**

|              | predicate                 | why                                    |
| ------------ | ------------------------- | -------------------------------------- |
| **counting** | every row for the tenant  | a pending domain still occupies a slot |
| **acting**   | `verified_at IS NOT NULL` | a claim is not control                 |

`core.mailbox_domains()` (0016) is the acting side: a domain appears there only
once verified, and appearing there is what makes Stalwart treat it as a local
recipient. Get that predicate the wrong way round in either direction and it is
a security bug — unlimited free domains one way, receiving mail for a name you
merely typed the other.

⚠ **AND NOTHING WRITES `core.domains` YET** — the table exists, and no route
creates a row. So the check goes in with the creation path rather than being
retrofitted onto one, which is the only version of this that costs nothing.

#### Sending domains and mailbox domains are two features, not one

`core.domains` already carries `sends` and `hosts_mailboxes` as independent
booleans, and they buy different things: one is an SES identity with DKIM and a
MAIL FROM subdomain, the other is a domain Stalwart accepts mail for. A plan
sells them separately — "3 sending domains, 1 mailbox domain" — so they are two
metered features with two limits.

⚠ **AND A DOMAIN THAT DOES BOTH COUNTS AGAINST BOTH.** The level for each is a
count over its own flag, not a partition of one total. Otherwise the cheapest
way to hold a domain is to claim both roles for it, and the two limits stop
meaning anything.

`draw()` itself generalises unchanged — `{allowance: 5, used: 3, requested: 1}`
answers "can they add a mailbox" as well as it answers "can they send". The
arithmetic was never the consumable part; the storage model was.

What is needed: a `kind` on the feature, a `LevelStore` port beside
`UsageStore`, and **a level-change log** — because proration bills on the
_change_, and a table holding only today's count cannot reconstruct "three
seats added on day 15".

### Domains and seats: unit-based, not Polar's seat model

Polar offers both, and their doc points at seat-based for anything that maps to
a person. **Take unit-based anyway** — and note that domains are not people at
all, so their own guidance puts domains in unit-based regardless.

Seat-based brings Customer → Member → CustomerSeat, invitation emails, claim
tokens and per-member benefit grants. We already run that flow: Clerk owns
identity and `authd.accounts` is the projection Stalwart authenticates against.
Adopting Polar's would make a **third** system that believes it knows who has a
mailbox, and the symptom when they disagree is somebody's mail bouncing.

⚠ **Storage is not seats and must not be modelled as one.** Nobody declares
their gigabytes at checkout; it is observed. Start as an enforced cap that is
never billed, and add metered overage when a customer asks. Prepaid capacity
blocks are the option that makes people buy what they do not use.

### What we use in Polar today

Verified against `apps/api/src/billing/`, 2026-09-05. **Three endpoints and a
webhook receiver:**

|                          |                                |
| ------------------------ | ------------------------------ |
| `POST /v1/checkouts/`    | start a purchase               |
| `GET /v1/checkouts/{id}` | poll one, for the landing page |
| `GET /v1/subscriptions/` | list, for the reconciler       |
| webhook `subscription.*` | grant the plan                 |

⚠ **NO METERS. NO EVENT INGESTION. NO USAGE BILLING OF ANY KIND.** Nothing in
`billing/` mentions a meter or `/v1/events`. Everything above about metered
prices and credits benefits is a thing Polar _can_ do that we have not built —
the ingest research recorded elsewhere was never wired up. Today a plan is a
flat monthly price and the allowance is enforced entirely by us.

⚠ **AND THERE IS NO `PATCH /v1/subscriptions/{id}` ANYWHERE.** We have no
plan-change path at all: a customer who wants to move from $20 to $40 can only
do it on Polar's hosted portal.

### What we will use in Polar

The target surface, against the four-endpoint inventory above. Everything in
**bold** does not exist yet.

|                                        | for                                       |
| -------------------------------------- | ----------------------------------------- |
| `POST /v1/checkouts/` + `embed_origin` | first purchase, in an iframe on our page  |
| `GET /v1/checkouts/{id}`               | the landing page poll                     |
| **`PATCH /v1/subscriptions/{id}`**     | plan change, with per-direction proration |
| **`POST /v1/customer-sessions/`**      | a token for the payment-method embed      |
| **`POST /v1/events/`**                 | usage ingest, one event per billable unit |
| `GET /v1/subscriptions/`               | the reconciler                            |
| webhook `subscription.*`               | granting the plan                         |

Plus three things configured in Polar rather than called: **a meter** per
metered feature, **a metered price** on each paid product, and **a Meter
Credits benefit per plan** — never shared between plans, `rollover` off, for
the reasons traced above.

**Yes, we use their meters.** That is the whole answer to "who computes the
overage": we ingest one event per billable unit, the meter aggregates, the
credits benefit covers the included allowance, and the metered price turns the
remainder into an invoice line. We supply the count and nothing else.

**Yes, we will have prorations** — for money, from `PATCH`, chosen per
direction. The allowance is deliberately never prorated; the credits swap
already produces the right ceiling.

### The customer deals with us, and we deal with Polar

**Built 2026-09-05.** `POST /billing/plan` in the console's API; the service is
`src/billing/plan-change.ts`.

⚠ **THE DIRECTION COMES FROM `core.plans.rank`, NOT FROM A PRICE OR AN
ALLOWANCE.** Whether a change is an upgrade decides how Polar prorates it, so
the answer has to be one somebody chose. Inferring it from the `emails`
allowance breaks the first time a plan is cheaper on volume and dearer on
seats; inferring it from price means storing a price we deliberately do not own.
Free is 0 and Pro is 10 — the gap is so a plan can be inserted between them
without renumbering rows that live subscriptions are compared against.

⚠ **A TIE IS A SIDEWAYS MOVE.** Same rank, different id: nothing is charged and
nothing is deferred, because there is no difference to prorate.

⚠ **THE ROUTE ANSWERS 202, NOT 200.** Polar has accepted the change; the
entitlement moves when their webhook says it did, through the one path in this
repository that can grant a plan. The console polls `GET /billing/plan`, exactly
as it already does after a checkout.

⚠ **AND A DECLINED CARD IS A 402, NOT A 502.** For `invoice`, Polar applies the
change only if the payment succeeds — the subscription is untouched, and the
customer's next step is their bank rather than our support queue.

`POST /billing/payment-method-session` mints the customer session token for the
embedded card form. ⚠ **Server-side, because the alternative is our Polar access
token in a browser.**

**Decided 2026-09-05.** No `billing.i10.tech` handed to Polar; plan changes
happen in our console against our API.

That is not a preference about branding — it is what makes proration exist. As
established above, Polar's `update.py` has no upgrade/downgrade branch, so the
correct behaviour is only reachable by passing `proration_behavior` per call.
An org-wide default cannot be right for both directions, and the portal only
ever uses the default. **So owning the plan-change UI and having correct
proration are the same piece of work.**

What that endpoint gives us, with no card entry anywhere:

- **Upgrade** — `proration_behavior: "invoice"`. Applies now, difference
  charged now, and the credits benefit swap makes the new ceiling exact.
- **Downgrade** — `proration_behavior: "next_period"`. Scheduled to the period
  end, no credit issued, and the customer keeps what they paid for.
- **Cancel** — `cancel_at_period_end`, which the subscription row already
  records and the console already renders.

⚠ **AND THE CUSTOMER NEVER LEAVES, INCLUDING FOR CARD ENTRY.** An earlier draft
of this section said the first purchase and any card change had to stay on
Polar's hosted pages, on the grounds that taking a card number on our own page
moves us from SAQ A to SAQ A-EP. That reasoning is right and does not apply,
because both embeds are **iframes** — `PolarEmbedCheckout.create()` is
documented as "creates the checkout iframe". The fields render on Polar's
origin; card data never touches our DOM or our server, and we stay SAQ A.

- **Embedded Checkout** (`@polar-sh/checkout/embed`) for the first purchase.
  Take the programmatic route — `PolarEmbedCheckout.create()` with `onLoaded`
  and close/success events — rather than the `data-polar-checkout` attribute,
  because the console is a Next.js app and we already create the session
  server-side. ⚠ **Set `embed_origin` on the Checkout Session** or it will not
  open.
- **Embedded Payment Method** (`@polar-sh/checkout/payment-method`) for
  changing a stored card. It needs a **customer session token minted
  server-side** — one hour, scoped to one customer — which is one new endpoint
  on our side and one more reason the Polar access token never reaches a
  browser.

⚠ **THE EMBED HOST ALLOWLIST IS AN OUTAGE WAITING TO HAPPEN.** Embedding only
works from hosts listed under Settings → Preferences → Embedding, matching is
exact, and "a host you leave out stops working straight away". `example.com`
does not match a subdomain and does not match a non-default port; `*.example.com`
does not match the apex. So every preview and staging domain has to be listed
too, and the failure is a checkout that silently refuses to open on a deploy
that changed nothing about billing.

Public hosts must be HTTPS, and the reason is worth keeping: the message the
checkout posts back after payment carries a customer session token.

### Proration

**Money: Polar's arithmetic, but it does need code — we have none of it today.**
An upgrade mid-cycle credits the unused portion of the old plan and charges the
prorated new one, and Polar computes every figure. What is missing is the call
that asks for it.

⚠ **BUT POLAR DOES NOT DISTINGUISH AN UPGRADE FROM A DOWNGRADE.**
`server/polar/subscription/update.py` matches on `proration_behavior` alone —
there is no direction check anywhere in it. So the standard behaviour everyone
expects, immediate upgrades and downgrades deferred to period end, does not
happen by choosing a good default; it exists only if **we** call
`PATCH /v1/subscriptions/{id}` with the behaviour picked per direction. Leaving
customers on Polar's portal means one setting governs both, and one setting
cannot be right for both.

⚠ **AVOID `reset`.** It restarts Polar's billing anchor, and ours is fixed at
tenant creation and deliberately never moves. Using it splits the invoice date
from the allowance refill date permanently.

**Allowance: not prorated, matching Autumn.** A plan change swaps the ceiling
and keeps the usage; the boundary does not move. Autumn does not prorate a
consumable feature either, and their reason is ours: a consumable is billed on
what was used, and the ceiling is a limit rather than something bought by the
day.

⚠ **This is only safe while downgrades are deferred.** With immediate
downgrades a customer can upgrade on day 28, take the higher ceiling, downgrade
on day 30 and be credited — which is why the per-direction call above is not a
nicety.

---

## Multi-tenancy

- ⚠ **Every primitive is keyed by `(tenantId, featureId)`. No global counters,
  ever** — not even for internal stats. A global counter is the shared mutable
  state that later turns out to be unshardable.
- **DO gives tenant isolation for free.** One object per tenant means a
  hammering tenant contends only with itself. This is a real win over a shared
  Redis counter, and it is a property of the addressing scheme rather than
  something we enforce.

### Plans: catalogue vs custom

Enterprise customers needing a bespoke plan is a real case we will hit, so it
is designed now rather than retrofitted.

`plans` rows carry a source discriminator:

- **`source: catalog`** — seeded from the config file. A config push reconciles
  these destructively; the file wins.
- **`source: custom`** — created via the dashboard for one tenant. A config
  push never touches them.

This preserves the position already taken in `infra/autumn/autumn.config.ts`
("the dashboard is not the source of truth — this file is") while letting a
sales deal produce a bespoke plan without a PR.

### The dashboard

- **Plan definitions** → config-as-code. Reviewable, diffable, rollback-able.
- **Plan assignment** (which tenant is on which plan) → Postgres, dashboard
  writes. Nobody wants a PR to move one customer to Pro.
- **Usage observation** → dashboard, read-only.

⚠ **The live "usage right now" widget reads the DO directly, not Postgres.**
The DO is where the decrement happens, so it is fresher than Postgres can ever
be. Postgres serves usage _over time_, which is inherently backward-looking.

---

## Durable Objects

A DO is a class; each instance has an ID we choose, and Cloudflare guarantees
**exactly one live instance per ID, globally**. Single-threaded — requests to
one ID queue and run serially, which is why `balance -= 1` needs no lock, no
CAS, no Lua script. Durable transactional storage is attached, and `alarm()`
schedules a future callback that survives eviction.

⚠ **`alarm()` is the reset job.** It deletes `autumn-cron` outright — no pod,
no schedule, no drift.

> **Superseded 2026-09-05, in the better direction.** Step 3 computes the window
> from a fixed anchor, so there is no reset **event** at all: the balance is a
> pure function of the anchor and the clock, and the window simply moves. The
> cron is still deleted; `alarm()` now only schedules the flush, which is a
> convenience. Nothing can be missed, because nothing has to happen.

**We choose the ID, so the addressing scheme _is_ the sharding design.**

### `meterKey()` from day one

All DO ids come from **one function**, never a string literal:

```
meterKey(tenantId, featureId, shard)   // shard is always 0 to start
```

⚠ With shard in the scheme from day one, changing N from 1 to 16 is config.
Without it, that is a redesign plus a migration of live counters.

The same seam gives us relocation (below), so it buys two things.

### Sharding, when we need it

Splitting one logical counter across N objects: `tenant:feature:0 … N-1`, each
holding `allowance/N`. N objects, N× throughput. Costs: total balance requires
reading N objects (fine at 8–16, needed only for display); uneven drain can
produce a false 429 (fall through to another shard, or rebalance on a
coordinator alarm); exactness at the boundary goes away — **which we already
accepted above**.

Heavier variant for later: a parent object owning the true balance and handing
out **leases** to children. Not now.

### Placement — decided: do 1, build for 2, and 3

An object is created near whoever addressed that ID _first_, then stays there.
A later request from anywhere routes back to it.

⚠ **This is never worse than today** — a Sydney caller currently reaches
Falkenstein, and a Frankfurt-placed object is the same trip. The question is
only whether we capture the win.

**1. Location hints at creation — do this.** Store a **region on the tenant
record now** and pass it as a hint. This is most of the fix, because our
tenants are API customers whose traffic comes from their servers, which sit in
one region and stay there. This is not consumer traffic roaming the globe.

**2. Relocation via the key function — build for this.** An existing object
cannot move, but we can create a new one and cut over. A region or generation
component in `meterKey()` makes that a key change plus a state transfer.

**3. Do not call the DO on most requests — do this.** The deep fix, and it
composes with _the gate is approximate_. The overwhelming majority of requests
are from tenants nowhere near their limit; a cached local balance at the edge
answers those, with the decrement applied asynchronously. Only near the
boundary do we need the authoritative object. This collapses the placement
problem for ~99% of traffic regardless of where the object lives.

**4. Leases** — the heavier version of 3. Not now; same mechanism as the lease
variant of sharding, so building one gets both.

**TODO:** confirm current location-hint and jurisdiction APIs against
Cloudflare's docs. That surface has moved more than the rest of DO, and
jurisdiction pinning may be useful as an **EU data-residency feature**, not
just a latency knob.

---

## Webhooks

Three different things get called "Svix", and the answer differs for each.

⚠ **The window was open exactly once, and it was taken on 2026-09-04.** The old
wire format was pinned by `@i10/next`'s published `verifySignature` — customers
had it installed, so a change meant every webhook we send is rejected by our own
SDK, surfacing as a 401 in the customer's logs that looks like THEIR secret
being wrong. With no users that constraint did not bind. It binds again the
moment someone integrates.

**As built:** `signing.ts` signs `v1,<base64>` over `id.timestamp.body` keyed by
the decoded secret; `deliver.ts` sends the three spec headers; `svix.ts` gave up
its private copies of `decodeSecret` and the signature-list parser and now
shares one implementation with the signer; `@i10/next` mirrors it and treats a
missing id as a 400 rather than a 401.

⚠ **`generateSecret` changed shape too** — `whsec_` + base64 where it used to be
`whsec_` + hex. Secrets minted before the change still decode and sign
consistently, but they are not what the generator produces now. Regenerate any
that exist in a dev database rather than leaving the two forms side by side.

### Take the spec — Standard Webhooks

Verified against the spec, 2026-09-04.

|                | bespoke format                                     | Standard Webhooks                                      |
| -------------- | -------------------------------------------------- | ------------------------------------------------------ |
| headers        | `i10-signature`, `i10-timestamp`, `i10-webhook-id` | `webhook-id`, `webhook-timestamp`, `webhook-signature` |
| signed content | `timestamp.body`                                   | `id.timestamp.body`                                    |
| encoding       | bare hex                                           | base64, `v1,` prefixed                                 |
| key rotation   | **none**                                           | space-delimited multiple signatures                    |
| asymmetric     | none                                               | `v1a`, ed25519                                         |
| secret         | ours                                               | `whsec_` + base64, 24–64 bytes                         |

Three of those are real gains rather than cosmetics:

- **The delivery id becomes signed material.** Today `i10-webhook-id` sits
  outside the signature and is therefore tamperable.
- **Key rotation exists at all.** Sign with the new secret _and_ the old one,
  space-delimited; the receiver tries each until one matches. The bespoke
  format has no rotation story, and "rotate my webhook secret" is a day-one
  customer request.
- **Customers verify with any Standard Webhooks library, in any language.**
  One fewer SDK to write and maintain per language, and `@i10/next` becomes a
  convenience rather than a requirement.

⚠ **Inbound is already compliant.** `apps/api/src/webhooks/svix.ts` reads both
the `svix-` names Clerk sends and the vendor-neutral `webhook-` names. Only
outbound moves — and then there is ONE webhook format in the codebase, used in
both directions, verifiable against shared vectors.

### Do NOT add the `svix` package for inbound

That swaps forty lines of HMAC for a dependency **in the authentication path**.
`svix.ts` already argues this and the argument holds: a forged Clerk event
writes to the mailbox projection. It is the one place where supply-chain
surface costs the most and buys the least, because the algorithm is fixed,
published, and already pinned by tests.

### Do NOT adopt Svix the service, or self-host the server

The server is MIT, so nothing legal stops us. The reasons are otherwise.

- ⚠ **Self-hosting it is Autumn again** — a Rust server with its own Postgres
  and its own Redis, on the 8 GB box this entire document exists to clear.
  Same shape, same trade, same outcome.
- ⚠ **The hosted service puts customer endpoint URLs and secrets in a vendor's
  database.** That is customer-configured state, the most painful category to
  migrate off later. We already own the data model —
  `apps/api/src/webhooks/endpoints.ts` and the routes exist today.
- **It is our core competency, not an adjacent concern.** i10 is an ESP.
  At-least-once delivery to endpoints we do not control, with retries, signing
  and a delivery log, _is_ the product pointed at a different protocol. Resend,
  Postmark and SendGrid all built their own.

**The honest counterweight:** Svix's App Portal — a hosted UI where customers
manage endpoints and replay failed deliveries — is genuine work we would be
skipping. But it is console UI over a data model we already own, and a surface
we would want to own for design consistency.

### Delivery stays ours, on Durable Objects

`apps/api/src/webhooks/deliver.ts` already describes the problem DO solves, in
its own words: _a socket that accepts the connection and then says nothing …
one such endpoint occupies a worker slot until the job lease expires, and a
handful of them stop every other customer's webhooks._

One DO per endpoint makes that structurally impossible — a slow customer blocks
only their own object. The rest maps cleanly:

| today                                                            | on DO                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `DISABLE_AFTER_FAILURES = 20`, a DB column touched every attempt | object state                                                                                             |
| retry backoff via queue rescheduling                             | `alarm()`                                                                                                |
| `DELIVERY_TIMEOUT_MS`, protecting a shared worker pool           | still needed, but protects only that endpoint                                                            |
| delivery id stable across attempts                               | unchanged — and it is what makes DO retries safe, the same property `messageId` gives the metering flush |

⚠ **The test vectors are pinned from both sides.**
`apps/api/test/webhook-signing.test.ts` and `packages/next/test/webhook.test.ts`
pin the same vector, which is what stops the two drifting. The signed-content
change (`timestamp.body` → `id.timestamp.body`) and hex → base64 must land in
both at once.

⚠ **`signing.ts` uses `createCipheriv`/`createDecipheriv`** to keep endpoint
secrets encrypted at rest. HMAC ports to WebCrypto cleanly and AES-GCM is
available, but node's cipher API is not — check the secret handling before that
code runs on Workers.

---

## The rest of the box

Decided in the same pass, recorded so the reasoning is not lost.

- **`web`, `docs`, `console` stay on the box.** ~400 MiB is not the problem and
  moving them is not worth the churn.
- **ARC runners: on GitHub-hosted for now.** Self-hosting returns when there is
  capacity. ⚠ Self-hosted runners on a 4 vCPU box shared with production is the
  worst tenancy decision available — `infra/tofu/stacks/platform/variables.tf`
  already names it: a build can eat the box and take production latency with it.
- **OneUptime: hosted cloud, not self-hosted.**
- **No second Hetzner node yet.** Right answer when there is money — same
  private network, sub-millisecond, ~€13/mo, and `nodes` in
  `infra/tofu/stacks/platform/main.tf` already takes it. Not now.

### Cloudflare — design for it, pay later

⚠ **Cloudflare is a scalability plan, not a memory plan.** It buys CPU, abuse
absorption and headroom. It reclaims almost no RAM.

The principle: **anything that can say "no" without touching Postgres should
say it at the edge.** Everything reaching the box is then authenticated,
well-formed and billable — which is how the box's capacity is spent only on
work that becomes revenue.

**Free tier:**

- DDoS, Bot Fight, WAF custom rules, rate limiting.
- **Key format gate** — `KEY_PATTERN` from `apps/api/src/auth/api-key.ts`.
  ⚠ That file already calls it "a cost gate, not a security control" — and it
  currently runs _after_ a TCP connect, TLS handshake, Traefik routing and a
  Node event-loop turn. It is stateless and belongs at the edge.
- **SNS signature verification** (`apps/api/src/webhooks/sns.ts`) — pure CPU,
  and forged bounces then never reach the box.

**Workers Paid, $5/mo, when there is revenue:**

- **Durable Objects** for the counter, per this document.
- **Per-endpoint webhook delivery** (`apps/api/src/webhooks/deliver.ts`) — one
  DO per endpoint, alarm-driven backoff, perfect isolation. Unbounded latency
  and per-endpoint retry state is the worst possible workload for a
  memory-constrained box.

**TODO:** verify current free-plan WAF and rate-limiting rule counts. Those
tiers move.

---

## Open questions

- [ ] Autumn's real reason for the SQS migration, from their commit history.
- [ ] Current Cloudflare DO location-hint / jurisdiction APIs.
- [ ] Current Cloudflare free-plan WAF and rate-limit rule counts.
- [ ] Polar's period cutoff timing, exactly — the hard-flush deadline depends
      on it.
- [ ] Whether `console` can ever move to Workers, given the authd / LDAP
      bind-delegation boundary.
- [x] ~~What Polar does to a Meter Credits benefit on a mid-cycle product
      change.~~ **Answered 2026-09-05 from their source** — it depends on
      whether the plans share a benefit object. See "The gate must mirror the
      credits". ⚠ Still worth one sandbox confirmation before launch, because
      it was read rather than run.
- [ ] The bound on "approximate" for the gate, now that a permissive gate
      costs the customer rather than us. Needed before sharding.
- [x] ~~Who writes `authd.accounts.tenant_id`.~~ **Answered 2026-09-05** — the
      Clerk projection, from the domain of the address. See 0016.
- [x] ~~Where a per-tenant storage figure comes from.~~ **Answered 2026-09-05
      from their source: the admin API, and it is the better fit.** See
      "Storage" below.
- [ ] The domain limits themselves. Free's sending limit is 3 (0017); pro's
      10 and the 0/1 mailbox split are still the placeholders from 0015.
- [x] ~~There is no way to create a domain, so no limit is enforced anywhere.~~
      **DONE 2026-09-05.** `POST /domains` (Resend-shaped) checks
      `domains.sending` before it creates the SES identity, and answers **403
      `plan_limit_exceeded`** — not 429, because the SDKs back off on a 429 and
      waiting never produces another domain.
      ⚠ Still no console page: the limit is enforced at the API, and the
      dashboard has nothing to call yet.
      ⚠ And `domains.mailbox` still has no writer — this API is Resend's, and
      Resend has no concept of hosting mail, so every domain it creates is
      `sends: true, hosts_mailboxes: false`.
- [ ] Whether seats are counted from `authd.accounts` or from Clerk
      memberships — they can differ, and only one can be the billable number.
      `mailboxes` currently counts `authd.accounts`.
- [ ] An `x:ApiKey` for the reconcile job. `STALWART_API_TOKEN` is sent as a
      bearer token; basic auth with the recovery admin also works but is the
      wrong credential to hand a cron job.
- [ ] The storage and mailbox limits themselves. 0027 seeds 0/0 for free and
      1 mailbox / 10 GiB for pro as placeholders.

## Sequence

1. Finish the current end-to-end pass. **Autumn keeps running.**
2. ~~**Outbound webhooks → Standard Webhooks format.**~~ **DONE 2026-09-04.**
   Ordered first because it was gated by having no users rather than by
   anything technical, and that gate closes on its own.
   ⚠ **The window is now shut.** The format is a contract from here on; the
   next change to it is a breaking one, whether or not anyone has integrated
   yet.
3. ~~`packages/metering` — domain core, ports, Postgres adapter.~~
   **DONE 2026-09-05.** Read Autumn's files for semantics; attributed at copy
   time in `packages/metering/NOTICE`.
   ⚠ **The adapter is `apps/api/src/metering/postgres.ts`, not in the package.**
   The package compiles without Node types so the arithmetic can run unchanged
   in a Durable Object, which is precisely what a Drizzle adapter cannot do; it
   also belongs beside the schema and migration it depends on. The port is in
   the package, the driver is not — which is what "storage behind a port"
   actually buys.
   ⚠ **Two decisions were made building it that are not argued above.** The
   reset anchor belongs to the tenant rather than to the plan, so a plan change
   never moves a boundary or hands out a fresh allowance. And the ledger is its
   own table rather than a read of `core.messages`, because the reconciler
   compares two independently-derived numbers and reading the meter off
   `messages` would have it compare a number against itself.
4. ~~Swap `Metering` to the new implementation behind the existing interface.~~
   **DONE 2026-09-05.** Three seams moved, not one: `Metering` (quota and
   usage), `Entitlements` (plan granting and signup), and the reconciler's
   ledger. Autumn's client is still in the tree and is now imported by nothing.
   ⚠ **`unentitled` maps to `unavailable`, never to `exceeded`.** A tenant with
   no plan is our misconfiguration, and reporting it as "you have used your
   allowance" tells a customer who has sent nothing to go and upgrade — after
   which the mistake is invisible.
   ⚠ **The reconciler's cross-tenant reads were raising, not running.** Every
   policy in `core` reads `app.tenant_id` strictly and only `withTenant()` sets
   it, so `sentUsageStatement` and `activeTenantsStatement` failed on their
   first statement from the job. Migration 0013 gives both a `SECURITY DEFINER`
   snapshot, and the top-up read now runs inside `withTenant`. **`reconcile-ses.ts`
   has the same defect and is untouched** — it queries `core.messages` and
   `core.message_events` directly from the same job.
   ⚠ **There is no longer an unmetered mode.** It used to hinge on
   `AUTUMN_SECRET_KEY` being absent; usage now lives in the database the API
   cannot start without.
   4b. ~~The feature-kind split.~~ **DONE 2026-09-05.** `Entitlement` is a
   discriminated union on `kind`, so a continuous feature cannot carry a reset
   interval — the compiler refuses the shape rather than a validator catching
   it. `draw()` gained `overage`, resolved from the plan's policy AND the
   tenant's switch, both of which must agree. `LevelStore` is a second port
   beside `UsageStore`.
   ⚠ **Level adapters: domains only.** `apps/api/src/metering/levels.ts` counts
   `domains.sending` and `domains.mailbox` over `core.domains`, and **throws by
   name** for any other feature. Answering `0` would be the worst possible
   default — zero held means the whole allowance is free, so a plan granting a
   feature the store cannot count would hand every tenant an unlimited number,
   silently and in the customer's favour. The other two are blocked, and not on
   effort:

   - ~~`mailboxes` cannot be counted.~~ **FIXED 2026-09-05 (0016).** The
     projection now writes `authd.accounts.tenant_id`, derived from the DOMAIN
     of the address rather than from the holder's Clerk organisation — a
     mailbox on acme.com belongs to whoever proved they control acme.com, which
     is also the only derivation that cannot disagree with how Stalwart routes.
     ⚠ **And customer domains now project at all**, which they did not:
     `MAIL_DOMAINS` is i10's own list and a customer domain was in neither it
     nor the projection. `core.mailbox_domains()` supplies the rest.
   - ⚠ **`storage.gb` IS IN A DIFFERENT DATABASE.** Stalwart owns the
     `stalwart` database, not a schema in `i10` — deliberately, because its
     schema is pre-1.0 and moves. Postgres cannot join across databases, so
     this needs either Stalwart's admin API on a sampling job or a decision to
     read tables whose shape their own release notes change.
     ⚠ **And `emails` is seeded `overage: "never"`.** Billed overage needs the
     meter, the metered price, the credits benefit and the ingest, none of which
     exist; a catalogue promising it first would let a customer send past their
     plan with no way to invoice for it.

5. Retire Autumn. **~1.3 GiB back.**
6. Cloudflare free tier: WAF, format gate, SNS verification.
7. When there is revenue: $5 Workers Paid → DO counter, then DO webhooks.
