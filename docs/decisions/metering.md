# Metering, and getting off Autumn

**Decided:** 2026-09-04. **Status:** step 2 shipped; everything else is still
only decided.

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

## Sequence

1. Finish the current end-to-end pass. **Autumn keeps running.**
2. ~~**Outbound webhooks → Standard Webhooks format.**~~ **DONE 2026-09-04.**
   Ordered first because it was gated by having no users rather than by
   anything technical, and that gate closes on its own.
   ⚠ **The window is now shut.** The format is a contract from here on; the
   next change to it is a breaking one, whether or not anyone has integrated
   yet.
3. `packages/metering` — domain core, ports, Postgres adapter. Read Autumn's
   files for semantics; attribute at copy time.
4. Swap `Metering` to the new implementation behind the existing interface.
5. Retire Autumn. **~1.3 GiB back.**
6. Cloudflare free tier: WAF, format gate, SNS verification.
7. When there is revenue: $5 Workers Paid → DO counter, then DO webhooks.
