import { z } from "@hono/zod-openapi"

/**
 * Importing `@hono/zod-openapi` adds `.openapi()` to zod's schemas. Every entry
 * point imports this module FIRST.
 *
 * ⚠ ZOD 4 COPIES PROTOTYPE METHODS ONTO EACH SCHEMA WHEN IT IS BUILT, so a schema
 * made before the extension runs never gets `.openapi()`, even after it runs. The
 * schemas in `@repo/contracts` are built when their module is evaluated, and with
 * `bun build --splitting` that module can land in a shared chunk which evaluates
 * before the entry's own code. #471 made `retention.ts` import the contracts too,
 * contracts moved into such a chunk, and every API pod crash-looped at boot on
 * `errorSchema.openapi is not a function` (2026-11-16). ESM evaluates an entry's
 * first import, and everything under it, before the next, so the extension is in
 * place before any contract exists. test/openapi-first.test.ts keeps the import
 * first.
 */
export const openApiReady = typeof z.string().openapi === "function"
