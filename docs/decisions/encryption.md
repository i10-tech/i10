# Encryption keys

Some secrets must be read back to be used: a webhook signing secret signs every
delivery, and a DKIM private key signs every message. We cannot hash them, so we
encrypt them before they reach a row. Message bodies have their own scheme; see
storage.md.

## The variables

| Variable          | Protects                                                                                                                       | Rotates                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `SEAL_KEYS`       | Webhook signing secrets and SQS keys, DKIM private keys, DNS credentials, SSO connection secrets and PKCE verifiers, SIEM keys | Yes, with the re-seal job            |
| `TOKEN_KEYS`      | Mailbox download links, the DNS OAuth `state` and its PKCE verifier                                                            | Yes, keep the old key for 15 minutes |
| `FEEDBACK_ID_KEY` | The per-workspace token in the Feedback-ID header                                                                              | Never                                |
| `CONTENT_KEYS`    | Message bodies in R2 (storage.md)                                                                                              | Yes, with the re-wrap job            |

`SEAL_KEYS`, `TOKEN_KEYS` and `CONTENT_KEYS` are keyrings: `kid:base64,kid:base64`.
The first key is the current key. Each key is 32 random bytes
(`openssl rand -base64 32`). A kid is up to 32 letters, digits, `_` or `-`.
Use different keys in each variable.

Production does not start without `SEAL_KEYS`, `TOKEN_KEYS` and
`FEEDBACK_ID_KEY`. In development, a missing keyring turns its features off:
the routes answer 501. Nothing falls back to another key.

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

## How to rotate `CONTENT_KEYS`

Each message body has its own key. `CONTENT_KEYS` only wraps those keys, in
`core.message_bodies.body_key`. The bodies in R2 do not change.

1. Put a new key first in `CONTENT_KEYS`. Keep the old key after it.
2. Deploy, and restart everything that reads `CONTENT_KEYS`: the API, the
   worker and the content-store job. CronJobs read it when they next start. A
   changed Doppler value does not reach a running pod by itself.
   New bodies are then wrapped under the new key. Old bodies still open.
3. Run the job, first as a dry run, then with `--apply`:
   `MIGRATE_DATABASE_URL=... CONTENT_KEYS=... bun run --filter @i10/api rewrap-body-keys --apply`.
   It needs the owner role, because it reads every workspace. It does not
   need any R2 settings.
4. Run the dry run again. It must show zero keys under the old kid and no
   failures. With `--apply`, the job scans again at the end and exits 1 if
   any key is still under an old kid or does not open.
5. Remove the old key from `CONTENT_KEYS` and deploy.

The job is safe to stop and run again, and safe to run while the API and the
content-store job run. It only rewrites a key that is still the one it read.
A key that does not open is listed by workspace id and message id and is not
changed. Do not remove its old key until you know why it does not open.

After a leak, the old key still opens body keys in database backups taken
before step 3. Those bodies stay exposed to whoever has both until the
backups expire.

To rotate `TOKEN_KEYS`, put the new key first, deploy, wait 15 minutes, and
remove the old key. Tokens live 15 minutes at most.

## What this protects, and what it does not

- A stolen database, backup or dump does not expose the sealed secrets. The
  keys are not in the database.
- A value moved to another row or workspace by someone who can write to the
  database does not open there.
- Someone who controls the running server can decrypt everything. The server
  must hold the keys to use the secrets. No design changes that.
- Losing a key loses every value sealed under it. Keep a copy of each key
  outside Doppler.

## Wrapped keys

Doppler holds `SEAL_KEYS`, `TOKEN_KEYS`, `CONTENT_KEYS` and `FEEDBACK_ID_KEY`
in wrapped (encrypted) form. The key that unwraps them is `KEY_WRAP_KEYS`. It
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

Do the same for the other three variables. The tool checks the value the way
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
2. Re-wrap the four values in Doppler with the wrap tool.
3. Give the workloads their AWS credentials, and remove `i10-key-wrap`.

Nothing else changes. The format already carries the provider name.
