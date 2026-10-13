/**
 * Loaded before every test file (see bunfig.toml's `[test] preload`).
 *
 * ⚠ THE OPENAPI EXTENSION HAS TO BE IN PLACE BEFORE ANY ZOD SCHEMA EXISTS.
 * `@hono/zod-openapi` adds `.openapi()` to Zod, but Zod 4 gives a schema its
 * methods when it is CREATED - so a schema from `@repo/contracts` that was
 * built before the extension loaded never has `.openapi()`, even afterwards.
 * Bun runs every test file in one process with one module registry, so the
 * first file to import `@repo/contracts` decides it for all of them: a file
 * that reached the contracts directly (a console route, say) before any file
 * loaded the app made `routes/shared.ts` throw `errorSchema.openapi is not a
 * function` for every later file. Which file runs first differs between
 * machines, which is why it failed in CI and not locally (2026-10-13).
 */
import "@hono/zod-openapi"
