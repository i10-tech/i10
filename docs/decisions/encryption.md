# Encryption keys

Some secrets must be read back to be used: a webhook signing secret signs every
delivery, and a DKIM private key signs every message. We cannot hash them, so we
encrypt them before they reach a row. Message bodies, stored files and mailbox
exports have their own scheme (envelope encryption, below); see storage.md.

## The variables

| Variable          | Protects                                                                                                                       | Rotates                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `SEAL_KEYS`       | Webhook signing secrets and SQS keys, DKIM private keys, DNS credentials, SSO connection secrets and PKCE verifiers, SIEM keys | Yes, with the re-seal job            |
| `TOKEN_KEYS`      | Mailbox download links, the DNS OAuth `state` and its PKCE verifier                                                            | Yes, keep the old key for 15 minutes |
| `FEEDBACK_ID_KEY` | The per-workspace token in the Feedback-ID header                                                                              | Never                                |
| `CONTENT_KEYS`    | Message bodies in R2 (storage.md)                                                                                              | Yes, with the re-wrap job            |
| `OBJECT_KEYS`     | Attachments, data-URI images and mailbox export archives in R2 (storage.md)                                                    | Yes, with the re-wrap job            |

`SEAL_KEYS`, `TOKEN_KEYS`, `CONTENT_KEYS` and `OBJECT_KEYS` are keyrings: `kid:base64,kid:base64`.
The first key is the current key. Each key is 32 random bytes
(`openssl rand -base64 32`). A kid is up to 32 letters, digits, `_` or `-`.
Use different keys in each variable.

Production does not start without `SEAL_KEYS`, `TOKEN_KEYS` and
`FEEDBACK_ID_KEY`, and with the content store set, not without `CONTENT_KEYS`
and `OBJECT_KEYS`. In development, a missing keyring turns its features off:
the routes answer 501, and bodies and files stay in Postgres. Nothing falls
back to another key, and nothing is stored in plain form instead.

`FEEDBACK_ID_KEY` is never rotated. A new key gives every workspace a new
token, and Google Postmaster Tools then loses the history of the old ones. It
only maps a workspace id to a token, so it is low sensitivity.

## The sealed format

```
v2.<kid>.<iv>.<tag>.<ciphertext>      base64url parts, AES-256-GCM, 12 byte IV
```

- The AES key is per workspace: HKDF-SHA256 over the master key `kid` names,
  with info `i10/seal/v2/workspace-key/<tenant id>` and an empty salt.
- The associated data is `i10/seal/v2/<purpose>/<tenant id>/<row id>`. A value
  copied to another row, column or workspace does not open.
- `purpose` names the column. The list is `SEALED_COLUMNS` in
  `apps/api/src/crypto/sealer.ts`. To seal a new column, add it there. The list
  also says which column is the row id. For `core.dns_connections` it is the
  provider (the row is upserted by tenant and provider), and for
  `identity.siem_exports` it is the tenant id (one row per workspace).
- New rows that are sealed at insert get their id from the application, so the
  value can be bound to it before the row exists.

Token keys use HKDF-SHA256 too, one subkey per use (`i10/token/v1/<use>`). A
token for one use does not verify for another.

## Envelope encryption

Message bodies, stored files and export archives each have a random 32 byte
data key of their own. The content is sealed with the data key, and only the
data key is sealed with a master key (`apps/api/src/crypto/envelope.ts`).

```
wrapped key   kid-length(1) | kid | nonce(12) | AES-256-GCM(data key) | tag(16)    base64, on the row
body, file    nonce(12) | AES-256-GCM(content) | tag(16)
```

| Content        | Master key     | Wrapped key in                    | Associated data (key and content) |
| -------------- | -------------- | --------------------------------- | --------------------------------- |
| Message body   | `CONTENT_KEYS` | `core.message_bodies.body_key`    | `i10/body/v1/<tenant>/<message>`  |
| Stored file    | `OBJECT_KEYS`  | `core.content_objects.sealed_key` | `i10/object/v1/<tenant>/<sha256>` |
| Export archive | `OBJECT_KEYS`  | `core.mailbox_jobs.sealed_key`    | `i10/export/v1/<tenant>/<job>`    |

The body is zstd-compressed before it is sealed. `<sha256>` is the hash of the
plain file. An export archive is too large to seal in one piece, so it is a
stream of chunks (`apps/api/src/mailboxes/sealed-stream.ts`):

```
header   "i10x" | version(1) = 1 | nonce prefix(7, random per archive)
chunk    AES-256-GCM(64 KiB of the archive) | tag(16)    the last chunk is shorter, maybe empty
nonce    prefix(7) | chunk number (uint32, big-endian) | 1 on the last chunk, else 0
```

Every chunk uses the associated data in the table. A chunk that is moved,
dropped or repeated does not open. An archive cut short has no chunk sealed as
the last one, so it fails at its end.

An object without a key, a kid that is not in the ring, and bytes that do not
open all fail loudly. The errors name the kid or the row, never a key.

## How to rotate `SEAL_KEYS`

1. Put a new key first in `SEAL_KEYS`. Keep the old key after it.
2. Deploy. New values are sealed under the new key. Old values still open.
3. Run the job, first as a dry run, then with `--apply`:
   `MIGRATE_DATABASE_URL=... SEAL_KEYS=... bun run --filter @i10/api reseal-secrets --apply`.
   It needs the owner role, because it reads every workspace.
4. Run the dry run again. It must show zero values under the old kid and no
   failures.
5. Remove the old key from `SEAL_KEYS` and deploy.

The job is safe to stop and run again. It only rewrites a value that is still
the one it read.

## How to rotate `CONTENT_KEYS` and `OBJECT_KEYS`

`CONTENT_KEYS` only wraps the body keys, in `core.message_bodies.body_key`.
`OBJECT_KEYS` only wraps the file and export keys, in
`core.content_objects.sealed_key` and `core.mailbox_jobs.sealed_key`. What is
in R2 does not change.

1. Put a new key first in the variable. Keep the old key after it.
2. Deploy, and restart everything that reads it: the API, the worker and the
   content-store job. CronJobs read it when they next start. A changed Doppler
   value does not reach a running pod by itself. New content is then wrapped
   under the new key. Old content still opens.
3. Run the job, first as a dry run, then with `--apply`:
   `MIGRATE_DATABASE_URL=... CONTENT_KEYS=... OBJECT_KEYS=... bun run --filter @i10/api rewrap-keys --apply`.
   It re-wraps the tables of every keyring you give it, and says which ones
   it skipped. `rewrap-body-keys` is the same command under its old name. It
   needs the owner role, because it reads every workspace. It does not need
   any R2 settings.
4. Run the dry run again. It must show zero keys under the old kid and no
   failures. With `--apply`, the job scans again at the end and exits 1 if
   any key is still under an old kid or does not open.
5. Remove the old key from the variable and deploy.

The job is safe to stop and run again, and safe to run while the API, the
worker and the content-store job run. It only rewrites a key that is still the
one it read. A key that does not open is listed by its row's ids and is not
changed. Do not remove its old key until you know why it does not open.

An export that is still running wraps its key when it finishes, with the keys
its worker holds. Rotate `OBJECT_KEYS` when no export is running, or run the
job again after the running ones finish.

After a leak, the old key still opens the keys in database backups taken
before step 3. That content stays exposed to whoever has both until the
backups expire.

To rotate `TOKEN_KEYS`, put the new key first, deploy, wait 15 minutes, and
remove the old key. Tokens live 15 minutes at most.

## What this protects, and what it does not

- A stolen database, backup or dump does not expose the sealed secrets. The
  keys are not in the database.
- A copy of the R2 bucket opens nothing without the database and the master
  keys. But a stored file's name is the SHA-256 of the plain file, so someone
  with the bucket listing can test whether a workspace stored a file they
  already have. A mailbox import is plain in R2 from the upload until the
  import ends and deletes it, or the hourly archive sweep does. An upload that
  is never started stays for a day after its job last changed (storage.md).
- A value moved to another row or workspace by someone who can write to the
  database does not open there.
- Someone who controls the running server can decrypt everything. The server
  must hold the keys to use the secrets. No design changes that.
- Losing a key loses every value sealed under it. Keep a copy of each key
  outside Doppler.

## Database backups

The Postgres backups in R2 (base backups and WAL, bucket `i10-backups`) are
encrypted with SSE-C: we send a key with every request, R2 encrypts the object
with it, and R2 does not keep the key. Without the key, R2 refuses to return
the object.

- The key is `R2_BACKUPS_SSE_KEY` in Doppler `prod_platform`: 32 random bytes,
  base64 (`openssl rand -base64 32`). Doppler syncs it into the `r2-backups`
  Secret, and `sseCustomerKey` in
  `infra/k8s/i10/platform-db/objectstore.yaml` points at it.
- It needs the Barman Cloud plugin v0.16.0 or later. The plugin is installed
  from the PSL repo.
- Encrypted backups are under `s3://i10-backups/cnpg-sse`. The older path
  `cnpg` held the plain backups. It was deleted on 2026-11-16, so the first
  restore point is the backup of that day. The plugin only prunes the path it
  writes to: after a path change, delete the old path by hand.
- Losing the key loses every backup. Keep a copy outside Doppler.
- The backup is a full copy of the database. The secrets and the wrapped data
  keys inside it are still sealed (above), but everything else in it is plain
  once the backup is opened.

What this protects: someone who gets the R2 token, or a copy of the bucket,
cannot read a backup. What it does not: someone with both the token and the
key, which is anyone who can read Secrets in `i10-prod` or the Doppler config.

### How to rotate the backup key

The key cannot change in place. Objects written under the old key stop
opening.

1. Put the new key in Doppler under a new name, and add that name to the
   `r2-backups` DopplerSecret.
2. In `objectstore.yaml`, point `sseCustomerKey` at the new name and change
   `destinationPath` to a new path.
3. Deploy, restart the database pod, and take a base backup at once
   (`kubectl cnpg backup i10-platform --method plugin --plugin-name barman-cloud.cloudnative-pg.io`).
4. Run a restore test from the new path.
5. Keep the old key for as long as the old path is needed, then delete the old
   path and the old key.

## Redis

Redis holds the send and webhook queues. It is not encrypted, on disk or on the
wire, and it only listens inside the cluster. What protects it is a password:

- `REDIS_PASSWORD` in Doppler `prod_api`. `REDIS_URL` in the same config refers
  to it, so the API, the worker and the CronJobs send it. The Redis pod gets it
  through the `i10-redis-auth` Secret and starts with `requirepass`.
- Pods outside `i10-prod` cannot reach Redis at all. Pods inside it can reach
  the port, and the password is what stops them.
- To change the password: set a new `REDIS_PASSWORD` in Doppler, then restart
  the Redis pod and every client (API, worker). The queues stop for that
  minute. Jobs are not lost: the message sweep enqueues them again.

## Wrapped keys

Doppler holds `SEAL_KEYS`, `TOKEN_KEYS`, `CONTENT_KEYS`, `OBJECT_KEYS` and
`FEEDBACK_ID_KEY` in wrapped (encrypted) form. The key that unwraps them is `KEY_WRAP_KEYS`. It
lives in the Kubernetes Secret `i10-key-wrap`, which is made by hand and is
in neither Doppler nor git. Each process unwraps once, at start
(`unlockEnv` in `apps/api/src/crypto/unlock.ts`). Nothing is unwrapped per
message.

What this protects:

- A leaked Doppler config alone opens nothing. It holds only wrapped values.

What it does not protect:

- Someone who can read Secrets in the `i10-prod` namespace has both halves.
  The cluster holds `i10-key-wrap` and also `i10-api`, the synced copy of the
  wrapped values. Wrapping only helps when the leak is on the Doppler side.
- Doppler keeps a history of old values. A key that was once stored there in
  plain form stays in that history. Rotate each key once after it is first
  wrapped. `FEEDBACK_ID_KEY` is never rotated, so its old plain value stays.
- Someone who controls the running server reads the plain keys from memory.

### The format

```
wrap1.<provider>.<kid>.<iv>.<tag>.<ciphertext>      base64url parts
```

- The only provider today is `local`: AES-256-GCM with a 12 byte random IV,
  under the `KEY_WRAP_KEYS` key that `kid` names.
- The plaintext is the variable's whole plain value.
- The associated data is `i10/wrap/v1/<VARIABLE NAME>`. A wrapped `SEAL_KEYS`
  pasted into `TOKEN_KEYS` does not unwrap.
- `KEY_WRAP_KEYS` is a keyring in the same format as `SEAL_KEYS`. Wrapping
  uses the first key. Unwrapping accepts any key in the ring.
- A variable that does not start with `wrap1.` is used as it is.

### How to wrap a value

The tool reads the plain value from stdin and prints only the wrapped value.
Pipe Doppler into Doppler, so that no key reaches the terminal. Run this from
`apps/api`. Use the Doppler config that holds the variable (`prod_api` here):

```sh
export KEY_WRAP_KEYS="$(kubectl -n i10-prod get secret i10-key-wrap \
  -o jsonpath='{.data.KEY_WRAP_KEYS}' | base64 -d)"
name=SEAL_KEYS
wrapped="$(doppler secrets get "$name" --plain -p i10 -c prod_api \
  | bun run --silent wrap-keys "$name")" \
  && printf '%s' "$wrapped" | doppler secrets set "$name" -p i10 -c prod_api >/dev/null
unset KEY_WRAP_KEYS
```

The `&&` matters. When the tool fails, it prints nothing, and an empty pipe
into `doppler secrets set` would erase the key in Doppler.

Do the same for the other four variables. The tool checks the value the way
the server does, wraps it, and unwraps it again before it prints. It refuses
an unknown variable name, empty input and input that is already wrapped.
Restart the workloads after each Doppler change (Doppler does not restart
them).

### How to rotate `KEY_WRAP_KEYS`

1. Put a new key first in the `i10-key-wrap` Secret. Keep the old key after it.
2. Restart the workloads. They still unwrap the old values.
3. Re-wrap each variable under the new key. Use the commands above, with
   `wrap-keys "$name" --rewrap`. The tool accepts a value wrapped under any
   key in the ring, and wraps it under the first.
4. Restart the workloads, and check that the PreSync `check-env` hook passes.
5. Remove the old key from the Secret, update the paper copy, and restart.

### Break-glass

If the unwrap key is lost, or (later) KMS is down, paste the plain keyring
from the paper copy into Doppler. A plain value always works. In production
each process then logs one warning, `KEYS NOT WRAPPED`, with the variable
names. When the unwrap key is back, wrap the values again.

### Switching to AWS KMS at launch

The providers sit behind one small interface (`WrapProvider` in
`apps/api/src/crypto/unlock.ts`). The switch is:

1. Add a `kms` provider next to `local`, and make it the provider new values
   are wrapped with.
2. Re-wrap the five values in Doppler with the wrap tool.
3. Give the workloads their AWS credentials, and remove `i10-key-wrap`.

Nothing else changes. The format already carries the provider name.

## Not encrypted, on purpose

Decided 2026-11-16. Both are open again the day there is a second server.

**The server's disks.** The root disk and the data volume on `psl-vps` are
plain. That covers the Postgres, Redis and Stalwart volumes and the k3s data
folder, which holds every Kubernetes Secret, the unwrap key included. Someone
with a copy of a disk, or with access to the hosting account, reads all of it.

- Why not: with one server, an encrypted disk needs a person to type a
  passphrase after every reboot, and until then everything is down. Nothing
  else exists that could hand the key over automatically.
- k3s secrets encryption is off too. Its key would sit on the same disk as the
  Secrets, so alone it protects almost nothing.
- What still holds: the backups in R2 are encrypted, and the secrets and data
  keys inside the database are sealed. But the keys that open them are on the
  same disk.

**Connections from the applications to the database pooler.** They do not use
TLS. The pooler's own connection to Postgres does (TLS 1.3).

- Why not: there is one node, so this traffic never leaves the machine. Only
  someone who already controls the server could read it, and they can read the
  database anyway. Network policy limits who can reach the pooler at all (the
  API group, PowerDNS and Stalwart).
- With a second node this traffic crosses a real network. Turn TLS on then, in
  the five clients: API, worker, PowerDNS, Stalwart and authd.
