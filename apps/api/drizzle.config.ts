import { defineConfig } from "drizzle-kit"

/**
 * Drizzle owns the DDL for the `authd` schema.
 *
 * ⚠ MIGRATIONS ARE GENERATED, NEVER `drizzle-kit push`. Push diffs the live
 * database and applies the difference, which on a shared production schema is a
 * command that can drop a column because a branch has not been merged yet.
 * Generate the SQL, read it, commit it, and let the deploy apply it.
 *
 * ⚠ AND A HAND-WRITTEN MIGRATION MUST STILL LEAVE A SNAPSHOT BEHIND, OR
 * `generate` BREAKS FOR EVERYONE AFTER IT. `drizzle-kit` diffs the schema
 * against the LATEST FILE IN `drizzle/meta`, not against the journal — so a
 * migration added by hand, with only a journal entry, leaves that baseline
 * frozen. The next `generate` re-derives every change made since as pending,
 * and the moment one of them looks like a rename it asks an interactive
 * question, which fails outright in a non-TTY.
 *
 * That is exactly what happened: 0030-0033 were written by hand against a
 * baseline stuck at 0029, and by 0034 `generate` was unusable — it tried to
 * re-apply 0031's `api_keys` work and prompted about `clerk_key_id`. Repaired
 * 2026-09-16 by regenerating a full baseline into an empty directory (nothing
 * to rename against, so it runs clean) and installing it as
 * `meta/0034_snapshot.json`, chained onto 0029's id.
 *
 * ⚠ 0030-0033 HAVE NO SNAPSHOTS AND DELIBERATELY NEVER WILL. Only the latest is
 * read, so reconstructing four historical states would be invented precision.
 * The chain runs 0029 -> 0034; the gap is a scar, not a fault.
 *
 * So: prefer `bun run db:generate`. If a migration genuinely has to be
 * hand-written — a `SECURITY DEFINER` function, an RLS policy, a data backfill,
 * none of which Drizzle models — add the journal entry AND regenerate the
 * baseline snapshot, then confirm `db:generate` answers "No schema changes".
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  // Two schemas, two audiences. `authd` is the Clerk read model, queried by
  // services/authd over LDAP; `core` is the transactional product. Nothing
  // lands in `public`, so an unqualified table name is always a mistake.
  schemaFilter: ["authd", "core"],
  strict: true,
  verbose: true,
})
