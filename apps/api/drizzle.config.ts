import { defineConfig } from "drizzle-kit"

/**
 * Drizzle owns the DDL for the `authd` schema.
 *
 * ⚠ MIGRATIONS ARE GENERATED, NEVER `drizzle-kit push`. Push diffs the live
 * database and applies the difference, which on a shared production schema is a
 * command that can drop a column because a branch has not been merged yet.
 * Generate the SQL, read it, commit it, and let the deploy apply it.
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
