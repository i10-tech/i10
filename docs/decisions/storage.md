# Message storage and retention

**Decided:** 2026-09-29. **Status:** attachments to R2 (#136, #168) and
retention built on one branch; the content job reworked for #171 (progress
markers, compaction out of the risk run, fingerprints off the send path).
Bodies to R2 (#188) not started.

---

## What lives where

| What                                          | Where                                         | Until                                  |
| --------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| Message row, body, events, webhook deliveries | Postgres, monthly partitions                  | the plan's retention period            |
| Attachment and inline-image bytes             | R2 `i10-content`, `<tenant_id>/sha256/<hash>` | no body names the hash, plus 24h grace |
| Template skeletons (#167, #169)               | `core.content_templates`                      | no body uses it AND unseen 7 days      |
| Tombstone (message id, tenant)                | `core.expired_messages`                       | 90 days after expiry                   |
| Usage                                         | `core.meter_events`                           | never touched by retention             |

## Retention, like Resend

Resend keeps "email and log data" 30 days on every self-serve plan, with no
split between content and metadata. We do the same shape with our own
periods: **Free 3 days, Pro 30 days**, a custom plan sets `plans.retention_days`.

When a message expires, all of it goes in one statement: the row, the body,
its events and its webhook deliveries. A log listing mail whose content is gone
is useless, and keeping recipients and subjects longer than bodies is keeping
personal data for no reason.

- **Per workspace, row deletes.** Plans differ, so a partition DROP cannot
  enforce them. The hourly `i10-retention` job finds due workspaces through
  `core.retention_due` (ids and periods only) and deletes under RLS.
- **Partitions are housekeeping.** The job keeps 12 months of partitions ahead
  (0002 made one year and nothing extended it) and drops expired ones only when
  EMPTY. A non-empty expired partition is reported, never dropped, because it
  means retention is failing for somebody.
- **Billing is untouched.** Usage is counted from `core.meter_events`, a
  separate ledger, so 50 sent today reads 50 used whatever retention has done.
  Every period is clamped to at least `RECONCILE_LOOKBACK_DAYS + 1`, because
  the reconcile compares `core.messages` against the meter over that window.
- **Suppression survives expiry.** A complaint can arrive days after the send.
  Without the message the event used to be dropped; now `ingestEvent` falls
  back to the tombstone and writes the suppression alone (no event row, no
  customer webhook, there is nothing left to attach them to).
- **Unassigned leftovers take the free period.** A deleted tenant's mail, rows a
  flush left behind, bodies with no message row: all expire.

## Attachments: raw first, R2 later (#188's shape)

1. Accept writes files inline, base64, as before. Nothing touches R2 before
   the 202.
2. The worker sends from the row.
3. `i10-content-store` (every 5 minutes) takes finished messages (sent, failed,
   canceled), hashes each file, uploads it once per workspace, and rewrites the
   entry as `{ filename, content_type, size, sha256 }`.
4. A retry of a failed message restores the bytes from R2 in the worker.

**Per workspace, never global.** A shared object would tell one workspace
whether another had sent the same file.

**No reference counts.** The body row is the reference; the object sweep asks
"does any body still name this hash?" (GIN index on `attachments`). Whatever
deletes bodies frees their objects without knowing they exist, so there is no
counter to drift, and partition drops cannot skip a decrement.

**The race with the sweep.** The store touches `content_objects.last_seen_at`
before rewriting the body; the sweep takes a row only under `FOR UPDATE SKIP
LOCKED`, only past a 24h grace, deleting R2 then the row. A touched object is
never taken; one the sweep took first has no row left, so the store uploads it
again.

**Bytes are exact.** No recompression, no cleaning (#188, #189).

## Inline images (#168)

**By Content-ID.** An attachment with `content_id` (Resend's name) is sent in a
`multipart/related` beside the html part, with `Content-ID: <id>` and
`Content-Disposition: inline`, so `<img src="cid:id">` resolves. Without html
it goes out as an ordinary attachment that keeps its Content-ID. It is stored,
moved to R2 and restored like any attachment, `content_id` included.

**Data URIs in html.** The content-store job, before template matching, lifts
each `data:<mime>;base64,` payload of at least 1 KB out of a finished body into
R2 (the same per-workspace objects as attachments) and leaves
`data:<mime>;base64,<U+0003><sha256><U+0003>` in its place. Only canonical
base64 is taken (re-encoding must give the identical string), and a body that
already contains U+0003 is never touched, so restoring is exact. Nothing about
what is sent changes.

- Extraction runs before matching, so a logo inlined in every receipt becomes a
  reference inside the template's skeleton, stored once.
- `message_bodies.inline_objects` lists the hashes a body references however
  it is stored (full, or compacted into a template and values). The object
  sweep counts it beside `attachments`, or it would delete a logo every
  compacted receipt still points at.
- Every reader restores after `restoreBodies`: the worker (a retry), `GET
/emails/:id` and the console detail (both after their transaction, so no R2
  read holds a Postgres connection), and the risk passes. A body with
  references and no configured store fails loudly.

## Templates: store once, forget when unused, come back on use

A template is the static HTML a workspace keeps sending; matching mail stores
only its values. It is deleted when no body (compacted or merely linked)
references it AND it has gone 7 days unseen. If the workspace starts sending
that mail again, the content job derives it anew from the near-duplicates, and
new mail keeps its full body until then, so nothing is lost in between.

## The content job (#171)

`i10-content-store` runs every 5 minutes and does everything to stored mail
after the send, per workspace, each step independent of the others:

| Step         | Runs when               | Progress marker (`message_bodies`) | Finds workspaces through       |
| ------------ | ----------------------- | ---------------------------------- | ------------------------------ |
| Fingerprints | `RISK_ENABLED`          | `fingerprinted_at`                 | `core.content_fingerprint_due` |
| Attachments  | `CONTENT_STORE_*` set   | `attachments_stored_at`            | `core.content_store_due`       |
| Compaction   | always, every workspace | `examined_at`                      | `core.content_compaction_due`  |

The hourly risk run keeps the risk half: trusted-template credit (#222) and
embeddings, on its own marker, `analysed_at`.

**Every pass makes progress.** Compaction used to read the oldest uncompacted
bodies of the last week. Unique mail is never compacted and nothing recorded
that it had been read, so once a workspace had a batch's worth of unique
finished bodies, every run re-read exactly those and never reached newer mail
(reproduced: five unique bodies starved six near-identical receipts for good).
Now every body read is stamped, and the risk half the same way.

**Stamping does not cost the pairing.** A template needs two near-duplicates,
and a stamped body is never read again, so an unmatched body keeps its MinHash
bands in `content_bands` (GIN, partial on unlinked rows). Its twin, arriving in
a later pass, reads only the few bodies that share a band.

**Link, then promote by template.** A match is linked once (template and
values recorded, original kept). When a template reaches 3 matches, every body
linked to it is compacted, found through the linked-body index rather than a
rescan, after rendering the values back and comparing byte for byte. A body
that no longer reconstructs is unlinked, so it cannot block the queue.

**Not a risk feature.** It rode the risk run until #171, so `RISK_ENABLED=false`
stopped compaction, the system tenant (exempt from scoring, sender of the most
templated mail we have) never compacted, and only active workspaces were
visited. The definers return tenant ids for every workspace, whatever its
status.

**Nothing beyond a hash on the send path.** Fingerprints, link hosts and the
farm tripwire moved out of the API into this job, read from stored bodies
(restored first). The tripwire now fires within 5 minutes instead of at accept,
and re-scores through the same risk construction the hourly run uses
(`risk/runtime.ts`). Recording and stamping share one transaction, so a crash
never counts a body twice; migration 0082 marked every existing body as
fingerprinted, since accept had already counted it.

**Approvals credit forward.** An approved template is credited on mail
analysed after the approval; mail analysed while it was pending is not
re-read. The old retroactive week was an accident of the starvation.

## Credentials

R2 tokens scope per bucket, never per prefix, so content has its own buckets
(`i10-content`, `i10-content-dev`) and its own token. The `R2_*` key in
`prod_platform` is the CNPG backups key and must never be reused. Settings:
`CONTENT_STORE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`,
all four or none. Unset, attachments stay inline and the product works as
before.

## Not yet

- Bodies (html/text) to R2 compressed (#188). Measure first: compaction
  already shrinks them.
- An attachment download route for the console.
- Multi-window quotas (daily and monthly) and the usage page to show them.
