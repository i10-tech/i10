# Message storage and retention

**Decided:** 2026-09-29. **Status:** attachments to R2 (#136, #168) and
retention built on one branch; the content job reworked for #171 (progress
markers, compaction out of the risk run, fingerprints off the send path).
Bodies to R2 in sealed packs (#188) built; the design is agreed in
i10-tech/i10#188.

---

## What lives where

| What                                        | Where                                         | Until                                  |
| ------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| Message row, events, webhook deliveries     | Postgres, monthly partitions                  | the plan's retention period            |
| Body, until packed; compacted bodies always | Postgres, `message_bodies`                    | the plan's retention period            |
| Full body, once packed (#188)               | R2 `i10-content`, `<tenant_id>/packs/<id>`    | no body points into the pack, plus 24h |
| Attachment and inline-image bytes, sealed   | R2 `i10-content`, `<tenant_id>/sha256/<hash>` | no body names the hash, plus 24h grace |
| Mailbox export archive, sealed              | R2 `i10-content`, `<tenant_id>/exports/<job>` | 7 days after the export finished       |
| Mailbox import upload, plain                | R2 `i10-content`, `<tenant_id>/imports/<job>` | the import ends (see below)            |
| Template skeletons (#167, #169)             | `core.content_templates`                      | no body uses it AND unseen 7 days      |
| Tombstone (message id, tenant)              | `core.expired_messages`                       | 90 days after expiry                   |
| Usage                                       | `core.meter_events`                           | never touched by retention             |

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
   canceled), hashes each file, seals it, uploads it once per workspace, and
   rewrites the entry as `{ filename, content_type, size, sha256 }`.
4. A retry of a failed message restores the bytes from R2 in the worker.

**Sealed, one key per file** (`content/objects.ts`). Each file is encrypted
with its own random AES-256-GCM key. That key is wrapped by a master key from
`OBJECT_KEYS` and kept on the file's row (`content_objects.sealed_key`). The
workspace and the hash are bound in as associated data, so an object or a key
copied to another workspace or hash does not open. The object in R2 has the
type `application/octet-stream`. The real type is in the attachment entry
(`content_type`) or in the data URI, and readers take it from there.

- The object name is still the SHA-256 of the plain file. Dedup needs that.
  It also means that someone who can list the bucket can test whether a
  workspace stored a file they already have. They cannot read any file.
- Without `OBJECT_KEYS`, nothing moves: attachments and data-URI images stay
  in Postgres, and the job logs a warning each run. A stored file with no key,
  a kid that is not in the ring, or bytes that do not open, fails the read
  loudly. Nothing is ever stored in R2 in plain form.
- To rotate `OBJECT_KEYS`, run the `rewrap-keys` job (encryption.md). It
  changes only `sealed_key`, never R2.

**Dedup with keys.** The second upload of a file reuses the object and its
key: no second upload, no second key. The row and the upload are one
transaction. Two first uploads of the same file at the same time: the second
insert waits for the first transaction. If the first commits, the object is in
R2 and the second reuses it. If the first fails, it rolls back, and the second
inserts its own row and uploads under its own key. So every row that can be
seen names the key of the object in R2.

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
again, sealed under a new key.

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
  references and no configured store or no `OBJECT_KEYS` fails loudly.

## Mailbox export and import (#385)

**Exports are sealed as they stream** (`mailboxes/sealed-stream.ts`). The
worker writes tar, then gzip, then the seal, as one stream into a multipart
upload. Each archive has its own random key, wrapped under `OBJECT_KEYS` and
kept on the job row (`mailbox_jobs.sealed_key`; `object_key` is the R2 path).
The archive is cut into 64 KiB chunks, and each chunk is sealed with
AES-256-GCM. The nonce of each chunk holds its number and says whether it is
the last one. So a chunk that is moved, dropped or repeated does not open, and
an archive that is cut short fails at its end. Memory stays at one chunk.

**The download opens it on the way out.** The route reads the object from R2
as a stream, opens it chunk by chunk, and sends the plain `.tar.gz` with the
same file name as before. `Content-Length` is the archive's own length. It is
computed from the object's size, so it is correct before a byte is sent. The
route does not support range requests, before or now: a broken download
starts again. A cut or changed object ends the response with an error, so the
client never saves a shorter archive.

Without `OBJECT_KEYS`, export answers 501 and a worker fails an export job
instead of writing a plain archive. A failed export leaves no object: the
multipart upload is never completed, and its parts are R2's to expire. A
finished export is deleted by the archive sweep after 7 days (with the limits
below).

**Imports are plain until the job ends.** The customer uploads the archive
straight to R2 with a presigned PUT, so we cannot seal it before it lands. It
is deleted:

- when the import finishes, and when it fails (the worker deletes it in both
  paths);
- when the uploaded file is over the size limit at start;
- by the archive sweep, a day after the job last changed, for an upload that
  was never started.

The archive sweep (`sweepMailboxArchives`) runs only when a mailbox job of the
same workspace starts. A workspace that never runs another job keeps an
abandoned upload, and an expired export, until it does. An upload whose job
row is gone (the workspace was deleted) is never swept. A job that dies
without reaching its error path (the pod is killed) stays `running`, and its
upload stays until the next job in that workspace sweeps it.

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

## Bodies to R2 (#188)

**Compacted bodies stay in Postgres; full bodies go to R2 in packs.** A
compacted body is a template plus a few hundred bytes of values, and an R2
write each would cost more than it saves. What is still a full body - unique
mail, and linked mail whose template never established within a day (unlinked
first) - is packed.

**Packs, because R2 bills per write.** Every five minutes, per workspace, the
content job takes bodies that are finished, examined by compaction, at least an
hour old (the window a twin has to pair into a template), and, with risk on,
already fingerprinted and analysed (or a day old). It ships them only when it
is worth the write: `CONTENT_PACK_TARGET_BYTES` waiting (4 MiB), or the oldest
has waited `CONTENT_PACK_MAX_WAIT_HOURS` past its hour (6). Up to 16 MiB of
bodies per pack and 4 packs per workspace per run; a backlog drains over runs.

**R2 is never the only copy until it has proved it holds the bytes.**

1. The pack row is written first (so a pack that uploads and never commits is
   found and swept).
2. The pack is uploaded, then read back whole and compared byte for byte.
3. Only then, in one transaction, each body's `html` and `text` are cleared
   and its row points at `(pack_id, pack_offset, pack_length)`, guarded on the
   body still being exactly what was sealed.

An R2 that fails, times out or returns anything else leaves every body in
Postgres, and the next run tries again. Sending never waits on R2: the worker
sends from the row before anything is packed.

**Sealed, one key per body** (`content/seal.ts`). Each body is compressed
(zstd) then encrypted with its own AES-256-GCM key; that key is wrapped by a
master key from `CONTENT_KEYS` and kept on the row (`body_key`). The workspace
and the message are bound in as associated data, so a record cannot open as
another message.

- **Deleting one email is deleting its key** (crypto-shredding). Retention
  deletes the row and the key together, so the body is unreadable at once; the
  pack goes when no row points into it (`sweepPacks`, same grace as objects).
- `CONTENT_KEYS` is `kid:base64,...`, current first. To rotate, put a new key
  first, deploy, and run the `rewrap-body-keys` job. It wraps every body key
  again under the new key, so the old key can go the same day. The steps are
  in encryption.md. The job changes only `body_key`. It never reads or writes
  R2: a record is encrypted with its body key, and that key does not change.
- ⚠ Losing the master keys loses every packed body. Keep a copy outside
  Doppler. A deleted body key survives in Postgres backups until they rotate.
- ⚠ A re-wrap does not reach backups. After a leak, a database backup taken
  before the re-wrap still holds body keys wrapped under the leaked key, until
  that backup expires. Whoever has that backup and the leaked key can open
  those bodies.

**Reading stays one lookup.** Lists read metadata only. Opening an email is one
Postgres read and, for a packed body, one ranged GET of just that body's bytes,
then decrypt and decompress. The API keeps opened bodies in memory
(`CONTENT_BODY_CACHE_MB`, 64; never Redis, which would be a second place
holding plaintext mail). Every reader restores through `restoreContent` after
`restoreBodies`: the worker (a retry), `GET /emails/:id`, the console detail,
and the risk passes. While R2 is down, packed bodies cannot be opened (the
cache still serves recent ones); sending is unaffected.

**Byte-exact.** Sealing opens what it sealed before returning, the pack is
compared after the round trip, and the release is guarded on md5 of the exact
stored text.

## Credentials

R2 tokens scope per bucket, never per prefix, so content has its own buckets
(`i10-content`, `i10-content-dev`) and its own token. The `R2_*` key in
`prod_platform` is the CNPG backups key and must never be reused. Settings:
`CONTENT_STORE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`,
all four or none. Unset, attachments stay inline and the product works as
before. Bodies also need `CONTENT_KEYS`, and files and exports need
`OBJECT_KEYS` (both in `prod_api` and `dev`). Without them, bodies and files
stay in Postgres and export is off. That is allowed in development only: with
`NODE_ENV=production` and the content store set, a missing `CONTENT_KEYS` or
`OBJECT_KEYS` fails `loadEnv()`, so the check-env hook stops the deploy. The
other keys (`SEAL_KEYS`, `TOKEN_KEYS`, `FEEDBACK_ID_KEY`) are in encryption.md.

**Objects stored before sealing.** There are none in production. A development
database that has rows in `core.content_objects` cannot apply the migration
that adds `sealed_key` (the column is required). Delete those rows first. The
objects they named were plain and are not read any more; the bodies that name
them can no longer restore those files.

**What this does not protect.** Someone who controls the running API or worker
holds the keys and can read everything. Sealing protects the bucket, its
backups and its listings.

## Not yet

- Per-tenant zstd dictionaries for packed bodies. Measure first.
- An erasure API for one message and a no-body-retention mode (#184): both are
  a matter of deleting `body_key`.
- An attachment download route for the console.
- Multi-window quotas (daily and monthly) and the usage page to show them.
