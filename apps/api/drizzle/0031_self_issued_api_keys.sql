-- i10 issues its own API keys. Clerk no longer holds them.
--
-- ⚠ THIS IS A LATENCY CHANGE BEFORE IT IS ANYTHING ELSE. Verification was a
-- network call to Clerk on every cache miss, and the cache TTL is 60 seconds —
-- so a customer sending anything less often than once a minute paid it on
-- essentially every request. Measured on the live API 2026-09-08: 1119ms cold
-- against 353ms warm, and an unauthenticated 401 costs 180ms, which is pure
-- network round trip. The ~900ms difference was Clerk, and it was the single
-- largest cost in a send — larger than SES.
--
-- ⚠ AND CLERK WAS NEVER THE THING TYING A KEY TO A TENANT. Its `subject` is a
-- `user_…` or `org_…` and our tenant is neither; auth/api-key.ts read
-- `claims.tenantId` — a claim WE stamped at creation — and ignored `subject`
-- entirely. The link has always been this table's `tenant_id`. Removing Clerk
-- moves nothing; it stops a network round trip from being needed to read a
-- column we already own.
--
-- ⚠ WHAT IT DELETES IS AS IMPORTANT AS WHAT IT ADDS. Clerk publishes no way to
-- change its `ak_` prefix, so every key was rewritten to `i10_live_…` on the
-- way out and back on the way in — and because both our prefixes are nine
-- characters, `i10_live_X` and `i10_test_X` unwrapped to ONE Clerk secret. The
-- mode had to come from Clerk's claims, never from the string, or editing one
-- character promoted a test key to a live one. Self-issued, the whole key
-- INCLUDING its prefix is what gets hashed, so those two are different secrets
-- that hash differently and the hazard cannot be expressed.
--
-- The table is empty, which is why every column below can be NOT NULL and why
-- there is no backfill: no customer has ever been issued a key.

-- ⚠ SHA-256, AND DELIBERATELY NOT bcrypt OR argon2. Slow hashes exist because
-- passwords are low-entropy and guessable. An API key here is 256 bits from a
-- CSPRNG — there is nothing to guess, and a deliberately slow hash would move
-- the very latency this migration exists to remove from the network onto the
-- CPU, on every request. Fast hashing of high-entropy secrets is correct.
--
-- ⚠ UNIQUE, because it is the lookup key. A collision would authenticate one
-- tenant as another, so the database refuses to store one rather than trusting
-- that SHA-256 will not produce it.
ALTER TABLE "core"."api_keys" ADD COLUMN "secret_hash" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD CONSTRAINT "api_keys_secret_hash_unique" UNIQUE ("secret_hash");
--> statement-breakpoint

-- ⚠ THE EXISTING `mode` COLUMN BECOMES AUTHORITATIVE, WITHOUT CHANGING. It
-- carried a comment warning it must never decide behaviour, because the prefix
-- a caller sent could not be trusted — true while both prefixes were nine
-- characters and unwrapped to one shared Clerk secret. It is not true now: mode
-- is read off the row the hash matched, and the hash covers the prefix, so
-- `i10_live_X` and `i10_test_X` are simply different keys.
--
-- Scopes moved here from Clerk's claims for the same reason everything else
-- did. Empty means "no scope restriction", which is what every key carries
-- today — nothing in the request path enforces them yet.
ALTER TABLE "core"."api_keys" ADD COLUMN "scopes" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

-- ⚠ REVOCATION IS OURS NOW, AND THAT IS THE POINT OF HOLDING IT HERE. Clerk had
-- `revoked` and `expired` flags that only its verify() could read, so the
-- fastest possible revocation was bounded by the cache TTL. A leaked production
-- key had to stay live for up to a minute. Setting this column and deleting the
-- cache entry is immediate.
ALTER TABLE "core"."api_keys" ADD COLUMN "revoked_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD COLUMN "expires_at" timestamptz;
--> statement-breakpoint

-- ⚠ CLERK OWNED THIS AND WE ARE TAKING IT BACK, OR IT SIMPLY STOPS EXISTING.
-- `lastUsedAt` was maintained by Clerk's verify() as a side effect of the call
-- we are removing; without a column here, every key would read as never used.
-- See `core.resolve_api_key` for why it is written on a cache miss rather than
-- on every request.
ALTER TABLE "core"."api_keys" ADD COLUMN "last_used_at" timestamptz;
--> statement-breakpoint

-- ⚠ AUDIT ONLY, AND NEVER AUTHORIZATION. Knowing who minted a key matters
-- during an incident. Authorizing against it would be a bug with a schedule: a
-- production sending key is the ORGANISATION's credential, and tying its life
-- to an employee's means offboarding somebody takes production sending down
-- with them. Every authorization decision reads `tenant_id`.
ALTER TABLE "core"."api_keys" ADD COLUMN "created_by" text;
--> statement-breakpoint

-- ⚠ DROPPED RATHER THAN LEFT NULLABLE. It is a foreign system's identifier for
-- a credential that system no longer holds, it is NOT NULL with no value we
-- could supply, and the table is empty so nothing is lost. Keeping it would
-- leave the next reader wondering which of two ids is the real one.
ALTER TABLE "core"."api_keys" DROP CONSTRAINT "api_keys_clerk_key_id_unique";
--> statement-breakpoint
ALTER TABLE "core"."api_keys" DROP COLUMN "clerk_key_id";
--> statement-breakpoint

-- Resolving a presented key, and the ONE thing about it that is not obvious.
--
-- ⚠ SECURITY DEFINER, BECAUSE AUTHENTICATION RUNS BEFORE THERE IS A TENANT.
-- `api_keys` carries `tenant_isolation`, which reads
-- `current_setting('app.tenant_id')` strictly — and only a `withTenant()`
-- transaction sets it. But the whole purpose of this lookup is to DISCOVER the
-- tenant: at the moment it runs, nobody knows who is calling. Issued through an
-- ordinary connection it would not return the wrong row, it would raise
-- `unrecognized configuration parameter` on the first request of every
-- deployment.
--
-- ⚠ VOLATILE, BECAUSE IT WRITES `last_used_at`. Folding the touch into the
-- lookup makes it one round trip instead of two, and it happens only on a cache
-- miss — so the write rate is bounded by the cache TTL per key, not by request
-- volume. A per-request write on the send path would be a far worse trade than
-- the network call this whole change removes.
--
-- ⚠ AND IT STAMPS A REVOKED KEY TOO, DELIBERATELY. The caller refuses the
-- request either way; what this preserves is the evidence that somebody is
-- still presenting a credential that was withdrawn — which is exactly what you
-- want to know after a leak, and exactly what is lost if the stamp is skipped
-- for keys that fail.
--
-- ⚠ IT RETURNS STATE RATHER THAN A VERDICT. `revoked_at` and `expires_at` come
-- back as they are, and the decision is made in TypeScript beside the reason it
-- is refused. A function that returned only matching, live keys would make
-- "revoked" and "never existed" indistinguishable to the caller, and those are
-- different things to log.
CREATE FUNCTION "core"."resolve_api_key"(p_hash text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  scopes text[],
  mode text,
  revoked_at timestamptz,
  expires_at timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  -- ⚠ A DATA-MODIFYING CTE, BECAUSE AN `UPDATE` CANNOT BE A BRANCH OF A UNION.
  -- The write has to be named before it can be read back beside the fallback.
  WITH touched AS (
    UPDATE core.api_keys k
       SET last_used_at = now()
     WHERE k.secret_hash = p_hash
       -- Coarse on purpose: a key in steady use is written once per minute, not
       -- once per request. The column answers "is this key still in use", and
       -- it does not need to be exact to answer that.
       AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '60 seconds')
    RETURNING k.id, k.tenant_id, k.scopes, k.mode, k.revoked_at, k.expires_at
  )
  SELECT * FROM touched
  UNION ALL
  -- ⚠ THE SAME ROW WHEN THE STAMP WAS SKIPPED AS TOO RECENT, AND WITHOUT THIS
  -- THE SECOND REQUEST INSIDE A MINUTE WOULD READ AS A BAD KEY. `NOT EXISTS`
  -- rather than repeating the staleness predicate: the CTE runs exactly once,
  -- so this asks whether the update fired rather than re-deriving why it did
  -- not — one definition of "already stamped" instead of two that can drift.
  SELECT k.id, k.tenant_id, k.scopes, k.mode, k.revoked_at, k.expires_at
    FROM core.api_keys k
   WHERE k.secret_hash = p_hash
     AND NOT EXISTS (SELECT 1 FROM touched)
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."resolve_api_key"(text) TO i10_api;
