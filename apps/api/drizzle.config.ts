import { defineConfig } from "drizzle-kit"

/**
 * Drizzle owns the DDL for the `authd`, `core` and `identity` schemas.
 *
 * ⚠ MIGRATIONS ARE GENERATED, NEVER `drizzle-kit push`. Push diffs the live
 * database and applies the difference, which on a shared production schema is a
 * command that can drop a column because a branch has not been merged yet.
 * Generate the SQL, read it, commit it, and let the deploy apply it.
 *
 * ⚠ A HAND-WRITTEN MIGRATION STILL GOES THROUGH `generate --custom`, AND MUST
 * LEAVE `generate` CLEAN. `--custom` writes the folder and a snapshot that
 * repeats the previous state; only the SQL is yours. Use it for what Drizzle
 * does not model - a `SECURITY DEFINER` function, an RLS grant, a data
 * backfill. Anything `schema.ts` does model (a column, an index, a policy)
 * goes in `schema.ts` and through a plain `generate`; SQL that changes it
 * behind `schema.ts`'s back makes the next `generate` propose the difference
 * again. After either kind, `bun run db:generate` must answer "No schema
 * changes".
 *
 * Each migration is a folder, `<UTC timestamp>_<name>/`, holding `migration.sql`
 * and `snapshot.json`. The migrator runs them in name order and records the
 * folder name, so a rename after a deploy re-applies it.
 *
 * ⚠ TWO MIGRATIONS IN THE SAME SECOND SORT BY NAME, NOT BY AGE. Folders made by
 * `generate` cannot collide that way, but a hand-named one can: the SAML and
 * Google directory migrations shared a second, and "google" sorts before "saml".
 * `20261107112231_0141_saml_connections_due` carries its old number for that
 * reason. Name a migration so the order you mean is the order of the names.
 *
 * ⚠ 25 OF THE FOLDERS HAVE NO `snapshot.json`, AND NEVER WILL. They were written
 * by hand before v1, while the snapshot chain only advanced at `generate`, and
 * inventing a historical state for them would be false precision. `generate`
 * diffs against the latest snapshot, so a folder without one is skipped, not
 * a break. Its `migration.sql` still runs like any other.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  // Three schemas. `authd` is the Clerk read model, queried by services/authd
  // over LDAP; `core` is the transactional product; `identity` is SSO (#337),
  // behind the same tenant boundary as `core`. Nothing lands in `public`, so
  // an unqualified table name is always a mistake.
  schemaFilter: ["authd", "core", "identity"],
  verbose: true,
})
