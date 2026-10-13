# Webhooks on localhost, without a tunnel

**Proposed:** 2026-10-10. **Status:** a proposal, not agreed. Nothing here is
built. Extends `webhooks.md` (#272), and builds on its polling endpoints (#301).

Today the create dialog says "Localhost will not work - use a tunnel while
developing." That is true, and it is the first thing a developer meets. The aim
is one command instead:

```
i10 listen --forward-to http://localhost:3000/api/webhooks
```

---

## What Polar does

Read at source (`polarsource/polar`, Apache 2.0), not run.

- `GET /cli/listen/{org}` is a server-sent event stream. It needs a token with
  `webhooks_read` or `webhooks_write` on the organization.
- While the stream is open, a Redis key `cli:listening:<org>` is refreshed with
  a 30 second TTL (`cli/listener.py`).
- `webhook/eventstream.py` publishes an event to the organization's Redis
  channel **only if that key exists**. With no listener, nothing is published
  and nothing is kept.
- The stream's first message carries a `secret`, which is the organization id
  with its hyphens removed. Each forwarded event is re-signed with it in the
  Standard Webhooks format, and the CLI posts it to the local URL.
- `POST /cli/trigger/{org}` fires a sample event, and answers 409 when no
  listener is connected.

Three properties to note, because we would choose the opposite of each:

1. **Nothing is durable.** Events that happen while the laptop sleeps, or
   during a reconnect, are gone. There is no cursor to resume from.
2. **The signing key is derived from an identifier,** the same for everyone in
   the organization. It proves nothing. That is tolerable for local use, but it
   means the developer's verification code runs against a key unlike the one
   production uses.
3. **It sits beside the webhook engine, not in it.** CLI events never appear in
   delivery history, stats or health.

---

## What we already have

A polling endpoint (`apps/api/src/webhooks/poll.ts`) is most of a listener:

- The cursor is the endpoint's `sequence`, so events come oldest first, in the
  exact order they were recorded, and an older cursor reads them again.
- Rows are written at ingestion and owe no attempt, so nothing is lost while
  nobody is polling.
- Deliveries, history, stats, test events and expunge already work for it.

What it lacks for local development:

- **It is not signed.** The poll is an authenticated HTTPS read, so it never
  needed to be. A developer who wants to exercise their real verification code
  needs a signed request.
- **Health punishes a laptop.** With events waiting, 15 minutes without a poll
  makes the endpoint `failing`: the owner is emailed and every other endpoint
  subscribed to `webhook_endpoint.failing` is sent an event. After the plan's
  stretch (2 days on Free) it is disabled. Closing a laptop for the weekend
  would do all of that.
- **It resumes from the last acknowledgement.** A developer who comes back
  after a week would be handed a week of backlog before anything new.
- **It is a plain poll.** One request a second to feel live means a row lock
  and two writes a second (`for update`, `last_polled_at`, health), per
  developer.

---

## Options

### A. SSE stream, as Polar does

A held connection, events pushed through Redis pub/sub from whichever replica
ingested them to whichever replica holds the stream.

- New moving parts: pub/sub fan-out across API replicas, heartbeats under any
  proxy idle timeout, connections cut by every rollout.
- To be durable it needs a resume point, `Last-Event-ID`, which can only be the
  same `sequence` the poll already uses. At that point SSE is a push wrapper
  around the poll query, and pub/sub is only a wake-up signal.
- Ordering across replicas is not free: two events ingested on two replicas can
  be published out of sequence, so the stream would have to read from Postgres
  anyway.

### B. A CLI on the polling endpoint, with a long poll

The CLI polls with `wait`, and the API holds the request until there is
something after the cursor, or until the wait runs out.

- No new transport, no pub/sub, nothing held between requests. A rollout just
  makes the CLI poll again.
- Durable, ordered and replayable, because the poll is.
- Latency is within a second of ingestion, which is what "live" needs.

---

## Recommendation: B

A CLI over a new endpoint kind, `listener`, that reuses the polling machinery
and differs from `polling` in four ways.

### 1. A listener is ephemeral, not monitored

- **Exempt from health.** `webhook_pollers_overdue` skips it, so it is never
  `failing` or `disabled`, never emails the owner, and never fans out
  `webhook_endpoint.*` events.
- **Paused when idle.** No poll for an hour pauses it quietly (a pause, not a
  health change). A paused endpoint records nothing, so an abandoned listener
  stops writing a row per event. `i10 listen` resumes it.
- **Starts at the head.** A resumed listener begins at the current sequence, so
  the first thing a developer sees is the next event, not the backlog.
  `--from <cursor>` reads from an earlier point; within the idle hour nothing
  was missed, so a laptop that slept through lunch gets everything.
- **Capped per workspace** (say 10). Each enabled endpoint is a row updated on
  every event at ingestion, so listeners are not free.

### 2. The API signs, the CLI forwards

A listener's poll returns each event as a ready-to-send request: the exact body
bytes as a string, and the Standard Webhooks headers, signed by `signing.ts`
with every live key of that endpoint at the moment of the poll.

- **The CLI has no crypto.** Signing has drifted between two copies once
  already (`signing.ts` and `packages/next` now pin one vector from both sides
  to stop it). A third copy in a CLI is a third chance. The CLI posts bytes and
  headers it was given.
- **The developer verifies with a real** `whsec_`**,** the listener's own, shown
  once when the CLI creates it (decision 4 holds: never readable again, rotate
  to replace). Ed25519 endpoints and rotation work exactly as in production.
- **The body is a string, never re-parsed JSON.** Re-serialising would change
  the bytes and break every signature.
- `webhook-id` **is the delivery id,** stable across re-reads, so a receiver
  that deduplicates behaves as it would in production.
- **Signatures expire.** The timestamp is the poll's, and receivers refuse
  anything older than 5 minutes (`SIGNATURE_TOLERANCE_SECONDS`). A CLI that has
  held an event for 4 minutes re-polls from the same cursor for fresh
  signatures rather than forwarding a stale one.

Transformations are not applied to listeners in the first cut; the body is the
standard envelope.

### 3. Order and acknowledgement

- The CLI forwards **one event at a time, in sequence order.** That is stricter
  than an HTTP endpoint, which is ordered only while healthy (decision 1).
- **Any HTTP response acknowledges,** including a 500. The developer's handler
  failing is something they are watching in their terminal, and a stuck queue
  would hide the next event behind it.
- **A refused connection does not.** If nothing is listening on the local port
  yet, the CLI retries every 2 seconds without moving the cursor, so starting
  the dev server second still delivers everything.
- Acknowledging is the existing protocol: the next poll passes the cursor.

### 4. The long poll holds a request, never a connection

`GET /webhook-endpoints/{id}/poll?wait=25`:

- Before waiting, a cheap read of `next_sequence` against the cursor, with no
  lock and no transaction. If there is something, the normal poll runs.
- Otherwise re-check once a second until something arrives or 25 seconds pass,
  then answer with an empty page. Nothing holds a Postgres connection or the
  row lock between checks; holding either for 25 seconds per developer would
  exhaust the pool.
- 25 seconds sits under any proxy idle timeout in front of the API.
- If load ever makes the one-second check matter, a Redis publish per ingested
  endpoint can wake the waiter early. It is a hint only; Postgres stays the
  record. Not needed to start.

### Auth

- **An API key,** from `I10_API_KEY` or `i10 login`, which stores it in the OS
  keychain where one exists and in a `0600` file where not.
- **A domain-restricted key gets a listener restricted to its domains.** The
  CLI's create sets `filter_domains` to the key's domains, and the API refuses
  anything wider. Ingestion already excludes events with no domain from a
  domain-filtered endpoint, so this fails closed. It is also the right answer
  to the data question below: a key for `staging.acme.com` hears staging and
  nothing else.
- **Prerequisite:** the webhook endpoint routes do not check `isRestricted`
  today. A key restricted to one domain can create an unfiltered endpoint, or
  poll one, and read every event for every domain the workspace owns.
  Suppressions, trusted templates and key minting already refuse restricted
  keys. This is a gap whether or not the listener is built.
- **Test keys do not help.** `i10_test_` keys do not separate events from live
  ones, so a listener hears real mail, with real recipient addresses, on a
  developer's laptop. The docs should say so plainly and point at a staging
  domain or a second workspace. Separating test events is a larger question
  and is not part of this.

### The CLI

`@i10/cli` (bin `i10`), runnable as `bunx i10` or `npx i10`:

| command                                 | does                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `i10 login`                             | stores a key                                                                                                              |
| `i10 listen --forward-to <url>`         | creates or resumes this machine's listener, prints the `whsec_` on first creation only, then forwards and logs each event |
| `i10 listen --events email.bounced,...` | narrows the subscription                                                                                                  |
| `i10 listen --from <cursor>`            | reads again from an earlier point                                                                                         |
| `i10 trigger <event type>`              | the existing `POST /webhook-endpoints/{id}/test` against the listener                                                     |

The listener id is kept per workspace and project directory in the user's
config, so each project on a machine has its own listener and its own secret.

### In the console

- **The localhost hint becomes the command.** "Localhost will not work here. To
  receive events on your machine, run `i10 listen --forward-to <url>`", with a
  copy button. Typing a localhost URL shows it inline instead of a bare error.
- **Listeners are not created from the dialog.** The CLI creates them, so the
  kind picker does not offer one.
- **The list shows them apart:** a "Local" badge, the machine name as the
  description, and "Listening now" (polled within the last minute) or "Idle"
  in place of health, which does not apply.
- **The detail page works as for any endpoint:** deliveries, test events,
  delete. Stats and health history are hidden for a listener.

---

## Cost

About a week, most of it the CLI and its release.

| piece                                                                  | estimate |
| ---------------------------------------------------------------------- | -------- |
| Restricted keys on webhook routes (prerequisite)                       | 0.5 day  |
| `listener` kind: migration, create rules, health exemption, idle pause | 1 day    |
| `wait` and `start=latest` on the poll, signed events for listeners     | 1 day    |
| `@i10/cli`: login, listen, trigger, and publishing it to npm           | 2 days   |
| Console: badge, status, the hint                                       | 0.5 day  |
| Docs page: receiving webhooks locally                                  | 0.5 day  |

Contract changes regenerate the document with `bun run openapi`. The enum
value is a Drizzle migration, generated, never written by hand.

What it does not cost: no new service, no pub/sub, no held connections, no
second copy of any event.

---

## Issues it would become

1. **Webhook endpoint routes ignore domain-restricted keys.** Refuse a
   restricted key, or confine it to its domains, on create, update and poll.
   Independent of the rest; worth doing first.
2. `listener` **endpoint kind.** Polling mechanics; exempt from health and
   operational events; paused after an hour idle; starts at the head; capped
   per workspace; `filter_domains` forced for restricted keys.
3. **Long poll.** `wait` up to 25 seconds without holding a connection or lock,
   and `start=latest`.
4. **Signed, ready-to-forward events for listeners.** Raw body string and
   Standard Webhooks headers from `signing.ts`, every live key.
5. `@i10/cli`**.** `login`, `listen`, `trigger`; serial forwarding, retry on
   refused connection, re-poll before a signature goes stale; npm release.
6. **Console: local listeners.** Badge, listening status, the hint with the
   command.
7. **Docs: receiving webhooks locally,** including that events are real.

Later, and only if asked for:

- The CLI reports the local response code and time back, so the attempt log
  shows what the developer's handler answered.
- Transformations applied to listener events.
- An SSE transport over the same cursor, if a browser ever needs a live tail.
- Test events kept apart from live ones, so a test key hears only test mail.
