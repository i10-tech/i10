# Enrollment load harness (`cmd/enrollload`, I10-62)

This document explains how to run the local enrollment load harness against a
scratch PostgreSQL database and Redis instance to measure throughput, per-phase
latency, micro-batcher behavior, and Postgres transaction counts for the I10-62
enrollment pipeline (`enrolld` -> `enrollctl` -> `i10-enroll-redis` +
`enroll_writer` Postgres, plus `acmed` -> `enrollctl` for Apple silicon Macs).

## Build-tag isolation (synthetic roots never ship)

`services/authd/cmd/enrollload` and `services/authd/internal/enroll/apple_ca_loadtest.go`
carry `//go:build enrollload`. Neither file is compiled by `go build ./...`,
`go test ./...`, or `services/authd/Dockerfile`. Production `enrolld`,
`enrollctl`, and `acmed` binaries therefore never include any synthetic Apple
OTA or Enterprise Attestation root override.

## Prerequisites

1. A scratch PostgreSQL 18 instance with all migrations under `apps/api/drizzle/`
   applied and the `enroll_writer` role created before
   `*_enroll_writer_grants_and_triggers` runs (matching `apps/api/scripts/prove-migrations.ts`
   or CI).
2. A scratch Redis 8 instance (no persistence, e.g., `redis-server --save "" --appendonly no --maxmemory 128mb --maxmemory-policy noeviction`).
3. Do NOT point `-postgres` or `-admin-postgres` at production: when
   `-admin-postgres` is set, the harness seeds synthetic `authd.accounts` rows
   under `-user-prefix` (default `user_enrollload_`).

## Running the harness

```bash
cd services/authd

# Example: 1,000 devices (50% iPhone, 50% Mac + full ACME device-attest-01)
# at concurrency 64 against local scratch Postgres + Redis.
go run -tags enrollload ./cmd/enrollload \
  -postgres "$AUTHD_TEST_ENROLL_WRITER_DATABASE_URL" \
  -admin-postgres "$AUTHD_TEST_DATABASE_URL" \
  -redis "$ENROLL_TEST_REDIS_URL" \
  -devices 1000 \
  -concurrency 64 \
  -mac-ratio 0.5 \
  -users 200 \
  -max-batch 200 \
  -max-wait 5ms \
  -user-prefix "user_load_$(date +%s)_"
```

A fresh `-user-prefix` per run keeps runs apart (account emails are unique).
The harness leaves its synthetic accounts and their devices behind. Remove
them before running the API's database tests on the same database (the prune
test counts every expired device):

```bash
psql "$AUTHD_TEST_DATABASE_URL" -c "delete from authd.accounts where clerk_user_id like 'user\_load\_%'"
```

### Flags and environment fallbacks

| Flag              | Default / Env fallback                                             | Description                                                                                        |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `-postgres`       | `ENROLLLOAD_DATABASE_URL`, `AUTHD_TEST_ENROLL_WRITER_DATABASE_URL` | Required `enroll_writer` Postgres DSN (2 pooled connections through PgBouncer or direct).          |
| `-admin-postgres` | `ENROLLLOAD_ADMIN_DATABASE_URL`, `AUTHD_TEST_DATABASE_URL`         | Optional admin DSN used to seed synthetic `authd.accounts` rows and read `pg_stat_statements`.     |
| `-redis`          | `ENROLLLOAD_REDIS_URL`, `ENROLL_TEST_REDIS_URL`                    | Required `redis://host:port` URL.                                                                  |
| `-redis-user`     | `ENROLL_REDIS_USER`                                                | Optional Redis ACL username (if ACLs are enabled on the scratch instance).                         |
| `-redis-password` | `ENROLL_REDIS_PASSWORD`                                            | Optional Redis ACL password.                                                                       |
| `-devices`        | `100`                                                              | Total virtual devices to enroll.                                                                   |
| `-concurrency`    | `16`                                                               | Concurrent virtual device workers.                                                                 |
| `-mac-ratio`      | `0.5`                                                              | Fraction of virtual devices (`0.0..1.0`) executing the Mac + full `acmed` `device-attest-01` flow. |
| `-users`          | `50`                                                               | Number of distinct synthetic accounts seeded when `-admin-postgres` is provided.                   |
| `-user-prefix`    | `user_enrollload_`                                                 | `clerk_user_id` prefix for synthetic accounts.                                                     |
| `-max-batch`      | `200`                                                              | Micro-batcher `MaxBatch` size.                                                                     |
| `-max-wait`       | `5ms`                                                              | Micro-batcher `MaxWait` window.                                                                    |

## What each virtual device exercises

1. **Session creation:** writes `enroll:sess:<eid>` + `enroll:user:<uid>` to
   Redis and mints a signed `v1.` edge link token (identical to `apps/api`).
2. **Phase 1:** `GET /enroll/apple/<token>` through `enrolld` -> `enrollctl`
   (edge HMAC verification + signed Phase 1 `.mobileconfig` returned verbatim).
3. **Phase 2:** `POST /enroll/apple/profile` with CMS `SignedData` signed by
   the synthetic OTA CA -> `enrolld` -> `enrollctl` -> signed Phase 2 SCEP
   `.mobileconfig`.
4. **Simulated SCEP step:** generates an RSA-2048 device key, signs an
   `emailProtection` leaf from the synthetic device intermediate, and runs
   cahookrelay's own two scripts (`SCEPClaim` with the challenge from the
   Phase 2 profile, then `SCEPAuthorize`), so Redis does the work production
   SCEP does.
5. **Phase 4:** `POST /enroll/apple/profile` signed by the SCEP leaf ->
   `enrolld` -> `enrollctl` -> micro-batched `INSERT` into `authd.mail_devices`
   (strict lock order: `authd.accounts FOR SHARE` through
   `authd.enroll_lock_gate_accounts` -> `authd.mail_devices`) ->
   CMS-encrypted + ECDSA-signed Phase 4 profile.
6. **Mac ACME (`device-attest-01`, for `-mac-ratio` of devices):** decrypts the
   sealed Phase 4 profile to extract the 50-char Mac ACME OU permit and the
   Mac's own `DirectoryURL` (`.../acme/apple/d/<path token>/directory`), then
   runs from that URL `directory` -> `new-nonce` -> `new-account` -> `new-order` -> `authz` ->
   `challenge` (CBOR `apple` attestation with P-384 key and
   `SHA-256(challenge.token)` in `OIDAppleNonce`) -> `finalize` -> `cert`
   against `acmed` -> `enrollctl POST /acme/finalize` (micro-batched
   `cert_key_sha256` bind + 1095-day cert issuance).

## Metrics reported

The harness prints:

- Total completed devices (`ios`, `mac`, `errors`), wall time, and aggregate `devices/s`.
- Per-phase latency (`p50`, `p95`, `p99`) for `phase1`, `phase2`, `phase4`, and `mac_acme`.
- Micro-batcher batch counts and batch size distributions (`avg`, `p50`, `p95`, `max`) for `mint` and `bind`.
- Postgres `pg_stat_database` transaction deltas (`xacts_delta` and `xacts/device`) and, when `pg_stat_statements` is installed, total statement calls per device.

## Measured runs

The PR body carries the measured runs (the tech lead runs the load test); add rows here for later runs.

| Date | Hardware / PG / Redis | Devices (`ios` / `mac`) | Concurrency | Throughput (`devices/s`) | Phase 4 p99 | Mac ACME p99 | Avg batch (`mint` / `bind`) | PG xacts/device |
| ---- | --------------------- | ----------------------- | ----------- | ------------------------ | ----------- | ------------ | --------------------------- | --------------- |
