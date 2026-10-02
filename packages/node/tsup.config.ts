import { defineConfig } from "tsup"

// ZERO RUNTIME DEPENDENCIES is the point, not an accident.
//
// The SDK ships into other people's applications. Every dependency it carries
// is a version conflict it can cause and a CVE it can inherit, and the one
// thing a migration pitch cannot survive is `@i10/node` breaking a customer's
// build. It uses global fetch and nothing else.
//
// `@repo/contracts` is a TYPE-ONLY import and is bundled into the .d.ts by dts
// resolution - it never appears at runtime, and it must never become a real
// dependency, because it is a private workspace package that would not resolve
// for anyone outside this repo.
//
// ⚠ NO `clean` UNDER `--watch`. tsup's clean deletes dist/ - index.d.ts
// included - before the first rebuild, and `turbo run dev` starts this watcher
// beside its consumers: @i10/next's DTS step then resolves `@i10/node` against
// an empty folder and dies with TS7016, and the console's dev server loses the
// module mid-reload. A watch rebuild overwrites every file in place, so there
// is nothing stale for clean to remove; `bun run build` still cleans.
export default defineConfig((options) => ({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: { resolve: ["@repo/contracts"] },
  clean: !options.watch,
  sourcemap: true,
  treeshake: true,
  target: "node20",
}))
