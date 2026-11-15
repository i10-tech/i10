# Encryption keys

Some secrets must be read back to be used: a webhook signing secret signs every
delivery, and a DKIM private key signs every message. We cannot hash them, so we
encrypt them before they reach a row. Message bodies have their own scheme; see
storage.md.

## The variables

| Variable             | Protects                                                                                                                       | Rotates                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `SEAL_KEYS`          | Webhook signing secrets and SQS keys, DKIM private keys, DNS credentials, SSO connection secrets and PKCE verifiers, SIEM keys | Yes, with the re-seal job            |
| `TOKEN_KEYS`         | Mailbox download links, the DNS OAuth `state` and its PKCE verifier                                                            | Yes, keep the old key for 15 minutes |
| `FEEDBACK_ID_KEY`    | The per-workspace token in the Feedback-ID header                                                                              | Never                                |
| `CONTENT_KEYS`       | Message bodies in R2 (storage.md)                                                                                              | Yes                                  |
| `WEBHOOK_SECRET_KEY` | Legacy. Opens old `v1` values only. Remove it when the re-seal job reports no `v1` value.                                      | Removed                              |

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
the one it read. The first run after this change also moves every `v1` value
to `v2`; when it shows zero `v1` values, remove `WEBHOOK_SECRET_KEY`.

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
