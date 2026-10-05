# Webhooks: Svix parity, and past it

**Decided:** 2026-10-05, after reading the Svix server at source and running it
in a local lab. **Status:** scope and all six decisions agreed; being built
issue by issue. Tracking issue: #272.

This reaffirms the call in `metering.md` (2026-09-04, "Do NOT adopt Svix the
service, or self-host the server"), now with evidence rather than reasoning
alone, and replaces "match Svix" as a vague aim with a list.

---

## The bar

i10 sends email. Telling a customer what happened to that email, reliably and
safely, is the product pointed at a different protocol. So the bar is not "good
enough webhooks": it is **every feature and every security property Svix has,
in the open-source server and in the hosted product, plus the things the lab
showed Svix gets wrong.**

A hosted consumer UI (Svix's App Portal) is not part of this comparison. We
build all of our own UI, and the webhooks screens are ordinary console work.

---

## What was done

1. Cloned `svix/svix-webhooks` (server v1.101.0, about 20,700 lines of Rust,
   MIT) and read the server: `worker.rs`, `core/webhook_http_client.rs`,
   `core/message_app.rs`, `queue/redis.rs`, the endpoint, message, attempt,
   recovery and auth handlers, the config, the migrations and the cleaner.
2. Compared its API against the 76 paths its own SDKs call on the hosted
   product. **50 of them have no route in the open-source server.**
3. Ran it locally (`svix/svix-server:v1.101.0`, Postgres 17, Redis with AOF)
   behind a recording receiver, and scripted tests for delivery, signing,
   filtering, retries, ordering, fairness, SSRF, rotation, throttling, recovery,
   idempotency, payload limits and durability. The lab lives outside the repo.

---

## What Svix gets right (and we must match)

| Area              | Svix                                                                                                                                                                                                                                                                             | i10 today                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| SSRF              | Resolves the hostname, drops every non-public address, connects only to what is left. Held against every probe in the lab: four loopback spellings, `[::1]`, IPv4-mapped v6, `169.254.169.254`, `10/8`, CGNAT, Docker service names, and a public name resolving to `127.0.0.1`. | String checks only. `endpoints.ts` documents that a hostname resolving to a private address passes. **A live hole.** |
| Rotation          | Old key stays valid for a grace period (24h default, 0 to 7 days); every message carries one signature per valid key. Verified in the lab.                                                                                                                                       | New secret replaces the old one instantly; every receiver fails verification until it deploys.                       |
| Signature schemes | HMAC `v1` and Ed25519 `v1a`.                                                                                                                                                                                                                                                     | HMAC only.                                                                                                           |
| Retries           | `[5s, 5m, 30m, 2h, 5h, 10h, 10h]`: 8 attempts over about 27.6 hours, 20% jitter, a quick retry on fast connection errors, 60s floor after a timeout.                                                                                                                             | 5 attempts, exponential capped at 8 minutes, about 15 minutes total.                                                 |
| Disabling         | After 5 days with no success at all.                                                                                                                                                                                                                                             | After 20 exhausted deliveries in a row, which a busy workspace reaches during one bad half hour.                     |
| History           | One row per attempt: status, response body (20KB), duration, trigger.                                                                                                                                                                                                            | Last status and last error only.                                                                                     |
| Operations        | Resend one, recover all failed since T (14 days, 10k cap), send example, stats, per-endpoint headers, channels, event-type registry, idempotency keys, expunge payload, notifications about endpoint health.                                                                     | None of these.                                                                                                       |

## What the lab showed Svix gets wrong (and we must not)

| Test                 | Result                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Throttle             | `rateLimit: 2` is stored and returned, never read by the worker. 40 events arrived in 30ms.                                                                                                                                                             |
| 429 handling         | `worker.rs` wraps a 429 as a generic error, so the 429 penalty never matches. Retries came 3 to 4.5s apart. `Retry-After` is clamped to 2x the scheduled delay.                                                                                         |
| Noisy neighbour      | 3,000 events to one hanging endpoint filled all 500 worker slots. Another tenant's single event took **116.8s**.                                                                                                                                        |
| Ordering             | Retries interleave: event 0's second attempt landed after event 3's.                                                                                                                                                                                    |
| Redis data loss      | Scheduled retries are gone for good, and the API keeps advertising a `nextAttempt` in the past. The worker then loops on `NOGROUP` (about 4,000 errors a minute) and delivers nothing, while `/health` reports the queue `ok`. Only a restart recovers. |
| Redis down at create | API answers 500 after the row is committed. The caller retries with the same `eventId`, gets 409, and **the event is never delivered.**                                                                                                                 |
| Schemas              | Event-type JSON schemas are stored, never checked on send.                                                                                                                                                                                              |
| Headers              | A custom endpoint header named `webhook-signature` replaced the real signature.                                                                                                                                                                         |
| Recovery             | Runs as an untracked task; its status URL 404s; a restart mid-run loses it.                                                                                                                                                                             |
| Retention            | Payloads expire, but message and attempt rows stay until someone runs `prune`, which refuses any cutoff newer than 3 months. No partitioning. Deleting an app only flags it.                                                                            |

## Why we build it rather than run it

Svix is ahead of us on breadth. The failures above are all in the parts that are
expensive to retrofit: fairness, durability and ordering, which live in its queue
and worker. Fixing them means owning a Rust fork. Our module already has the
right foundation for exactly those parts: Postgres is the record (a row per
event and endpoint, written before anything is queued), and the queue groups by
endpoint and orders by when the event happened. What we lack is breadth, and the
server is MIT, so its IP classifier, rotation logic and retry arithmetic can be
ported with attribution.

`metering.md`'s other reasons still hold: a second Postgres and Redis on the
box, and customer endpoint state in a system we do not control.

---

## Where we stand, honestly

The lab's tests have not been run against our engine yet, and some will fail.
Known before running them:

- **Fairness is not solved for us either.** `WEBHOOK_CONCURRENCY` defaults to 8
  per replica. Grouping by endpoint stops one endpoint from blocking itself
  twice, but eight hanging endpoints, from one workspace or several, take every
  slot for 10 seconds per attempt.
- **Ordering and a long retry window collide.** groupmq's `retry.lua` says it
  plainly: delayed jobs block their group. With a 15-minute budget that is
  tolerable. With Svix's 27 hours, one failing event would hold every later
  event for that endpoint for a day. Decision 1 below resolves it.
- **Nothing sweeps pending deliveries.** `events.ts` logs "deliveries left
  pending" when the enqueue fails after commit, and `db.ts` notes nothing sweeps
  them. Postgres keeps the record, but nothing acts on it.
- **The SSRF hole and the rotation gap** above.

---

## The target

Grouped the way the issues are. Items marked **past Svix** are things Svix does
not do, or does wrong.

### Security

- Connect-time SSRF: resolve, refuse if any address is non-public, pin the
  connection to the vetted address. Port Svix's classifier (v4, v6, mapped v6,
  CGNAT, reserved, benchmarking, 6to4, NAT64, SRv6) and keep our create-time
  checks so a customer hears "refused" at registration, not at the first event.
- Rotation where **the customer decides what happens to the old secret** (decision 7):
  revoke it immediately, or keep it working for a period they choose, at most
  72 hours. Every live key signs; at most 3 are live at once.
- Ed25519 `v1a` as an option per endpoint.
- **Past Svix:** signing and transport headers are reserved; a custom header can
  never override `webhook-id`, `webhook-timestamp`, `webhook-signature`,
  `content-type`, `host` or `user-agent`.
- **Past Svix:** https only stays the rule (Svix allows http by default).
- Optional fixed egress IPs, published, so customers can allowlist us.

### Delivery

- A retry window set by plan (decision 5): shorter on Free, longer on paid
  plans. Svix's principles, not its numbers: exponential with 20% jitter, and
  one immediate retry on a fast connection failure.
- **Past Svix:** `Retry-After` honoured up to a cap, and a real penalty after a
  429 or a timeout.
- Time-based disabling (no success for a plan-set number of days), plus
  immediate disabling on a permanent signal such as `410 Gone`.
- **Past Svix:** per-endpoint throttle that is enforced, and a fair share per
  workspace so no workspace can take more than its slice of delivery capacity.
- Ordered while healthy (decision 1).

### Durability

- **Past Svix:** Postgres is the only record of what is owed. A sweep finds rows
  that are due and not queued and re-queues them, so losing Redis delays
  delivery and never loses it.
- **Past Svix:** creating the delivery rows and queuing them cannot come apart
  (the sweep covers the gap; no 500-after-commit).
- **Past Svix:** health checks that prove the consumer is consuming, not just
  that Redis answers.

### Data

- A per-attempt table: status, response code, response body (capped), headers
  we sent, duration, trigger (scheduled, manual, recover, replay).
- Partitioned by time, retained by plan, removed with the workspace (and listed
  in the flush and retention code, which already missed partitions once).
- Expunge a payload on request.

### API (headless, the "headless" half of #182)

- Endpoints: create, get, update (url, events, description, headers, throttle,
  enabled), delete, pause and resume, rotate, stats.
- Deliveries and attempts: list and filter, per message and per endpoint.
- Resend one; recover everything failed since T; bulk replay by filter;
  replay-missing (deliveries an endpoint never got, for example because it was
  created after the event); all three run as background tasks with a status
  URL that survives a restart.
- Send a test event of any type.
- Filters beyond event type: Svix's "channels" map to things we already have,
  such as sending domain and message tags.

### Event catalog

- Every event type has a versioned JSON schema, published in the OpenAPI
  document and the docs.
- **Past Svix:** contract tests prove every payload we emit validates against
  its schema. (Svix stores schemas and never checks them.)

### Operational notifications

- Tell the workspace when an endpoint starts failing, is disabled, or recovers:
  in the console, by email, and optionally as a webhook to a separate endpoint.

Built in #284 (`apps/api/src/webhooks/health.ts`):

- **State, not counts.** Each endpoint has `health`: `healthy`, `failing`,
  `disabled`. Every transition is a guarded update that matches only the row
  still in the old state, and the change row is written in the same
  transaction, so each change is reported once however many workers fail
  deliveries at the same moment.
- **Failing means 15 minutes with no success at all.** Long enough to ride out
  a receiver's deploy, and always shorter than the shortest retry window
  (free's, about 1h45m), so the owner hears before any event is given up on.
  That is why exhausted deliveries are not a separate trigger.
- **Disabled is reported at once,** without a failing first for a 410.
  **Recovered** is the first success after failing or disabled. A customer's
  own pause is not a health change; resuming an endpoint we disabled makes it
  `failing`, so its next success is the recovery they hear about.
- **Operational webhooks are event types,** `webhook_endpoint.failing`,
  `.disabled` and `.recovered`, so they get signing, retries, history and
  replay for free. An endpoint is never sent events about itself, and mail
  filters do not apply to them.
- **One email per workspace per batch,** to the owner, through our system
  sender. At most one every 30 minutes, except that a disable goes at once.
  A failure that recovered before the owner was told is not sent.
- **Fan-out and email happen after the commit,** from the change row as an
  outbox: fanning out inside the transaction locks other endpoints' rows and
  deadlocks when two endpoints change together.

### Hosted-only Svix features worth having

- **Polling endpoints:** the customer pulls events with a cursor instead of
  exposing a URL. Built in #301:
  - The cursor is the per-endpoint `sequence`, so there is no second queue.
  - Passing a cursor back acknowledges everything up to it, which marks those
    deliveries `delivered`. An older cursor reads them again, which is the
    replay.
  - Rows owe no attempt (`next_attempt_at` null), so neither the worker nor
    the sweep ever touches them.
  - Health applies: a poller with events waiting and no poll for 15 minutes is
    failing, and after the plan's stretch it is disabled.
- **Destinations:** deliver to SQS, Pub/Sub, Kafka or similar, not only HTTP.
- **Transformations:** a customer-supplied function that reshapes the payload
  per endpoint. The template renderer's sandbox is the precedent. Built in
  #302:
  - The function runs in that same sandbox (`/transform`), never in the
    worker, which holds the key to every signing secret. It gets an isolate
    per function, no network, 50ms of CPU, and no imports.
  - Nothing it returns is believed. The method must be POST, PUT or PATCH; the
    path and query may change but the origin may not; custom headers follow
    the reserved-name rule; the body is capped.
  - It is signed after transforming. The result is fixed on the delivery at
    the first attempt, so retries send the same bytes, and expunging the
    payload empties it too.
  - A failing function is a failed attempt (`transform`). Our sandbox being
    down is a deferral, never charged to the customer.
- Attempt stats and usage stats per endpoint and per event type. Built in
  #300:
  - Deliveries are counted by when they were created, attempts by when they
    were made.
  - The error rate is failed attempts over attempts, not failed deliveries.

### Console

All of the above, as console screens. Our UI, our design.

---

## Decisions

Agreed 2026-10-05. Numbered as they were proposed; 7 was added when the
rotation design was reviewed.

1. **Ordering: ordered while healthy.** Strict FIFO per endpoint until the head
   event has been failing for a set time (start at 5 minutes; the conformance
   lab tunes it). Then the head moves to a side retry track and the events
   behind it proceed. Every payload carries `occurred_at` and a per-endpoint
   `sequence`, so a receiver can always reorder. Rejected: strict FIFO (an
   endpoint stops for the whole retry window) and Svix's behaviour (no order at
   all once anything retries).
2. **Engine: on the box now.** groupmq, with Postgres as the record, behind a
   delivery-engine interface that the Durable Objects version in `metering.md`
   can implement later. Nothing here waits on Workers Paid.
3. **Generic inside.** The model is event, subscription, delivery and attempt,
   with no assumption that events come from SES, so non-mail events (domain
   verified, limits reached) fit. No customer-sent events product now; #182
   keeps that question.
4. **Secrets are shown once.** Never readable again through the API or the
   console. Rotation is how a customer gets a new one.
5. **Retry windows and disabling by plan.** We keep Svix's principles, not its
   numbers. The window never outlasts the plan's data retention.

   | plan       | schedule after the first attempt                        | window       | disabled after no success for |
   | ---------- | ------------------------------------------------------- | ------------ | ----------------------------- |
   | free       | 5s, 1m, 10m, 30m, 1h                                    | about 1h45m  | 2 days                        |
   | pro        | 5s, 5m, 30m, 2h, 5h, 10h, 10h                           | about 28h    | 5 days                        |
   | scale      | pro's, then 12h, 12h, 12h                               | about 3 days | 5 days                        |
   | enterprise | scale's by default, extendable by contract up to 7 days | up to 7 days | 7 days                        |

6. **Order of work.** Security (SSRF, rotation, reserved headers) and the
   conformance lab first, then ordering, retries, fairness and durability,
   then the attempt log, API, replay, catalog, notifications and console, then
   the hosted-only features.
7. **Rotation: the customer chooses, we cap it.** A stolen secret that keeps
   working is not a risk we take on silently for anyone. So rotation has no
   default for the old secret. The API requires one of two answers, and the
   console asks the same question:
   - **revoke now:** the old secret stops signing at once;
   - **keep it for a period they choose**, from 1 minute up to **72 hours**.
     Seventy-two hours covers a rotation started on a Friday and deployed on a
     Monday. Past that, an old secret is a liability rather than a
     convenience.

   A running grace period can be ended early at any time ("revoke old secrets
   now"). Every live key signs, so receivers using either one verify.

---

## Issues

| #    | Issue                                                                           |
| ---- | ------------------------------------------------------------------------------- |
| #273 | Conformance lab: the Svix tests, run against our engine                         |
| #274 | SSRF: resolve at delivery time and pin the vetted address                       |
| #275 | Signing: customer-chosen rotation, Ed25519, reserved headers                    |
| #276 | Retries: windows by plan, Retry-After, penalties, time-based disabling          |
| #277 | Ordering: ordered while healthy (decision 1)                                    |
| #278 | Fairness: per-workspace share, circuit breaker, enforced throttle               |
| #279 | Durability: Postgres sweep, no 500 after commit, health that proves consumption |
| #280 | Attempt log: one row per attempt, partitioned, retained by plan                 |
| #281 | API parity: update, pause, stats, test events, headers, filters                 |
| #282 | Replay: resend, recover, bulk replay, replay missing, durable background tasks  |
| #283 | Event catalog: versioned schemas, and tests that every payload matches          |
| #284 | Health notifications: failing, disabled, recovered                              |
| #285 | Past the OSS server: polling, destinations, transformations, stats, fixed IPs   |
| #286 | Console: endpoint detail, attempts, replay, catalog                             |
