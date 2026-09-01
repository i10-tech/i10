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
  // The projection lives in its own schema so it never collides with the
  // transactional tables that will land in `public` later.
  schemaFilter: ["authd"],
  strict: true,
  verbose: true,
})
