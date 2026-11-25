-- ⚠ A LOCK TIMEOUT FIRST. The upsert takes ROW EXCLUSIVE on
-- `authd.passthrough_versions` and row locks on what it writes, and reads
-- `identity.connections`; five seconds behind an open writer, then fail and
-- retry rather than queue the API's connection writes.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- `authd.passthrough_versions.active` (the migration before last) for EVERY
-- connection, in the shape `mirrorPassthrough` (identity/authd-mirror.ts) writes.
--
-- ⚠ A ROW FOR EVERY CONNECTION, NOT ONLY THE ONES THAT HAVE ONE. A connection
-- the mirror never saw has no row today, which authd reads as version 0 and now
-- as "active unknown". Inserted here with the fingerprint and version 1 the
-- mirror itself would write for a first sight, so the next mirror of the
-- workspace finds nothing moved and raises no epoch. An existing row keeps its
-- version and fingerprint and gains only `active`.
--
-- ⚠ THE SAME EXPRESSIONS AS THE MIRROR, BY POSITION. If one ever differed, the
-- next mirror would see a moved fingerprint and raise the version and the
-- managed accounts' epochs once: a reconnect, never a missed revocation.
--
-- As the owner, which row-level security on `identity` does not bind (no FORCE).
-- One row per SSO connection: a few hundred at most, not a large table.
INSERT INTO "authd"."passthrough_versions" AS pv (connection_id, version, fingerprint, active, updated_at)
SELECT c.id,
       1,
       md5(jsonb_build_array(
         c.status = 'active',
         exists (
           select 1
             from identity.connection_domains cd
             join core.join_domains jd
               on jd.id = cd.join_domain_id and jd.tenant_id = cd.tenant_id
            where cd.connection_id = c.id
              and cd.tenant_id = c.tenant_id
              and jd.verified_at is not null
              and jd.lapsed_at is null
              and jd.displaced_at is null
         ),
         c.provider,
         c.config -> 'ldap',
         c.config -> 'oidcMail',
         md5(c.secrets)
       )::text),
       c.status = 'active',
       now()
  FROM "identity"."connections" c
ON CONFLICT (connection_id) DO UPDATE SET active = excluded.active;
